const express = require('express');
const axios = require('axios');
const { AgentExecutor } = require('./lib/execution/agentExecutor');
const { HumanMessage, SystemMessage, ToolMessage, AIMessage } = require('@langchain/core/messages');
const { createOpenRouterLLM, fetchTotalRunCost } = require('./lib/llm/openRouterService');
const { createSelfConfigTools } = require('./lib/tools/selfConfigTools');
const { getOnboardingPrompt } = require('./lib/tools/onboardingPrompt');
const { createOrchestrationTools } = require('./lib/tools/agentOrchestrationTools');
const { SUPPORTED_APPS } = require('./lib/tools/supportedApps');

const app = express();
app.use(express.json({ limit: '10mb' }));

const AGENT_ID = process.env.AGENT_ID;
const USER_ID = process.env.USER_ID;
const BACKEND_GATEWAY_URL = process.env.BACKEND_GATEWAY_URL || 'https://addons-staging-v2.questera.ai';
const POD_TOKEN = process.env.POD_TOKEN;
const PORT = process.env.PORT || 8080;

console.log(`[Container] Starting container for Agent ID: ${AGENT_ID}`);
console.log(`[Container] Backend Gateway: ${BACKEND_GATEWAY_URL}`);

// CACHE STRATEGY CHANGE:
// - OLD: Cache by apps only → same tools for "send email" and "search emails"
// - NEW: Cache by apps + useCase hash → different tools for different requests
// - TTL: 5 minutes (tools can change as conversation evolves)
const toolsCacheMap = new Map(); // key: "GMAIL|SLACK|abc123" → { tools, expiresAt }
const TOOLS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let mcpToolsCache = null;
let mcpToolsCacheTime = null;
const MCP_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let gatewaySignature = null;
let signatureExpiry = null;

// Apps catalog — fetched from backend on startup so no rebuild needed when apps change.
// Falls back to supportedApps.js if the fetch fails.
let supportedAppsList = SUPPORTED_APPS.slice();
let appHints = {};

async function loadAppsCatalog() {
    try {
        const res = await axios.get(`${BACKEND_GATEWAY_URL}/api/greta/gateway/apps`, { timeout: 5000 });
        if (res.data.success) {
            supportedAppsList = res.data.apps;
            appHints = res.data.hints || {};
            console.log(`[Container] Loaded apps catalog: ${supportedAppsList.length} apps from backend`);
        }
    } catch (e) {
        console.warn(`[Container] Could not load apps catalog from backend (using fallback): ${e.message}`);
    }
}

// Local tool: Create a scheduled task/trigger from chat
const CREATE_TRIGGER_TOOL = {
    type: 'function',
    function: {
        name: 'create_trigger',
        description: `Create a scheduled task or webhook trigger for this agent.

CRITICAL: The runPrompt is NOT a static message — it is a FULL AGENTIC INSTRUCTION. When the trigger fires, this agent runs autonomously with ALL connected tools and executes the runPrompt as a complete AI task.

## Two patterns for the runPrompt:

### Pattern 1 — Simple polling (one-shot per run)
Use when: each run is independent. Check condition → act → done.
Example: "Every 30 min: check Gmail unread > 24h, send Slack digest"

### Pattern 2 — Async multi-turn workflow (use create_task for "wait" steps)
Use when: the workflow spans multiple time windows (e.g. send email → wait for reply → book meeting).
The agent has a built-in create_task tool to schedule a follow-up execution of itself.

EXAMPLE — "email negative tone → send meeting request → wait for reply → book calendar":
runPrompt: "Check Gmail for new emails from user@example.com (only emails received after the [Run context] timestamp). For each new email: analyze the tone. If negative: (a) check watch_get('meeting_req_'+messageId) — if exists:true, skip. (b) Send a reply asking for their availability. (c) watch_set('meeting_req_'+messageId, the threadId, ttlHours=168). (d) create_task with instruction 'Check Gmail thread [threadId] for a reply from user@example.com. If they gave a time: reply confirming, then create a Google Calendar event. If still no reply: create_task again to check in 30 minutes.' and delayMinutes=30, context={threadId, messageId}."

EXAMPLE — "PR review alert after 2 hours":
runPrompt: "Check GitHub for PRs where I am a requested reviewer (only PRs opened after [Run context] timestamp). For each new PR: check watch_get('pr_alerted_'+prNumber) — if exists:true skip. Otherwise: create_task with instruction 'Check if PR #[number] at [url] still needs review. If review is still pending: send email to [owner] with the PR link. If already reviewed: done.' and delayMinutes=120, context={prNumber, prUrl, owner}. Then watch_set('pr_alerted_'+prNumber, true, ttlHours=48)."

KEY RULES:
- Use create_task (not watch_get polling) for any "wait N hours/minutes then check" workflow
- Use watch_get/watch_set only for dedup: "have I already acted on this item?"
- Always reference item IDs (message ID, thread ID, PR number) in watch keys so they're unique
- The [Run context] timestamp is automatically injected — reference it as "after [Run context] timestamp" to filter to new items only

Call this tool after gathering: what to monitor, what condition triggers action, what action to take, how often to poll.`,
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Short descriptive name (e.g. "PR review alert")' },
                description: { type: 'string', description: 'Human-readable description of what this task does' },
                type: { type: 'string', enum: ['SCHEDULED', 'WEBHOOK_RECEIVED'], description: 'SCHEDULED for time-based polling, WEBHOOK_RECEIVED for webhook-triggered' },
                cronExpression: { type: 'string', description: 'Cron expression. REQUIRED for SCHEDULED type. Examples: "0 9 * * *" = every day 9am, "0 9 * * 1-5" = weekdays 9am, "*/5 * * * *" = every 5 min, "0 9 * * 1" = Monday 9am. Use empty string for WEBHOOK_RECEIVED.' },
                timezone: { type: 'string', description: 'Timezone for SCHEDULED tasks (e.g. "America/New_York", "Asia/Kolkata", "UTC"). Default UTC.' },
                runPrompt: { type: 'string', description: 'Natural language instruction the agent will follow at runtime. MUST be plain English — NEVER code, scripts, or pseudocode. Be specific: what to fetch, what condition to check, what action to take. Example: "Fetch today\'s Google Calendar events. Send an email to user@example.com with the subject \'Daily Meeting Reminder\' listing each meeting\'s time and title."' },
                composioApps: { type: 'array', items: { type: 'string' }, description: 'Apps this task needs. CRITICAL: only list apps from your "Connected apps" section. If an app is not connected, do NOT include it here — the task will still be created and the runPrompt can still reference that app.' },
            },
            required: ['name', 'type', 'runPrompt', 'cronExpression'],
        },
    },
};

