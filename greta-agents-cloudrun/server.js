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
    req.on('close', () => { cancelled = true; });

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
        } else {
            // Load Composio tools
            if (composioApps.length > 0) {
                const cacheKey = composioApps.slice().sort().join(',');
                if (toolsCache && toolsCacheKey === cacheKey) {
                    toolDefs.push(...toolsCache);
                    console.log(`[Chat] Using cached Composio tools (${toolsCache.length})`);
                } else {
                    try {
                        const composioDefs = [];
                        const toolResults = await Promise.allSettled(
                            composioApps.map(app =>
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
                            } else {
                                console.error(`[Chat] Failed tools for ${composioApps[i]}:`, toolResults[i].reason?.message);
                            }
                        }
                        toolsCache = composioDefs;
                        toolsCacheKey = cacheKey;
                        toolDefs.push(...composioDefs);
                        console.log(`[Chat] Loaded ${composioDefs.length} Composio tools`);
                    } catch (e) {
                        console.error('[Chat] Failed to load Composio tools:', e.message);
                    }
                }
            }

            // Load MCP tools via gateway — cached for 10 minutes per container lifetime
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
                        console.log(`[Chat] Loaded ${mcpDefs.length} MCP tools (cached)`);
                    } catch (e) {
                        console.error('[Chat] Failed to load MCP tools:', e.message);
                    }
                }
            }
        }

        let systemPrompt;
        if (isOnboarding) {
            systemPrompt = getOnboardingPrompt();
        } else {
            const now = new Date();
            const currentDateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            const currentTimeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
            const memorySection = currentMemory ? `\n\n## What you remember about this user\n${currentMemory}` : '';
            const appsSection = composioApps.length > 0 ? `\n\n## Connected apps\n${composioApps.join(', ')}` : '';
            const mcpSection = mcpEnabled && mcpServers.filter(s => s.enabled !== false).length > 0
                ? `\n\n## MCP servers\n${mcpServers.filter(s => s.enabled !== false).map(s => s.name).join(', ')}`
                : '';
            systemPrompt = `You are ${agentName}.

${coreInstructions}

## Current date and time
Today is ${currentDateStr} at ${currentTimeStr}. Always use this when working with dates, calendars, or time-sensitive tasks.
${memorySection}${appsSection}${mcpSection}

## Tool use rules
- When you need data or need to perform an action, call the tool immediately. Do not describe what you are about to do.
- Use the exact tool name as provided. Never invent tool names or write tool calls as text.
- After a tool returns, you MUST ALWAYS write a text response to the user. NEVER go silent or return empty content.
- After a tool returns, use the result to answer. Do not re-call the same tool unless the result was an error.
- If a tool fails, report the error in one sentence and stop.
- IMPORTANT: Every message must end with a text response to the user. Tool calls alone are not valid responses.

## Response style
- No filler openers: "Certainly!", "Of course!", "Great question!" — start with the answer.
- Match the user's register. Short message → short reply. Detailed question → thorough answer.
- Use markdown only when it helps. Plain prose otherwise.
- Never end with "Is there anything else I can help you with?" or similar.`;
        }

        const messages = [
            new SystemMessage(systemPrompt),
            ...history.map(m => m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)),
            new HumanMessage(message)
        ];

        const llm = createOpenRouterLLM({ temperature: 0.2 });
        const llmWithTools = toolDefs.length > 0 ? llm.bindTools(toolDefs) : llm;

        async function executeTool(toolCall) {
            const localTool = selfConfigToolInstances.find(t => t.name === toolCall.name);
            if (localTool) return String(await localTool.invoke(toolCall.args));

            // MCP tools are prefixed mcp_ — route to MCP gateway endpoint
            if (toolCall.name.startsWith('mcp_')) {
                try {
                    const mcpRes = await axios.post(
                        `${BACKEND_GATEWAY_URL}/api/greta/gateway/mcp/execute`,
                        { agentId: AGENT_ID, userId, toolName: toolCall.name, args: toolCall.args },
                        { headers: { 'x-gateway-signature': gatewaySignature } }
                    );
                    return mcpRes.data.success
                        ? (typeof mcpRes.data.result === 'string' ? mcpRes.data.result : JSON.stringify(mcpRes.data.result))
                        : `Error: ${mcpRes.data.error}`;
                } catch (e) { return `Tool failed: ${e.message}`; }
            }

            const doExec = async () => axios.post(
                `${BACKEND_GATEWAY_URL}/api/greta/gateway/composio/execute`,
                { agentId: AGENT_ID, userId, action: toolCall.name, params: toolCall.args },
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

        function extractText(response) {
            if (typeof response.content === 'string') return response.content;
            if (Array.isArray(response.content))
                return response.content.filter(p => p.type === 'text').map(p => p.text).join('');
            return '';
        }

        let finalText = '';
        let toolsExecuted = false;

        for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
            let response;
            try {
                response = await llmWithTools.invoke(messages);
            } catch (e) {
                console.error('[Chat] LLM invoke failed:', e.message);
                break;
            }

            const text = extractText(response);
            const hasTools = response.tool_calls?.length > 0;
            const isUseless = !text || /^done\.?$/i.test(text.trim());
            const isApologyWithoutAction = !hasTools && toolDefs.length > 0 &&
                /sorry|wasn.t able|unable|can.t|cannot|having trouble|apologize|don.t have access|no access/i.test(text);
            const isPromiseWithoutAction = !hasTools && toolDefs.length > 0 &&
                /^(I.ll|I will|let me|I.m going to|I.m checking|I.m fetching|I.m looking|I.m accessing|Sure|Of course|Certainly)/i.test(text.trim());

            console.log(`[Chat] Attempt ${attempt + 1} — text: "${text.slice(0, 100)}", tool_calls: ${response.tool_calls?.length ?? 0}`);
            messages.push(response);

            if (!hasTools) {
                if ((isUseless || isApologyWithoutAction || isPromiseWithoutAction) && toolDefs.length > 0 && attempt < 2) {
                    console.log(`[Chat] LLM skipped tools (attempt ${attempt + 1}) — retrying`);
                    messages.pop();
                    const toolNames = toolDefs.slice(0, 5).map(t => t.function?.name || t.name).join(', ');
                    messages[0] = new SystemMessage(
                        systemPrompt +
                        `\n\nCRITICAL: You MUST call one of your tools to answer this. Available: ${toolNames}... Do not respond with text alone. Call a tool now.`
                    );
                    continue;
                }
                finalText = text;
                break;
            }

            const toolResults = await Promise.all(
                response.tool_calls.map(async (tc) => {
                    emit({ type: 'status', content: toolStatusLabel(tc.name) });
                    try {
                        return { tc, result: await executeTool(tc) };
                    } catch (e) {
                        return { tc, result: `Tool failed: ${e.message}` };
                    }
                })
            );
            for (const { tc, result } of toolResults) {
                messages.push(new ToolMessage({ tool_call_id: tc.id, content: result }));
            }
            toolsExecuted = true;

            const afterResponse = await llm.invoke(messages);
            const afterText = extractText(afterResponse).trim();
            if (afterText && !/^done\.?$/i.test(afterText)) {
                finalText = afterText;
            } else {
                messages.push(afterResponse);
            }
            break;
        }

        if ((!finalText || /^done\.?$/i.test(finalText.trim())) && toolsExecuted && !cancelled) {
            const toolMsgs = messages.filter(m => m instanceof ToolMessage);
            if (toolMsgs.length > 0) {
                try {
                    const toolResultsText = toolMsgs.map(m => String(m.content)).join('\n---\n');
                    const synthResponse = await createOpenRouterLLM({ temperature: 0 }).invoke([
                        new SystemMessage('Summarize these tool results as a clear helpful response. Be direct, no filler.'),
                        new HumanMessage(`User said: "${message}"\n\nTool results:\n${toolResultsText}`)
                    ]);
                    finalText = extractText(synthResponse).trim();
                } catch (e) {
                    console.error('[Chat] Synthesis failed:', e.message);
                }
            }
        }

        const cleanText = finalText
            .replace(/\[[\w_]+\([^)]*\)\]/g, '')
            .replace(/```tool_code[\s\S]*?```/g, '')
            .trim();

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
