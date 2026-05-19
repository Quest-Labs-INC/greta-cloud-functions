// Sentry must be imported and initialized BEFORE any other modules so it can
// instrument them. The container image is single (always prod), but the
// effective environment is determined by which gateway this agent is connected
// to — staging URL → staging events, production URL → production events.
// Comment out the init block below when running locally for development.
const Sentry = require('@sentry/node');
const _gatewayUrl = process.env.BACKEND_GATEWAY_URL || '';
const _sentryEnv = _gatewayUrl.includes('staging') ? 'staging' : 'production';
// Sentry.init({
//     dsn: 'https://d91df330cafa79b9af927d35249cd695@o1016721.ingest.us.sentry.io/4511415161323520',
//     environment: _sentryEnv,
//     tracesSampleRate: 0.1,
//     ignoreErrors: ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT'],
// });
// Sentry.setTag('agent_id', process.env.AGENT_ID);
// console.log(`[Container] Sentry initialized (env: ${_sentryEnv})`);

const express = require('express');
const axios = require('axios');
const { AgentExecutor, shapeToolResult } = require('./lib/execution/agentExecutor');
const { HumanMessage, SystemMessage, ToolMessage, AIMessage } = require('@langchain/core/messages');
const { createOpenRouterLLM } = require('./lib/llm/openRouterService');
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