const COMPOSIO_SEARCH_TOOL_DEF = {
    type: 'function',
    function: {
        name: 'COMPOSIO_SEARCH_TOOLS',
        description: 'Find additional tools not in your current tool set. Use when you need a specific action that is not available in the tools you already have. Composio AI searches semantically and returns matching tool schemas — you can call them immediately after.',
        parameters: {
            type: 'object',
            properties: {
                queries: {
                    type: 'array',
                    description: 'One entry per action you need to find.',
                    items: {
                        type: 'object',
                        properties: {
                            use_case: { type: 'string', description: 'What you want to do, e.g. "list all repositories for the authenticated user"' }
                        },
                        required: ['use_case']
                    }
                }
            },
            required: ['queries']
        }
    }
};

// Local tool: Always available to help agent understand current date/time
// Critical for calendar queries, scheduling, relative dates ("next week", "tomorrow")
const GET_CURRENT_TIME_TOOL = {
    type: 'function',
    function: {
        name: 'get_current_time',
        description: "Returns the current date and time. Call this FIRST when you need to know today's date, current time, day of the week, or to calculate relative dates (next week, tomorrow, etc.) — especially for calendar queries, scheduling, deadlines.",
        parameters: { type: 'object', properties: {}, required: [] },
    },
};

function executeGetCurrentTime() {
    const now = new Date();
    return JSON.stringify({
        date: now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }),
        iso: now.toISOString(),
        timestamp: now.getTime(),
    });
}

async function getGatewaySignature() {
    try {
        if (gatewaySignature && signatureExpiry && Date.now() < signatureExpiry - 300000) {
            return gatewaySignature;
        }

        console.log('[Container] Requesting fresh gateway signature...');
        const response = await axios.post(
            `${BACKEND_GATEWAY_URL}/api/greta/gateway/signature`,
            { agentId: AGENT_ID, userId: USER_ID }
        );

        if (!response.data.success) {
            throw new Error(`Failed to get signature: ${response.data.error}`);
        }

        gatewaySignature = response.data.signature;
        signatureExpiry = Date.now() + 3600000;
        console.log('[Container] Gateway signature obtained, valid until:', new Date(signatureExpiry).toISOString());
        return gatewaySignature;
    } catch (error) {
        console.error('[Container] Failed to get gateway signature:', error.message);
        throw error;
    }
}

let agentExecutor = null;
async function initializeAgent() {
    await getGatewaySignature();
    agentExecutor = new AgentExecutor({
        agentId: AGENT_ID,
        userId: USER_ID,
        backendGatewayUrl: BACKEND_GATEWAY_URL,
        gatewaySignature,
    });
    console.log('[Agent] Executor initialized');
}

