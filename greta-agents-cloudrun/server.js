const express = require('express');
const axios = require('axios');
const { AgentExecutor } = require('./lib/execution/agentExecutor');
const { HumanMessage, SystemMessage, ToolMessage, AIMessage } = require('@langchain/core/messages');
const { createOpenRouterLLM } = require('./lib/llm/openRouterService');
const { createSelfConfigTools } = require('./lib/tools/selfConfigTools');
const { getOnboardingPrompt } = require('./lib/tools/onboardingPrompt');

const app = express();
app.use(express.json({ limit: '10mb' }));

const AGENT_ID = process.env.AGENT_ID;
const USER_ID = process.env.USER_ID;
const BACKEND_GATEWAY_URL = process.env.BACKEND_GATEWAY_URL || 'https://addons-staging-v2.questera.ai';
const MONGO_CONNECTION_STRING = process.env.MONGO_CONNECTION_STRING;
const POD_TOKEN = process.env.POD_TOKEN;
const PORT = process.env.PORT || 8080;

console.log(`[Container] Starting container for Agent ID: ${AGENT_ID}`);
console.log(`[Container] Backend Gateway: ${BACKEND_GATEWAY_URL}`);

let toolsCache = null;
let toolsCacheKey = null;

let mcpToolsCache = null;
let mcpToolsCacheTime = null;
const MCP_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let gatewaySignature = null;
let signatureExpiry = null;

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
        mongoConnectionString: MONGO_CONNECTION_STRING,
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
        mongodbConfigured: !!MONGO_CONNECTION_STRING,
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
            return res.status(503).json({ success: false, error: 'Agent executor not initialized' });
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
        const appCapabilityHints = {
            GOOGLECALENDAR: 'create/read/update/delete calendar events',
            GMAIL:          'send/read/search/draft emails',
            SLACK:          'send messages, read channels',
            NOTION:         'read/write pages and databases',
            GITHUB:         'read repos, issues, PRs, create issues',
            GOOGLESHEETS:   'read/write spreadsheet data',
            GOOGLEDRIVE:    'read/list files',
            HUBSPOT:        'read/write CRM contacts and deals',
            LINEAR:         'read/write issues and projects',
        };
        const appsSection = composioApps.length > 0
            ? `\n\n## Connected apps (tools available)\n` +
              composioApps.map(a => {
                  const hint = appCapabilityHints[a.toUpperCase()];
                  return hint ? `- ${a}: ${hint}` : `- ${a}`;
              }).join('\n')
            : '';
        const enabledMcpServers = mcpServers.filter(s => s.enabled !== false);
        const mcpSection = mcpEnabled && enabledMcpServers.length > 0
            ? `\n\n## MCP servers\n${enabledMcpServers.map(s => s.name).join(', ')}`
            : '';

        const baseGuidance = `## How to handle missing information — read this carefully
Your goal is to take action with minimal back-and-forth.

**When all required info is present:** Act immediately. No confirmation needed.

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
        let phase3SystemPrompt; // Separate prompt for Phase 3 (no TOOLS_NEEDED instructions!)

        if (isOnboarding) {
            systemPrompt = getOnboardingPrompt();
            phase3SystemPrompt = systemPrompt; // Onboarding uses same prompt
        } else {
            const identityRule = `## Identity
You are ${agentName}, from Greta. When asked who you are or what you can do, introduce yourself as "${agentName}, from Greta" and describe what you can do based on your purpose and connected apps listed above. Never mention or reveal the underlying AI model, company, or technology (do not say "I am a large language model", "trained by Google", "powered by Gemini", etc.).`;

            // Phase 1 prompt: includes TOOLS_NEEDED sentinel instructions
            systemPrompt = `You are ${agentName}.

${coreInstructions}
${memorySection}${appsSection}${mcpSection}

${identityRule}

## Built-in tool available at all times
- **get_current_time**: Returns current date/time. Call this FIRST when you need to know "today", "now", or calculate relative dates like "next week", "tomorrow", "next Monday". Critical for calendar queries.

${baseGuidance}