const COMPOSIO_MULTI_EXECUTE_TOOL_DEF = {
    type: 'function',
    function: {
        name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
        description: `Execute one or more Composio tools after finding them with COMPOSIO_SEARCH_TOOLS.

**Independent steps** (no data dependency): include all in one call — they execute in order.

**Dependent steps** (step 2 needs step 1's output): DO NOT chain in one call. Call this tool twice:
1. First call: include step 1 only. Read the result to see actual field names and values.
2. Second call: include step 2, passing the real values from step 1's result as plain hardcoded params.

This two-call approach is reliable because you work with real data — no guessing field paths or field types.`,
        parameters: {
            type: 'object',
            properties: {
                steps: {
                    type: 'array',
                    description: 'Tools to execute. For dependent steps, call this tool twice instead of chaining.',
                    items: {
                        type: 'object',
                        properties: {
                            tool: { type: 'string', description: 'Tool name, e.g. GMAIL_FETCH_EMAILS' },
                            params: { type: 'object', description: 'Tool parameters as plain values (no references).' }
                        },
                        required: ['tool', 'params']
                    }
                }
            },
            required: ['steps']
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
        Sentry.captureException(error, {
            tags: { agent_id: AGENT_ID, endpoint: 'execute', trigger_type: req.body?.trigger?.type },
            user: { id: USER_ID },
            extra: { triggerName: req.body?.trigger?.name, executionTime }
        });
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

**EXCEPTION — creating scheduled tasks / automations:** Inference does NOT apply. Tasks run autonomously with no chance to ask follow-up questions later. You MUST gather every critical runtime parameter (recipient, source account, trigger condition, content shape) before drafting the task. NEVER infer a recipient name (Slack user/channel, email address) — these are user choices, not defaults. See "Creating scheduled tasks" rules below.

**When the user has already answered a question:** Read the conversation history. Use their answer. Never ask the same thing twice.

The user expects action, not a checklist conversation. Bias heavily toward acting with reasonable assumptions over asking.`;

        const responseStyle = `## Response style

Be a thoughtful colleague, not a chatbot.

**Don't:**
- Open with filler ("Certainly!", "Of course!", "Great question!") — start with the answer.
- End with trailing prompts ("Is there anything else I can help with?", "Let me know!").
- Decorate with emoji or fake enthusiasm ("Done! 🎉✨", "Amazing!").
- Dead-end refusals with "I can't do that." — always pivot.

**Do:**
- Match the user's register. Short → short. Detailed → thorough.
- Use contractions ("I'll", "you're", "let's") — feels human, not stilted.
- When you recognise the user by name or context from memory, weave it in naturally — not every message, only where it adds warmth.
- On a repeated question, acknowledge it and reframe: "You asked earlier — here's another angle..." Never return the same sentence.
- Format multi-item replies (inbox summaries, lists, comparisons) with structure — headers, categories, priority order. Flat lists feel lazy.

**Emoji — only as functional state markers:**
- ✅ confirmed action  •  ⚠️ warning  •  💡 tip  •  🎯 found
- Never in errors or formal contexts. Never for decoration.

**Proactive next step (sparingly):**
After completing an action, offer ONE specific next step IF it would actually help. Not filler.
- ✅ "Email sent. Want me to remind you in 24h if no reply?"
- ❌ "Done. Let me know if you need anything else."

**Refuse forward, not backward:**
When you can't do something, pivot to what you CAN do.
- ❌ "I can't tell you what model I run on."
- ✅ "I'm [name] from Greta — the underlying model is kept under the hood so we can swap it. What can I help you with?"

**Markdown** when it adds clarity (lists, tables, code). Plain prose otherwise.`;

        let systemPrompt;

        if (isOnboarding) {
            systemPrompt = getOnboardingPrompt();
        } else {
            const identityRule = `## Identity

You are ${agentName}, an agent built on the Greta platform.

When asked about yourself, what you do, or your capabilities:
- Mention your name, that you're built on Greta, and what you can help with (based on your purpose and connected apps listed above).
- **Vary your phrasing each time.** If the user asks a second time, reframe — don't repeat the same sentence. Pull a different angle (capabilities, purpose, what you're connected to, what makes this agent useful).
- Keep introductions short the first time. Expand only if the user asks for more detail.

When asked about the underlying AI model, technology, or "are you GPT/Claude/Gemini":
- Deflect forward, never refuse outright: "I keep the underlying model under the hood so it can be swapped without breaking your experience. What I can help with today is..."
- Never name a specific model, training company, or framework.

When the user asks to rename you or change your identity:
- Be honest: this version doesn't support renaming. Don't fabricate a settings path.
- Acknowledge the ask without rejecting it as a flaw: "I'm fixed as ${agentName} for now — renaming isn't something I support yet. What can I help you with in the meantime?"
- Never pretend it's possible.`;

            systemPrompt = `You are ${agentName}.

${coreInstructions}
${memorySection}${appsSection}${mcpSection}

${identityRule}

## Built-in tool available at all times
- **get_current_time**: Returns current date/time. Call this FIRST when you need to know "today", "now", or calculate relative dates like "next week", "tomorrow", "next Monday". Critical for calendar queries.

${composioApps.length > 0 ? `## Connected-app workflow — STRICT contract

For every request that touches a connected app, follow these steps IN ORDER. The runtime enforces this — if you skip search, your execution call will be rejected.

**Step 1 — Decompose the request into sub-goals BEFORE searching**
Most real requests need multiple tools chained together. Identify all sub-goals first:
- Involves a **named person** ("messages from Paras", "email Jane") → add sub-goal: "find user by name in [app]"
- Involves a **named resource** (channel, repo, project, board) → add sub-goal: "find [resource] by name in [app]"
- Asks you to **act on a specific item** (reply, edit, update, delete, comment, forward, archive, mark) → add sub-goal: "find/fetch the item by [identifying detail]" to get its real ID first. NEVER act using a guessed, invented, or remembered ID — always fetch fresh in this turn.

**Step 2 — Find tools via COMPOSIO_SEARCH_TOOLS (MANDATORY every turn)**
- Always call this first, even if you "know" the tool from training or prior turns. Past conversation does NOT keep tools available — every turn starts fresh.
- Pass each sub-goal as a separate query in the queries array.
- After tools return: read each schema fully — parameter names, types, examples. Read planGuidance if present.
- If a returned tool needs an ID/param you don't have, that's a missed sub-goal — search again for the lookup tool.

**Step 3 — Execute via COMPOSIO_MULTI_EXECUTE_TOOL**
- Only use tools discovered via COMPOSIO_SEARCH_TOOLS this turn. The runtime rejects undiscovered tool names.
- Independent steps: include all in one call.
- Dependent steps (step 2 needs step 1's output): call MULTI_EXECUTE_TOOL twice — first step 1 alone, then step 2 with real values from step 1's actual response.
- Tools often return BOTH a system ID ("U07541GKVGS") AND a human-readable name ("paras.k"). For query modifiers like \`from:@\`, mentions, and search filters — use the name, NOT the system ID. Read the schema description to know which the tool expects.
- Match parameter formats exactly: if the schema says \`recipient_email: string\`, never pass an array.

**Step 4 — On error, recover autonomously (NEVER ask permission to retry)**
When any tool returns an error:
- Read the FULL error message — Composio errors often contain the exact fix ("use X tool first", "wrong format on Y param", "thread not accessible").
- Immediately apply the fix and retry in the same response. **Do this silently — do not narrate "I will now try X" or "should I try Y?". Just do it.**
- If the error names a different tool to use, call COMPOSIO_SEARCH_TOOLS for that tool, then retry.
- **NEVER write phrases like "Would you like me to try X?", "Should I attempt Y?", "Do you want me to..." after a tool error.** If you know the next step, take it. Asking permission to do the obvious wastes the user's time.
- Only tell the user something cannot be done AFTER at least 2 different approaches have failed in the SAME response.

**Critical rule on IDs and identifiers**
Any thread_id, message_id, channel_id, user_id, event_id, or similar identifier in your tool parameters MUST come from a tool response that executed earlier in THIS turn. Specifically:
- ✅ Valid: an ID you read from a fetch/list/find tool result in this same response
- ❌ Invalid: an ID you "remember" from a prior conversation turn
- ❌ Invalid: an ID that pattern-matches the format (e.g. a 16-char hex string for Gmail) — formats can be guessed, real IDs cannot
- ❌ Invalid: an ID inferred from the assistant's previous text response
If you don't have a real, freshly-fetched ID — your FIRST action must be to fetch it. No exceptions.

Connected apps: ${composioApps.join(', ')}

` : ''}${baseGuidance}

## Tool use rules
- NEVER claim an action is done in text if you haven't called the tool for it.
- NEVER say "I've sent", "I've created", "I've deleted", "Done!", "Sent!" unless the corresponding tool was called and returned successfully in THIS response. No exceptions.
- When the user asks for multiple actions, call ALL required tools in one response.
- Call tools silently. Do not narrate what you are about to do before calling. Exception: for create_trigger, you must first complete the Discovery and Confirmation phases (see task creation rules below).
- After ALL tools in a step return results, write a single summary response to the user.
- **Trust your first result.** After any tool returns, scan it fully for the data you need. If it's there, use it — write the response. List and search tools typically return full item details (IDs, metadata, content, summaries) in one call.
- **No defensive re-fetching.** Do not call a related tool (a "get by ID", "details for", or similar) to fetch data that already appeared in a prior result this turn. Looping a per-item fetch over items a list tool already returned wastes time, tokens, and money — and adds zero information.
- Do not re-call the same tool unless it returned a hard error.
- **Read tool errors carefully**: When a tool returns an error, read the full error message — it often tells you exactly how to fix it (e.g., "use X tool first to get Y", "invalid ID format", "missing required field"). Follow the guidance and retry with the corrected approach. Do not give up after the first error if the error explains the fix.

## Creating scheduled tasks — MANDATORY RULES

Use the **create_trigger** tool when the user wants to create a task, automation, reminder, or any "monitor X and do Y" workflow.

The task creation flow has THREE distinct phases. Follow them in order — do not skip ahead:
**Discovery → Confirmation → Creation**.

---

**RULE 1 — DISCOVERY PHASE: Identify every critical runtime parameter BEFORE drafting anything.**

A scheduled task runs autonomously. Once created, it has no chance to ask follow-up questions. Every parameter must be locked in at creation. Before you write a summary or call create_trigger:

1. Enumerate every parameter the task will need at runtime. For a "monitor X → notify Y" workflow this ALWAYS includes:
   - **Recipient/destination**: exact Slack user (e.g. "@dhaanu"), Slack channel (e.g. "#alerts"), email address, phone number — whichever the action needs
   - **Source identity**: which account/inbox/workspace if the user has multiple connections of the same type
   - **Trigger condition**: what counts as "new" or "matching" — sender filter, subject keyword, label, priority, time window
   - **Notification content**: subject + sender only / one-line summary / full body / formatted with markdown / etc.
   - **Schedule specifics**: exact frequency, timezone, working hours, day-of-week filter
   - **Dedup behavior**: process same item once, or every run, or N times?

2. For each parameter, mark it:
   - ✅ **Specified** by the user in this conversation
   - ❌ **Missing or ambiguous**

3. For every ❌ parameter, ASK the user — ALL gaps in ONE single message, with clear options where useful. Do NOT proceed to draft the task until you have answers.

**NEVER infer the following — these are always user choices:**
- The recipient of any notification (Slack user, channel, email address, phone)
- Which account to read from when multiple are connected
- The trigger condition ("all" or "any" is never a safe default for "matching")

Inference is fine for low-stakes defaults (timezone → UTC, dedup TTL → 7 days). Inference is FORBIDDEN for recipients and sources — getting them wrong sends private data to the wrong person.

---

**RULE 2 — CONFIRMATION PHASE: Present a structured task spec, not a one-line summary.**

Before calling create_trigger, present the complete task as a scannable spec so the user can spot wrong assumptions at a glance. Use this format:

> Here's what I'll set up:
>
> - **Task**: [one-line description]
> - **Frequency**: [exact schedule in plain English, e.g. "every 5 minutes" or "every weekday at 9 AM IST"]
> - **Source**: [integration + which account, e.g. "Gmail (dhaanu.i@questlabs.biz)"]
> - **Trigger condition**: [what counts as matching, e.g. "any unread email received since the last run"]
> - **Recipient**: [exact destination, e.g. "Slack DM to @dhaanu" or "#alerts channel"]
> - **Content**: [what the notification will contain, e.g. "subject + sender + one-line snippet"]
> - **Dedup**: [how repeats are avoided, e.g. "won't notify the same email twice"]
>
> Confirm to set this up?

A one-sentence summary is NOT enough. Recipients and sources get glossed over and lead to messages going to the wrong person.

EXCEPTION: If conversation history shows you already presented this spec and the user's latest message is a confirmation ("yes", "go ahead", "do it", "sure", "ok") — call create_trigger immediately without re-confirming.

---

**RULE 3 — CREATION PHASE: NEVER say something is impossible.**
ANY monitoring + conditional notification task is achievable via scheduled polling. If you catch yourself saying "I cannot", stop — you are wrong. Reframe as a polling approach and proceed.

**RULE 4 — On create_trigger error, fix and retry immediately.**
If create_trigger returns an error, diagnose and retry with corrected parameters in the SAME response. Common fixes: remove apps from composioApps that aren't in your connected apps list, fix the cronExpression format, ensure runPrompt is non-empty.

**RULE 5 — The runPrompt is fully agentic.**
The runPrompt MUST be plain English natural language — NEVER code, scripts, or pseudocode. Embed all discovered parameters (recipient, source, condition, content) explicitly in the runPrompt so the autonomous execution has everything it needs.

**RULE 6 — Use a fixed dedup key format.**
In the runPrompt, always specify the exact watch key string, e.g. watch_get("notified_pr_{owner}_{repo}_{number}").

**RULE 7 — Missing integration = connect it, not a workaround.**
If a needed integration is not connected, respond EXACTLY: "To set this up, you'll need to connect **[App Name]** to your agent. Click **Configure** (top right) → Integrations → connect [App Name]. Once connected, come back and I'll create this task for you immediately."

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
        const AGENT_MODEL_NAME = 'google/gemini-3-flash-preview';
        let totalPromptTokens = 0, totalCompletionTokens = 0;

        function trackCall(msg) {
            if (!msg) return;
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
            if (composioApps.length > 0) {
                toolDefs.push(COMPOSIO_SEARCH_TOOL_DEF);
                toolDefs.push(COMPOSIO_MULTI_EXECUTE_TOOL_DEF);
            }

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

            // Track Composio tools discovered via search this turn — used to validate MULTI_EXECUTE_TOOL calls.
            // The LLM cannot bypass discovery by guessing tool names from training.
            const discoveredComposioTools = new Set();

            for (let step = 0; step < 8 && !cancelled; step++) {
                console.log(`[Chat] Step ${step + 1}: invoking LLM...`);
                let msg;
                try {
                    msg = await llmWithTools.invoke(phase3Messages);
                } catch (e) {
                    console.error('[Chat] LLM invoke failed:', e.message, e.stack?.slice(0, 300));
                    Sentry.captureException(e, {
                        tags: { agent_id: AGENT_ID, phase: 'llm_invoke', step: step + 1 },
                        user: { id: userId },
                        extra: { conversationId, model: AGENT_MODEL_NAME }
                    });
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
                            // Track discovered tool names for MULTI_EXECUTE_TOOL validation.
                            // Do NOT bind them as callable tools — the LLM can only execute Composio
                            // tools via COMPOSIO_MULTI_EXECUTE_TOOL. This prevents bypass, keeps the
                            // per-call tool definitions small, and forces a single validated path.
                            for (const schema of newSchemas) {
                                const tName = schema.function?.name || schema.name;
                                if (tName) discoveredComposioTools.add(tName);
                            }
                            console.log(`[Chat] COMPOSIO_SEARCH_TOOLS found ${newSchemas.length} tools — schemas returned to LLM, not bound`);
                            const planGuidance = searchRes.data.planGuidance || [];
                            result = JSON.stringify({
                                found: newSchemas.length,
                                // Full schemas (name + description + parameters) so the LLM can build
                                // schema-correct calls via COMPOSIO_MULTI_EXECUTE_TOOL.
                                tools: newSchemas.map(t => ({
                                    name: t.function?.name || t.name,
                                    description: t.function?.description,
                                    parameters: t.function?.parameters
                                })),
                                ...(planGuidance.length > 0 && { planGuidance }),
                                message: newSchemas.length > 0
                                    ? `Found ${newSchemas.length} tools. Each tool's name, description, and parameter schema is in the "tools" field. Call them via COMPOSIO_MULTI_EXECUTE_TOOL using the exact name and schema-correct params. Tools are NOT bound directly — MULTI_EXECUTE_TOOL is the only execution path.`
                                    : 'No tools found. Re-think the request, decompose into sub-goals, and search again with different terms.'
                            });
                        } else if (tc.name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
                            const steps = tc.args?.steps || [];
                            // Validate: every step must reference a tool discovered via COMPOSIO_SEARCH_TOOLS this turn.
                            // Prevents the LLM from guessing tool names from training memory.
                            const undiscovered = steps
                                .map((s, idx) => ({ idx: idx + 1, tool: s.tool }))
                                .filter(s => s.tool && !discoveredComposioTools.has(s.tool));

                            if (undiscovered.length > 0) {
                                console.warn(`[Chat] COMPOSIO_MULTI_EXECUTE_TOOL rejected — undiscovered tools: ${undiscovered.map(u => u.tool).join(', ')}`);
                                result = JSON.stringify({
                                    rejected: true,
                                    reason: 'One or more tools were not discovered via COMPOSIO_SEARCH_TOOLS in this turn.',
                                    undiscoveredTools: undiscovered,
                                    requiredAction: 'Call COMPOSIO_SEARCH_TOOLS first with queries describing what each undiscovered tool does. Read the returned schemas (parameter names and types) carefully, then retry COMPOSIO_MULTI_EXECUTE_TOOL using only discovered tools and schema-correct params.',
                                    discoveredSoFar: [...discoveredComposioTools]
                                });
                            } else {
                                const multiRes = await axios.post(
                                    `${BACKEND_GATEWAY_URL}/api/greta/gateway/composio/multi-execute`,
                                    { agentId: AGENT_ID, userId, steps },
                                    { headers: { 'x-gateway-signature': gatewaySignature } }
                                );
                                result = multiRes.data.success
                                    ? JSON.stringify(multiRes.data.results)
                                    : `Error: ${multiRes.data.error}`;
                            }
                        } else {
                            result = await executeExternalTool(tc);
                        }
                        // Central shaping — strips email headers, MIME parts, ARC sigs, and other
                        // tool-response bloat before the result enters the LLM context. Applies to
                        // ALL paths (MULTI_EXECUTE_TOOL, direct Composio calls, MCP, orchestration).
                        // shapeToolResult is a no-op for small results, so it's safe everywhere.
                        phase3Messages.push({ role: 'tool', tool_call_id: tc.id, content: shapeToolResult(result) });
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

        console.log(`[Chat] Sending done — cancelled:${cancelled} finalText:"${cleanText.slice(0, 100)}" (${cleanText.length} chars)`);
        console.log(`[Chat] Tokens: ${totalPromptTokens}in/${totalCompletionTokens}out`);
        if (cleanText) emit({ type: 'chunk', content: cleanText });
        emit({
            type: 'done',
            response: cleanText,
            conversationId,
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
        Sentry.captureException(error, {
            tags: { agent_id: AGENT_ID, endpoint: 'chat' },
            user: { id: userId },
            extra: { conversationId, messagePreview: message?.slice(0, 200) }
        });
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