async function consolidateMemory({ currentMemory, conversationTurns, agentName }) {
    try {
        const llm = createOpenRouterLLM({ temperature: 0 });
        const prompt = `You are maintaining the long-term memory for an AI agent named "${agentName}".

Memory has two sections. Keep them clearly separated:

## Facts
Permanent, stable facts about the user — name, preferences, account identifiers, recurring needs.
Update only when something genuinely new is learned about the user.

## Recent context
A short narrative paragraph (2-4 sentences) summarising what topics were discussed and what was done in the recent conversation. Rewrite this section each time to reflect the latest context.

---

Current memory:
${currentMemory || '(none yet)'}

Recent conversation:
${conversationTurns.map(m => `${m.role}: ${m.content}`).join('\n')}

---

Rules:
- Facts: only user identity, preferences, account info (names, orgs, repos they own). One line each.
- Recent context: a flowing summary of topics and outcomes — NOT a list of every message.
- NEVER store: tool names or parameters, tool errors/failures, "user is aware that..." statements, tool capabilities, one-time questions that won't recur.
- If nothing new was learned about the user, return the current memory exactly as-is.
- Keep total memory under 400 words.
- Return ONLY the memory text with the two sections. No explanation, no preamble.`;

        const response = await llm.invoke([new HumanMessage(prompt)]);
        const updatedMemory = typeof response.content === 'string' ? response.content.trim() : currentMemory;

        if (!updatedMemory || updatedMemory === currentMemory) return;

        await axios.post(
            `${BACKEND_GATEWAY_URL}/api/greta/gateway/memory`,
            { agentId: AGENT_ID, userId: USER_ID, memory: updatedMemory },
            { headers: { 'x-gateway-signature': gatewaySignature } }
        );
        console.log(`[Memory] Consolidated and saved (${updatedMemory.length} chars)`);
    } catch (e) {
        console.error('[Memory] Consolidation failed (non-fatal):', e.message);
    }
}

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        agentId: AGENT_ID,
        userId: USER_ID,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
    });
});

app.post('/execute', async (req, res) => {
    const incomingToken = req.headers['x-pod-token'];
    if (!incomingToken || incomingToken !== POD_TOKEN) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const startTime = Date.now();

    try {
        if (!agentExecutor) {
            console.log('[Execute] Agent not initialized — initializing now...');
            await initializeAgent();
            if (!agentExecutor) {
                return res.status(503).json({ success: false, error: 'Agent executor failed to initialize' });
            }
        }

        const { trigger, payload = {}, headers = {}, projectMongoUrl = null } = req.body;
        if (!trigger) {
            return res.status(400).json({ success: false, error: 'Missing trigger in request body' });
        }

        console.log(`[Execute] Trigger: ${trigger.name} (${trigger.type})`);
        if (projectMongoUrl) console.log(`[Execute] Project DB attached`);

        if (!gatewaySignature || !signatureExpiry || Date.now() > signatureExpiry - 300000) {
            await getGatewaySignature();
        }

        const result = await agentExecutor.execute({ trigger, payload, headers, gatewaySignature, projectMongoUrl });
        const executionTime = Date.now() - startTime;
        console.log(`[Execute] Completed in ${executionTime}ms`);

        res.json({
            success: true,
            data: { ...result, executionTime, agentId: AGENT_ID, timestamp: new Date().toISOString() }
        });
    } catch (error) {
        const executionTime = Date.now() - startTime;
        console.error('[Execute] Error:', error);
        res.status(500).json({ success: false, error: error.message, executionTime, timestamp: new Date().toISOString() });
    }
});

function toolStatusLabel(toolName) {
    const n = toolName.toLowerCase();
    if (n.includes('calendar')) return 'Checking your calendar...';
    if (n.includes('gmail') || n.includes('mail')) return 'Reading emails...';
    if (n.includes('slack')) return 'Checking Slack...';
    if (n.includes('github')) return 'Querying GitHub...';
    if (n.includes('notion')) return 'Checking Notion...';
    if (n.includes('sheet') || n.includes('spreadsheet')) return 'Reading spreadsheet...';
    if (n.includes('drive')) return 'Checking Google Drive...';
    if (n.includes('send')) return 'Sending...';
    if (n.includes('create') || n.includes('insert') || n.includes('add')) return 'Creating...';
    if (n.includes('delete') || n.includes('remove')) return 'Deleting...';
    if (n.includes('update') || n.includes('patch') || n.includes('edit')) return 'Updating...';
    if (n.includes('search') || n.includes('find') || n.includes('list') || n.includes('get')) return 'Looking up...';
    return 'Working...';
}