## How you work
You run in two phases. In the first phase no tools are available.
- If you can answer from knowledge or memory alone — answer directly. This includes: greetings ("hey", "hi", "hello"), casual conversation, questions about yourself or your capabilities, general knowledge questions, anything that does NOT require reading or writing data from a connected app.
- If the user explicitly asks you to DO something with a connected app (send email, create event, check calendar, read emails, post to Slack, check repos, etc.) — respond with ONLY this format and nothing else:
  TOOLS_NEEDED:APP1,APP2
  Where APP1,APP2 are the exact app names from "Connected apps" above that you need.

  CRITICAL: You have access to tools from TWO sources:

  1. **Composio apps** (direct integrations with external services):
     ${composioApps.length > 0 ? composioApps.map(app => `- ${app}: ${appCapabilityHints[app.toUpperCase()] || 'various actions'}`).join('\n     ') : '(none)'}

  2. **MCP servers** (custom tools via Model Context Protocol):
     ${mcpEnabled && enabledMcpServers.length > 0 ? enabledMcpServers.map(s => `- ${s.name}: ${s.description || 'custom tools'}`).join('\n     ') : '(none)'}

  When you need tools, respond with TOOLS_NEEDED followed by a colon and the app/server names:

  FORMAT: TOOLS_NEEDED:APP1,APP2,MCP

  Rules for choosing which apps to list:
  - If the request needs a Composio app listed above, include its EXACT name (e.g., GMAIL, GOOGLECALENDAR, SLACK)
  - If the request needs MCP tools (for ${mcpEnabled && enabledMcpServers.length > 0 ? enabledMcpServers.map(s => s.name).join(', ') : 'custom integrations'}), include "MCP"
  - List ALL apps/servers needed for the request, separated by commas
  - Match keywords to the app descriptions above to determine what's needed

  Examples:
  ${composioApps.includes('GOOGLECALENDAR') ? '- "Create a meeting" → TOOLS_NEEDED:GOOGLECALENDAR\n  ' : ''}${composioApps.includes('GMAIL') && composioApps.includes('GOOGLECALENDAR') ? '- "Draft email and create calendar event" → TOOLS_NEEDED:GMAIL,GOOGLECALENDAR\n  ' : ''}${mcpEnabled && enabledMcpServers.length > 0 ? `- "Use ${enabledMcpServers[0].name}" → TOOLS_NEEDED:MCP\n  ` : ''}${mcpEnabled && composioApps.includes('GMAIL') ? '- "Check MCP tools and latest email" → TOOLS_NEEDED:MCP,GMAIL\n  ' : ''}- If user asks for multiple things from multiple sources, list them all: TOOLS_NEEDED:APP1,APP2,MCP

- NEVER output TOOLS_NEEDED for greetings, casual chat, or questions you can answer directly.
- Never ask "Would you like me to...?", "Shall I...?", "Should I...?". Either answer or output TOOLS_NEEDED.
- CRITICAL: If the user asks for MULTIPLE things from MULTIPLE apps, list ALL the apps needed, separated by commas.

${responseStyle}`;

            // Phase 3 prompt: NO TOOLS_NEEDED instructions (tools already loaded!)
            phase3SystemPrompt = `You are ${agentName}.

${coreInstructions}
${memorySection}${appsSection}${mcpSection}

${identityRule}

## Built-in tool available at all times
- **get_current_time**: Returns current date/time. Call this FIRST when you need to know "today", "now", or calculate relative dates like "next week", "tomorrow", "next Monday". Critical for calendar queries.

${baseGuidance}

## Tool use rules
- NEVER claim an action is done in text if you haven't called the tool for it. "I have drafted an email" without calling GMAIL_CREATE_EMAIL_DRAFT is a lie. If you say it happened, it must have happened via a tool call.
- When the user asks for multiple actions (email + calendar, message + event, etc.), call ALL required tools. You can include multiple tool calls in a single response — do it.
- Call tools silently. Do not narrate what you are about to do before calling.
- Use the exact tool name as provided. Never invent tool names.
- After ALL tools in a step return results, write a single summary response to the user covering everything that was done.
- After a tool returns, use the result to answer. Do not re-call the same tool unless the result was an error.
- If a tool fails, report the error in one sentence and stop.
- If you need an external integration and have no tools for it, tell the user clearly in one sentence.