app.post('/chat', async (req, res) => {
    const incomingToken = req.headers['x-pod-token'];
    if (!incomingToken || incomingToken !== POD_TOKEN) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const { message, conversationId, history = [], userId: reqUserId, agentConfig = {} } = req.body;
    const userId = reqUserId || USER_ID;

    if (!message) {
        return res.status(400).json({ success: false, error: 'Missing message' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const emit = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    let cancelled = false;
    // Use res.on('close') not req.on('close') — on HTTP/2 (Cloud Run), req closes
    // immediately when the request body END_STREAM is received, which is before
    // Phase 3 starts. res closes only when the response is actually finished or
    // the client truly disconnects.
    res.on('close', () => { cancelled = true; });

    try {
        if (!gatewaySignature) {
            try { await getGatewaySignature(); }
            catch (e) {
                emit({ type: 'error', message: 'Gateway not ready: ' + e.message });
                return res.end();
            }
        }

        const agentName = agentConfig.name || 'Assistant';
        const coreInstructions = agentConfig.coreInstructions || 'You are a helpful assistant.';
        const composioApps = agentConfig.composioApps || [];
        const currentMemory = agentConfig.memory || '';
        const isOnboarding = agentConfig.onboardingStatus === 'in_progress';
        const mcpEnabled = agentConfig.mcpEnabled || false;
        const mcpServers = agentConfig.mcpServers || [];

        console.log(`[Chat] Agent: ${agentName}, Apps: ${JSON.stringify(composioApps)}, MCP: ${mcpEnabled}, Onboarding: ${isOnboarding}`);

        let toolDefs = [];
        let selfConfigToolInstances = [];

        if (isOnboarding) {
            selfConfigToolInstances = createSelfConfigTools({ agentId: AGENT_ID, userId, gatewayUrl: BACKEND_GATEWAY_URL, composioApps });
            toolDefs = selfConfigToolInstances;
            console.log(`[Chat] Onboarding mode — loaded ${toolDefs.length} self-config tools`);
        }

        // Build base prompt sections used by both Phase 1 and Phase 3
        const memorySection = currentMemory ? `\n\n## What you remember about this user\n${currentMemory}` : '';
        const appsSection = composioApps.length > 0
            ? `\n\n## Connected apps (tools available)\n` +
              composioApps.map(a => {
                  const hint = appHints[a.toUpperCase()];
                  return hint ? `- ${a}: ${hint}` : `- ${a}`;
              }).join('\n')
            : '';

        const notConnectedApps = supportedAppsList.filter(a => !composioApps.map(x => x.toUpperCase()).includes(a.toUpperCase()));
        const connectableSection = notConnectedApps.length > 0
            ? `\n\n## Apps available to connect (not yet connected)\n${notConnectedApps.join(', ')}\n\nCRITICAL — "connect X" rule: If the user says "connect [app]", "add [app]", "I want to use [app]", or asks to do ANYTHING that requires one of the apps above, output TOOLS_NEEDED:APPNAME on the FIRST line. You MAY add one optional sentence on the next line telling the user what you will do after they connect (especially if they described a specific task). Nothing else.\nFormat:\nTOOLS_NEEDED:APPNAME\n[Optional: one sentence about what happens after connecting]\n\nUse the exact uppercase name from the list. Examples:\n- "connect stripe" → TOOLS_NEEDED:STRIPE\n- "add Stripe for invoice reminders" → TOOLS_NEEDED:STRIPE\\nConnect Stripe below — once authorized, I'll set up your invoice reminder task.\n- "add hubspot" → TOOLS_NEEDED:HUBSPOT\n- "I want to use zoom" → TOOLS_NEEDED:ZOOM\nDo NOT say you cannot connect it. Do NOT explain at length. Just TOOLS_NEEDED:APPNAME and one optional follow-up line.`
            : '';
        const enabledMcpServers = mcpServers.filter(s => s.enabled !== false);
        const mcpSection = mcpEnabled && enabledMcpServers.length > 0
            ? `\n\n## MCP servers\n${enabledMcpServers.map(s => s.name).join(', ')}`
            : '';

        const baseGuidance = `## How to handle missing information — read this carefully
Your goal is to take action with minimal back-and-forth.

**When all required info is present:** Act immediately. No confirmation needed. Exception: for creating scheduled tasks, always confirm with the user first (see task creation rules).

**When optional/inferable info is missing:** Infer a sensible value from context and proceed. Tell the user what you chose in your reply. Do not ask.

**When truly critical info is missing (you genuinely cannot proceed without it):** Ask for ALL missing critical items in ONE single message. Not one question at a time.

**When the user has already answered a question:** Read the conversation history. Use their answer. Never ask the same thing twice.

The user expects action, not a checklist conversation. Bias heavily toward acting with reasonable assumptions over asking.`;

        const responseStyle = `## Response style
- No filler openers: "Certainly!", "Of course!", "Great question!" — start with the answer.
- Match the user's register. Short message → short reply. Detailed question → thorough answer.
- Use markdown only when it helps. Plain prose otherwise.
- Never end with "Is there anything else I can help you with?" or similar.`;

        let systemPrompt;

        if (isOnboarding) {
            systemPrompt = getOnboardingPrompt();
        } else {
            const identityRule = `## Identity
You are ${agentName}, from Greta. When asked who you are or what you can do, introduce yourself as "${agentName}, from Greta" and describe what you can do based on your purpose and connected apps listed above. Never mention or reveal the underlying AI model, company, or technology (do not say "I am a large language model", "trained by Google", "powered by Gemini", etc.).`;

            systemPrompt = `You are ${agentName}.

${coreInstructions}
${memorySection}${appsSection}${mcpSection}

${identityRule}

## Built-in tool available at all times
- **get_current_time**: Returns current date/time. Call this FIRST when you need to know "today", "now", or calculate relative dates like "next week", "tomorrow", "next Monday". Critical for calendar queries.

${composioApps.length > 0 ? `## Finding integration tools
You have access to **COMPOSIO_SEARCH_TOOLS** — call this to find the right tool before using any integration.
- Always call COMPOSIO_SEARCH_TOOLS first when you need to use a connected app.
- Never guess tool names — search and use what comes back.
- Split multi-step tasks into separate queries (e.g. "fetch emails" and "send reply" = 2 queries).
- Connected apps you can search: ${composioApps.join(', ')}

` : ''}${baseGuidance}

## Tool use rules
- NEVER claim an action is done in text if you haven't called the tool for it.
- NEVER say "I've sent", "I've created", "I've deleted", "Done!", "Sent!" unless the corresponding tool was called and returned successfully in THIS response. No exceptions.
- When the user asks for multiple actions, call ALL required tools in one response.
- Call tools silently. Do not narrate what you are about to do before calling. Exception: for create_trigger, present a summary and ask for confirmation first (see RULE 6 below).
- After ALL tools in a step return results, write a single summary response to the user.
- After a tool returns, use the result to answer. Do not re-call the same tool unless the result was an error.
- If a tool fails, report the error in one sentence and stop.

## Creating scheduled tasks — MANDATORY RULES

Use the **create_trigger** tool when the user wants to create a task, automation, reminder, or any "monitor X and do Y" workflow.

**RULE 1 — NEVER say something is impossible.**
ANY monitoring + conditional notification task is achievable via scheduled polling. If you catch yourself saying "I cannot", stop — you are wrong. Reframe as a polling approach and proceed.

**RULE 2 — On create_trigger error, fix and retry immediately.**
If create_trigger returns an error, diagnose and retry with corrected parameters in the SAME response. Common fixes: remove apps from composioApps that aren't in your connected apps list, fix the cronExpression format, ensure runPrompt is non-empty.

**RULE 3 — The runPrompt is fully agentic.**
The runPrompt MUST be plain English natural language — NEVER code, scripts, or pseudocode.

**RULE 4 — Use a fixed dedup key format.**
In the runPrompt, always specify the exact watch key string, e.g. watch_get("notified_pr_{owner}_{repo}_{number}").

**RULE 5 — Missing integration = connect it, not a workaround.**
If a needed integration is not connected, respond EXACTLY: "To set this up, you'll need to connect **[App Name]** to your agent. Click **Configure** (top right) → Integrations → connect [App Name]. Once connected, come back and I'll create this task for you immediately."

**RULE 6 — Always confirm before creating.**
Before calling create_trigger, write a one-sentence summary and ask "Shall I set this up?" — wait for confirmation before calling the tool.
EXCEPTION: If history shows you already asked and the user's latest message confirms ("yes", "go ahead", "do it", "sure", "ok") — call create_trigger immediately.

${responseStyle}`;
        }

        const phase3Messages = [
            { role: 'system', content: systemPrompt },
            ...history.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: message }
        ];

        // Both onboarding and chat use LangChain — consistent with main backend
        const llm = createOpenRouterLLM({ temperature: 0.2 });
        const llmWithOnboarding = isOnboarding
            ? (toolDefs.length > 0 ? llm.bindTools(toolDefs) : llm)
            : null;

        async function executeExternalTool(tc) {
            // LangChain format: tc.name / tc.args (already-parsed object)
            const name = tc.name;
            const args = tc.args || {};

            // Self-orchestration tools (watch_set/get/clear, create_task) — handled locally
            if (['watch_set', 'watch_get', 'watch_clear', 'create_task'].includes(name)) {
                try {
                    const orchTools = createOrchestrationTools({
                        agentId: AGENT_ID, userId,
                        backendGatewayUrl: BACKEND_GATEWAY_URL,
                        getSignature: () => gatewaySignature,
                    });
                    return await orchTools.executeOrchestrationTool(name, args);
                } catch (e) { return `Tool failed: ${e.message}`; }
            }

            // create_trigger — creates a scheduled task via backend, then notifies frontend
            if (name === 'create_trigger') {
                try {
                    const trigRes = await axios.post(
                        `${BACKEND_GATEWAY_URL}/api/greta/gateway/trigger/create`,
                        { agentId: AGENT_ID, userId, ...args },
                        { headers: { 'x-gateway-signature': gatewaySignature } }
                    );
                    if (trigRes.data.success) {
                        emit({ type: 'trigger_created', triggerId: trigRes.data.triggerId, name: args.name });
                        return JSON.stringify({ success: true, message: `Task "${args.name}" created successfully.` });
                    }
                    return `Error: ${trigRes.data.error}`;
                } catch (e) { return `Tool failed: ${e.message}`; }
            }

            if (name.startsWith('mcp_')) {
                try {
                    const mcpRes = await axios.post(
                        `${BACKEND_GATEWAY_URL}/api/greta/gateway/mcp/execute`,
                        { agentId: AGENT_ID, userId, toolName: name, args },
                        { headers: { 'x-gateway-signature': gatewaySignature } }
                    );
                    return mcpRes.data.success
                        ? (typeof mcpRes.data.result === 'string' ? mcpRes.data.result : JSON.stringify(mcpRes.data.result))
                        : `Error: ${mcpRes.data.error}`;
                } catch (e) { return `Tool failed: ${e.message}`; }
            }

            const doExec = async () => axios.post(
                `${BACKEND_GATEWAY_URL}/api/greta/gateway/composio/execute`,
                { agentId: AGENT_ID, userId, action: name, params: args },
                { headers: { 'x-gateway-signature': gatewaySignature } }
            );
            let execRes;
            try {
                execRes = await doExec();
            } catch (e) {
                if (e.response?.status === 401 || e.response?.status === 403) {
                    gatewaySignature = null; signatureExpiry = null;
                    await getGatewaySignature();
                    execRes = await doExec();
                } else { throw e; }
            }
            return execRes.data.success ? JSON.stringify(execRes.data.data) : `Error: ${execRes.data.error}`;
        }

        function extractText(msg) {
            if (!msg) return '';
            if (typeof msg.content === 'string') return msg.content;
            if (Array.isArray(msg.content)) return msg.content.filter(p => p.type === 'text').map(p => p.text).join('');
            return '';
        }

        let finalText = '';
        let toolsExecuted = false;
        const generationIds = [];
        // Token fallback — used when OpenRouter generation API returns null
        const AGENT_MODEL_NAME = process.env.AGENT_MODEL || 'google/gemini-2.5-flash';
        let totalPromptTokens = 0, totalCompletionTokens = 0;

        function trackCall(msg) {
            if (!msg) return;
            if (msg.id) generationIds.push(msg.id);
            const u = msg.usage_metadata || msg.response_metadata?.tokenUsage || msg.response_metadata?.usage;
            if (!u) return;
            totalPromptTokens     += u.input_tokens  || u.promptTokens  || u.prompt_tokens  || 0;
            totalCompletionTokens += u.output_tokens || u.completionTokens || u.completion_tokens || 0;
        }

        if (isOnboarding) {
            // ── Onboarding: LangChain path unchanged ─────────────────────────────
            const lcMessages = [
                new SystemMessage(systemPrompt),
                ...history.map(m => m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)),
                new HumanMessage(message)
            ];
            for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
                let response;
                try { response = await llmWithOnboarding.invoke(lcMessages); }
                catch (e) { console.error('[Chat] Onboarding LLM failed:', e.message); break; }
                const text = extractText(response);
                const hasTools = response.tool_calls?.length > 0;
                lcMessages.push(response);
                if (!hasTools) { finalText = text; break; }
                const selfConfigResults = await Promise.all(
                    response.tool_calls.map(async (tc) => {
                        const localTool = selfConfigToolInstances.find(t => t.name === tc.name);
                        const result = localTool ? String(await localTool.invoke(tc.args)) : `Tool ${tc.name} not found`;
                        return { tc, result };
                    })
                );
                for (const { tc, result } of selfConfigResults) {
                    lcMessages.push(new ToolMessage({ tool_call_id: tc.id, content: result }));
                }
            }
        } else {
            // ── Direct Phase 3 — no sentinel, no pre-load ───────────────────────
            // Phase 1 removed: the sentinel approach was fragile with conversation history.
            // The LLM now decides tool use naturally — COMPOSIO_SEARCH_TOOLS handles discovery.

            // Load MCP tools if enabled
            if (mcpEnabled && mcpServers.filter(s => s.enabled !== false).length > 0) {
                const mcpCacheValid = mcpToolsCache && mcpToolsCacheTime && (Date.now() - mcpToolsCacheTime < MCP_CACHE_TTL_MS);
                if (mcpCacheValid) {
                    toolDefs.push(...mcpToolsCache);
                    console.log(`[Chat] Using cached MCP tools (${mcpToolsCache.length})`);
                } else {
                    try {
                        const mcpRes = await axios.post(
                            `${BACKEND_GATEWAY_URL}/api/greta/gateway/mcp/tools`,
                            { agentId: AGENT_ID, userId },
                            { headers: { 'x-gateway-signature': gatewaySignature } }
                        );
                        const mcpDefs = mcpRes.data.success ? (mcpRes.data.tools || []) : [];
                        mcpToolsCache = mcpDefs;
                        mcpToolsCacheTime = Date.now();
                        toolDefs.push(...mcpDefs);
                        console.log(`[Chat] Loaded ${mcpDefs.length} MCP tools`);
                    } catch (e) {
                        console.error('[Chat] Failed to load MCP tools:', e.message);
                    }
                }
            }

            toolDefs.push(GET_CURRENT_TIME_TOOL);
            toolDefs.push(CREATE_TRIGGER_TOOL);
            if (composioApps.length > 0) toolDefs.push(COMPOSIO_SEARCH_TOOL_DEF);

            const orchestration = createOrchestrationTools({
                agentId: AGENT_ID,
                userId,
                backendGatewayUrl: BACKEND_GATEWAY_URL,
                getSignature: () => gatewaySignature,
            });
            toolDefs.push(...orchestration.toolDefs);
            console.log(`[Chat] ${toolDefs.length} tools ready — entering ReAct loop`);

            let llmWithTools;
            try {
                llmWithTools = toolDefs.length > 0 ? llm.bindTools(toolDefs) : llm;
            } catch (bindErr) {
                console.error('[Chat] bindTools failed:', bindErr.message);
                llmWithTools = llm;
            }

            for (let step = 0; step < 8 && !cancelled; step++) {
                console.log(`[Chat] Step ${step + 1}: invoking LLM...`);
                let msg;
                try {
                    msg = await llmWithTools.invoke(phase3Messages);
                } catch (e) {
                    console.error('[Chat] LLM invoke failed:', e.message, e.stack?.slice(0, 300));
                    break;
                }

                trackCall(msg);
                const text = extractText(msg).trim();
                const toolCalls = msg.tool_calls || [];

                const isHallucinatedAction = toolCalls.length > 0 && text &&
                    /\b(i have|i've|i sent|i created|i drafted|i scheduled|i added|i deleted|i updated)\b/i.test(text);
                if (isHallucinatedAction) {
                    console.warn(`[Chat] Step ${step + 1} — discarding hallucinated action text: "${text.slice(0, 80)}"`);
                }

                console.log(`[Chat] Step ${step + 1} — "${text.slice(0, 100)}", tool_calls: ${toolCalls.length}`);
                phase3Messages.push(msg);

                if (toolCalls.length === 0) { finalText = text; break; }

                console.log(`[Chat] Executing:`, toolCalls.map(t => t.name).join(', '));
                await Promise.all(toolCalls.map(async (tc) => {
                    emit({ type: 'status', content: toolStatusLabel(tc.name) });
                    try {
                        let result;
                        if (tc.name === 'get_current_time') {
                            result = executeGetCurrentTime();
                        } else if (tc.name === 'COMPOSIO_SEARCH_TOOLS') {
                            const searchRes = await axios.post(
                                `${BACKEND_GATEWAY_URL}/api/greta/gateway/composio/meta/search`,
                                { agentId: AGENT_ID, userId, queries: tc.args?.queries || [] },
                                { headers: { 'x-gateway-signature': gatewaySignature } }
                            );
                            const newSchemas = searchRes.data.success ? (searchRes.data.tools || []) : [];
                            const added = [];
                            for (const schema of newSchemas) {
                                const tName = schema.function?.name || schema.name;
                                if (tName && !toolDefs.find(d => (d.function?.name || d.name) === tName)) {
                                    toolDefs.push(schema);
                                    added.push(tName);
                                }
                            }
                            if (added.length > 0) {
                                llmWithTools = llm.bindTools(toolDefs);
                                console.log(`[Chat] COMPOSIO_SEARCH_TOOLS injected ${added.length} tools: ${added.slice(0, 5).join(', ')}`);
                            }
                            result = JSON.stringify({
                                found: newSchemas.length,
                                tools: newSchemas.map(t => t.function?.name || t.name),
                                message: newSchemas.length > 0
                                    ? `Found ${newSchemas.length} tools. They are now available — call them directly.`
                                    : 'No tools found. Try using the tools already in your tool set.'
                            });
                        } else {
                            result = await executeExternalTool(tc);
                        }
                        phase3Messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
                        toolsExecuted = true;
                    } catch (e) {
                        phase3Messages.push({ role: 'tool', tool_call_id: tc.id, content: `Tool failed: ${e.message}` });
                    }
                }));
            }

            // Synthesis fallback — if LLM went silent after tools
            if ((!finalText || /^done\.?$/i.test(finalText.trim())) && !cancelled) {
                const toolMsgs = phase3Messages.filter(m => m.role === 'tool');
                if (toolMsgs.length > 0) {
                    try {
                        const toolResultsText = toolMsgs.map(m => String(m.content)).join('\n---\n');
                        const synthMsg = await llm.invoke([
                            { role: 'system', content: 'Summarize these tool results as a clear helpful response. Be direct, no filler.' },
                            { role: 'user', content: `User said: "${message}"\n\nTool results:\n${toolResultsText}` }
                        ]);
                        trackCall(synthMsg);
                        finalText = extractText(synthMsg).trim();
                    } catch (e) { console.error('[Chat] Synthesis failed:', e.message); }
                }
            }
        }

        console.log(`[Chat] After all phases — finalText.length:${finalText.length}, toolsExecuted:${toolsExecuted}, cancelled:${cancelled}`);

        // Last-resort fallback — tools loaded but LLM produced nothing at all.
        // CRITICAL: Use a safe prompt that won't trigger sentinel values or tool hallucinations
        if (!finalText && !cancelled) {
            console.warn('[Chat] ⚠️  FALLBACK TRIGGERED — Empty finalText after all phases');
            try {
                const safeFallbackPrompt = `You are ${agentName}. ${coreInstructions}\n\nThe user sent a message but you produced no response. Apologize briefly and ask them to rephrase their request. Be concise and helpful.`;
                const fallbackMsg = await llm.invoke([
                    { role: 'system', content: safeFallbackPrompt },
                    { role: 'user', content: message }
                ]);
                trackCall(fallbackMsg);
                finalText = extractText(fallbackMsg).trim();
                console.log(`[Chat] Fallback response: "${finalText.slice(0, 100)}"`);
            } catch (e) {
                // Ultimate fallback - static error message
                finalText = "I encountered an error processing your request. Please try again.";
                console.error('[Chat] Fallback response failed:', e.message, e.stack?.slice(0, 300));
            }
        }

        const cleanText = finalText
            .replace(/\[[\w_]+\([^)]*\)\]/g, '')
            .replace(/```tool_code[\s\S]*?```/g, '')
            .trim();

        // Fetch exact USD cost from OpenRouter before sending done — runs in background
        // after response text is already streamed, so user sees no delay.
        const actualCostUSD = await fetchTotalRunCost(generationIds);
        console.log(`[Chat] Cost: $${actualCostUSD} (OpenRouter) | tokens: ${totalPromptTokens}in/${totalCompletionTokens}out | genIds: ${generationIds.length}`);

        console.log(`[Chat] Sending done — cancelled:${cancelled} finalText:"${cleanText.slice(0, 100)}" (${cleanText.length} chars)`);
        if (cleanText) emit({ type: 'chunk', content: cleanText });
        emit({
            type: 'done',
            response: cleanText,
            conversationId,
            actualCostUSD,
            tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, model: AGENT_MODEL_NAME },
        });
        res.end();

        // Consolidate memory every 4 turns so facts are captured early in short conversations.
        // history.length is the number of prior messages before this turn.
        // Adding 2 (user + assistant) gives total turns after this message.
        if (!isOnboarding && (history.length + 2) % 8 === 0) {
            const conversationTurns = [
                ...history.slice(-12),
                { role: 'user', content: message },
                { role: 'assistant', content: cleanText }
            ];
            consolidateMemory({ currentMemory, conversationTurns, agentName });
            console.log(`[Memory] Consolidation triggered at turn ${history.length + 2}`);
        }

    } catch (error) {
        console.error('[Chat] Error:', error);
        emit({ type: 'error', message: error.message });
        res.end();
    }
});

async function start() {
    app.listen(PORT, () => {
        console.log(`[Container] Agent ${AGENT_ID} ready on port ${PORT}`);
        console.log(`[Container] Endpoints: GET /health  POST /chat  POST /execute`);
    });

    // Load apps catalog from backend (non-blocking — falls back to local list if it fails)
    loadAppsCatalog();

    try {
        await initializeAgent();
        console.log('[Container] Agent initialized successfully');
    } catch (error) {
        console.warn('[Container] Agent initialization failed (will retry on first /execute):', error.message);
    }
}

process.on('SIGTERM', () => { console.log('[Container] SIGTERM — shutting down'); process.exit(0); });
process.on('SIGINT', () => { console.log('[Container] SIGINT — shutting down'); process.exit(0); });

start();