${responseStyle}`;
        }

        // Phase 1 uses NO history — prevents hallucinating action completions based on
        // previous assistant messages (e.g. "I have drafted an email" without any tool call)
        const phase1Messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message }
        ];

        // Phase 3 (full ReAct loop) uses phase3SystemPrompt (NO TOOLS_NEEDED instructions!)
        // and complete history for context
        const phase3Messages = [
            { role: 'system', content: phase3SystemPrompt },
            ...history.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: message }
        ];

        // History re-run also uses phase3SystemPrompt (for context-aware follow-ups)
        const messagesWithHistory = [
            { role: 'system', content: phase3SystemPrompt },
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
            // ── Phase 1: classification only — no tools, no history ─────────────────
            // Mirrors main backend exactly: single llm.invoke call, no tool binding.
            // LLM outputs TOOLS_NEEDED:APP1,APP2 or answers directly.
            let requestedApps = [];
            let needsMcp = false;

            let p1msg;
            try {
                p1msg = await llm.invoke(phase1Messages);
            } catch (e) { console.error('[Chat] Phase 1 failed:', e.message); }

            const p1text = p1msg ? extractText(p1msg).trim() : '';
            console.log(`[Chat] Phase 1 — "${p1text.slice(0, 100)}"`);

            const sentinelMatch = p1text.match(/^TOOLS_NEEDED(?::([A-Z0-9_,]+))?$/i);
            if (sentinelMatch) {
                if (sentinelMatch[1]) {
                    const parsed = sentinelMatch[1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
                    requestedApps = parsed.filter(a => a !== 'MCP');
                    needsMcp = parsed.includes('MCP');
                }
                console.log(`[Chat] Phase 1 sentinel — apps: [${requestedApps.join(',')}], mcp: ${needsMcp}`);
                // CRITICAL: Do NOT set finalText here! We need to load tools and run Phase 3.
            } else if (p1text) {
                // Direct answer — re-run with full history for context-aware response
                // Use phase3SystemPrompt (NO TOOLS_NEEDED instructions!) to prevent sentinel leakage
                console.log(`[Chat] Phase 1 direct — re-running with history for context`);
                try {
                    const histMsg = await llm.invoke(messagesWithHistory);
                    finalText = extractText(histMsg).trim();
                } catch (e) {
                    finalText = p1text;
                }
            }

            const hasToolsConfigured = composioApps.length > 0 || (mcpEnabled && mcpServers.filter(s => s.enabled !== false).length > 0);

            console.log(`[Chat] After Phase 1 — finalText:"${finalText.slice(0, 50)}", finalText.length:${finalText.length}, hasToolsConfigured:${hasToolsConfigured}`);

            if (!finalText && hasToolsConfigured) {
                // ── Phase 2: Smart tool loading — only apps the LLM asked for ────
                // If sentinel specified apps, load only those. Else load all (fallback).
                const appsToLoad = requestedApps.length > 0
                    ? composioApps.filter(a => requestedApps.includes(a.toUpperCase()))
                    : composioApps;
                const shouldLoadMcp = mcpEnabled && mcpServers.filter(s => s.enabled !== false).length > 0 &&
                    (needsMcp || requestedApps.length === 0); // load MCP in fallback mode too

                console.log(`[Chat] Loading tools for: [${appsToLoad.join(', ')}]${shouldLoadMcp ? ' + MCP' : ''}`);

                if (appsToLoad.length > 0) {
                    // Per-app cache: key is the sorted list of apps actually being loaded
                    const cacheKey = appsToLoad.slice().sort().join(',');
                    if (toolsCache && toolsCacheKey === cacheKey) {
                        toolDefs.push(...toolsCache);
                        console.log(`[Chat] Using cached Composio tools (${toolsCache.length})`);
                    } else {
                        try {
                            const composioDefs = [];
                            const toolResults = await Promise.allSettled(
                                appsToLoad.map(app =>
                                    axios.post(
                                        `${BACKEND_GATEWAY_URL}/api/greta/gateway/composio/tools`,
                                        { agentId: AGENT_ID, userId, apps: [app] },
                                        { headers: { 'x-gateway-signature': gatewaySignature } }
                                    )
                                )
                            );
                            for (let i = 0; i < toolResults.length; i++) {
                                if (toolResults[i].status === 'fulfilled' && toolResults[i].value.data.success) {
                                    composioDefs.push(...toolResults[i].value.data.tools);
                                    console.log(`[Chat] Loaded ${toolResults[i].value.data.tools.length} tools for ${appsToLoad[i]}`);
                                } else {
                                    console.error(`[Chat] Failed tools for ${appsToLoad[i]}:`, toolResults[i].reason?.message);
                                }
                            }
                            toolsCache = composioDefs;
                            toolsCacheKey = cacheKey;
                            toolDefs.push(...composioDefs);
                        } catch (e) {
                            console.error('[Chat] Failed to load Composio tools:', e.message);
                        }
                    }
                }

                if (shouldLoadMcp) {
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
                            console.log(`[Chat] Loaded ${mcpDefs.length} MCP tools (cached)`);
                        } catch (e) {
                            console.error('[Chat] Failed to load MCP tools:', e.message);
                        }
                    }
                }
                console.log(`[Chat] ${toolDefs.length} external tools loaded`);

                // Add get_current_time as a local tool — always available in Phase 3
                toolDefs.push(GET_CURRENT_TIME_TOOL);
                console.log(`[Chat] Added get_current_time tool (${toolDefs.length} total tools)`);

                // ── Phase 3: ReAct loop — mirrors main backend exactly ───────────────
                // Uses LangChain bindTools + invoke — same approach as gretaAgentFunctions.js
                // CRITICAL: Use phase3Messages (with phase3SystemPrompt that has NO TOOLS_NEEDED instructions!)
                console.log(`[Chat] Phase 3 ENTER — cancelled:${cancelled} tools:${toolDefs.length} finalText.length:${finalText.length}`);
                let llmWithTools;
                try {
                    llmWithTools = toolDefs.length > 0 ? llm.bindTools(toolDefs) : llm;
                    console.log('[Chat] Phase 3: tools bound OK');
                } catch (bindErr) {
                    console.error('[Chat] Phase 3 bindTools failed:', bindErr.message);
                    llmWithTools = llm;
                }
                for (let step = 0; step < 8 && !cancelled; step++) {
                    console.log(`[Chat] Phase 3 step ${step + 1}: invoking LLM...`);
                    let msg;
                    try {
                        msg = await llmWithTools.invoke(phase3Messages);
                    } catch (e) {
                        console.error('[Chat] LLM invoke failed:', e.message, e.stack?.slice(0, 300));
                        break;
                    }

                    const text = extractText(msg).trim();
                    // LangChain tool call format: { name, args, id } (not function.name/arguments)
                    const toolCalls = msg.tool_calls || [];

                    // Detect hallucinated action text alongside tool calls
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
                            // Handle local tool: get_current_time
                            if (tc.name === 'get_current_time') {
                                result = executeGetCurrentTime();
                                console.log(`[Chat] get_current_time result: ${result}`);
                            } else {
                                // External tool: Composio or MCP
                                result = await executeExternalTool(tc);
                            }
                            phase3Messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
                            toolsExecuted = true;
                        } catch (e) {
                            phase3Messages.push({ role: 'tool', tool_call_id: tc.id, content: `Tool failed: ${e.message}` });
                        }
                    }));
                    // Loop continues — LLM sees all tool results and decides next action
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
                            finalText = extractText(synthMsg).trim();
                        } catch (e) { console.error('[Chat] Synthesis failed:', e.message); }
                    }
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
        if (cleanText) emit({ type: 'chunk', content: cleanText });
        emit({ type: 'done', response: cleanText, conversationId });
        res.end();

        // Consolidate memory every 10 messages — not every turn.
        // history.length is the number of prior messages before this turn.
        // Adding 2 (user + assistant) gives total turns after this message.
        if (!isOnboarding && (history.length + 2) % 10 === 0) {
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
