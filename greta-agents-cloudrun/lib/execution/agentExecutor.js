const axios = require('axios');
const Sentry = require('@sentry/node');
const { createOpenRouterLLM } = require('../llm/openRouterService');
const { createMongoQueryTool } = require('../tools/mongoQueryTool');
const { createOrchestrationTools } = require('../tools/agentOrchestrationTools');
const { SystemMessage, HumanMessage, ToolMessage, AIMessage } = require('@langchain/core/messages');

const GET_CURRENT_TIME_TOOL = {
    type: 'function',
    function: {
        name: 'get_current_time',
        description: "Returns the current date and time. Call this when you need today's date, current time, or day of the week.",
        parameters: { type: 'object', properties: {}, required: [] },
    },
};

// task_complete is the ONLY way to end a task. Text without this tool call is ignored —
// the loop will nudge once, then terminate. This eliminates "is it done?" guesswork.
const TASK_COMPLETE_TOOL = {
    type: 'function',
    function: {
        name: 'task_complete',
        description: `Call this tool ONCE when the task is fully completed. This is the ONLY way to signal completion — plain text responses without this tool call will be treated as "paused" and you will be asked to continue.

Call task_complete when:
- All steps from the task prompt have been executed
- All items have been processed (e.g. all unread emails handled, all PRs checked)
- No more meaningful actions remain
- An unrecoverable blocker means the task cannot proceed (explain in summary)

Provide a brief 1-2 sentence summary of what was done.`,
        parameters: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'Brief summary of work completed (1-2 sentences)' },
                itemsProcessed: { type: 'number', description: 'Optional count of items processed (emails, messages, records, etc.)' }
            },
            required: ['summary']
        }
    }
};

// Strip noisy fields from tool responses (email headers, MIME parts, raw bodies, etc.)
// before they enter the LLM context. Without this, Gmail/Slack tool results explode
// the context to >1M tokens within a few iterations.
const NOISY_FIELD_NAMES = new Set([
    'headers', 'parts', 'raw', 'attachmentlist', 'mimetype', 'display_url',
    'arc-seal', 'arc-message-signature', 'arc-authentication-results',
    'dkim-signature', 'received', 'x-received', 'x-google-smtp-source',
    'authentication-results', 'message-id', 'received-spf', 'x-gm-message-state'
]);
const MAX_STRING_LEN = 1500;
const MAX_ARRAY_LEN = 10;
const MAX_DEPTH = 10;
const MAX_RESULT_LEN = 10000;

function shapeToolResult(rawResult) {
    if (typeof rawResult !== 'string') return rawResult;
    if (rawResult.length < 3000) return rawResult;

    let parsed;
    try { parsed = JSON.parse(rawResult); }
    catch { return rawResult.slice(0, MAX_RESULT_LEN) + '\n... [truncated]'; }

    function clean(obj, depth = 0) {
        if (depth > MAX_DEPTH) return '[depth limit]';
        if (Array.isArray(obj)) {
            const limited = obj.slice(0, MAX_ARRAY_LEN).map(v => clean(v, depth + 1));
            if (obj.length > MAX_ARRAY_LEN) limited.push(`[+${obj.length - MAX_ARRAY_LEN} more items truncated]`);
            return limited;
        }
        if (obj && typeof obj === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(obj)) {
                if (NOISY_FIELD_NAMES.has(k.toLowerCase())) continue;
                if (typeof v === 'string' && v.length > MAX_STRING_LEN) {
                    out[k] = v.slice(0, MAX_STRING_LEN) + '...[truncated]';
                } else {
                    out[k] = clean(v, depth + 1);
                }
            }
            return out;
        }
        return obj;
    }

    const shaped = JSON.stringify(clean(parsed));
    return shaped.length > MAX_RESULT_LEN ? shaped.slice(0, MAX_RESULT_LEN) + '...[truncated]' : shaped;
}

// COMPOSIO_SEARCH_TOOLS: AI-powered semantic search via Composio's session.search() API.
// Use when the pre-loaded tools don't include what you need (e.g. a specific GitHub action
// beyond the top-50 pre-loaded). Returns additional tool schemas injected into the active tool set.
const COMPOSIO_SEARCH_TOOL_DEF = {
    type: 'function',
    function: {
        name: 'COMPOSIO_SEARCH_TOOLS',
        description: 'Find additional tools not in your current tool set. Use when you need a specific action that is not available in the tools you already have. Composio AI searches semantically and returns the matching tool schemas — you can call them immediately after.',
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

function executeGetCurrentTime() {
    const now = new Date();
    return JSON.stringify({
        date: now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }),
        iso: now.toISOString(),
    });
}

const triggerToolsCacheMap = new Map();
const TRIGGER_TOOLS_CACHE_TTL_MS = 30 * 60 * 1000;
const AGENT_CONFIG_TTL_MS = 5 * 60 * 1000; // 5 minutes — picks up new integrations without restart

class AgentExecutor {
    constructor({ agentId, userId, backendGatewayUrl, gatewaySignature }) {
        this.agentId = agentId;
        this.userId = userId;
        this.backendGatewayUrl = backendGatewayUrl;
        this.gatewaySignature = gatewaySignature;
        this.agentConfig = null;
        console.log(`[AgentExecutor] Initialized for agent ${agentId}`);
    }

    async execute({ trigger, payload = {}, headers = {}, gatewaySignature, projectMongoUrl = null }) {
        console.log(`[AgentExecutor] Executing trigger: ${trigger.name} (${trigger.type})`);
        const startTime = Date.now();

        if (gatewaySignature) this.gatewaySignature = gatewaySignature;

        try {
            const agent = await this.loadAgentConfig();
            const userPrompt = this.buildPrompt(trigger, payload, headers);
            console.log(`[AgentExecutor] Prompt: "${userPrompt.substring(0, 200)}"`);

            // Prefer trigger-level app list (only apps this task actually needs).
            // Fall back to agent-level list for older triggers that predate this field.
            const appsToLoad = (trigger.composioApps?.length > 0) ? trigger.composioApps : (agent.composioApps || []);
            // Pure on-demand: no Composio pre-load. COMPOSIO_SEARCH_TOOLS is injected into
            // the tool list so the LLM discovers and loads tool schemas at runtime.
            const mcpToolDefs = await this.loadMCPTools(agent);

            // Self-orchestration tools — always available for trigger execution
            const orchestration = createOrchestrationTools({
                agentId: this.agentId,
                userId: this.userId,
                backendGatewayUrl: this.backendGatewayUrl,
                getSignature: () => this.gatewaySignature,
            });

            const toolDefs = [...mcpToolDefs, ...orchestration.toolDefs];

            const localTools = new Map();
            for (const td of orchestration.toolDefs) {
                localTools.set(td.function.name, (args) => orchestration.executeOrchestrationTool(td.function.name, args));
            }

            if (projectMongoUrl) {
                const mongoTool = createMongoQueryTool(projectMongoUrl);
                toolDefs.push(mongoTool.toolDef);
                localTools.set('mongo_query', mongoTool.execute);
                console.log(`[AgentExecutor] mongo_query tool injected`);
            }

            console.log(`[AgentExecutor] ${toolDefs.length} tools ready (incl. ${mcpToolDefs.length} MCP, ${orchestration.toolDefs.length} orchestration)`);

            // Pass appsToLoad so system prompt reflects the actual tools available this run
            const systemPrompt = this.buildSystemPrompt(agent, { projectMongoUrl, appsToLoad });
            const { output, tokenUsage, composioCallCount } = await this.runAgentLoop({
                systemPrompt,
                userPrompt,
                toolDefs,
                localTools,
                // GATE 1: pre-flight check inside the Composio dispatch — only the apps
                // in this list can reach the Composio gateway. Trigger-level whitelist
                // overrides the broader agent list (a task only needs what its prompt asks for).
                connectedComposioApps: appsToLoad,
            });

            const executionTime = Date.now() - startTime;
            console.log(`[AgentExecutor] ✅ Completed in ${executionTime}ms`);
            return { output, executionTime, success: true, tokenUsage, composioCallCount };

        } catch (error) {
            const executionTime = Date.now() - startTime;
            console.error(`[AgentExecutor] ❌ Failed after ${executionTime}ms:`, error.message);
            throw error;
        }
    }

    async loadMCPTools(agent) {
        if (!agent.mcpEnabled || !agent.mcpServers?.filter(s => s.enabled !== false).length) return [];
        try {
            const res = await axios.post(
                `${this.backendGatewayUrl}/api/greta/gateway/mcp/tools`,
                { agentId: this.agentId, userId: this.userId },
                { headers: { 'x-gateway-signature': this.gatewaySignature } }
            );
            const defs = res.data.success ? (res.data.tools || []) : [];
            console.log(`[AgentExecutor] MCP tools loaded: ${defs.length}`);
            return defs;
        } catch (e) {
            console.error('[AgentExecutor] MCP tools failed:', e.message);
            return [];
        }
    }

    async loadTools(composioApps) {
        if (!composioApps.length) return [];

        const cacheKey = composioApps.slice().sort().join(',');
        const cached = triggerToolsCacheMap.get(cacheKey);
        const now = Date.now();

        if (cached && now < cached.expiresAt) {
            console.log(`[AgentExecutor] Using cached tools (${cached.tools.length}) for [${cacheKey}]`);
            return [...cached.tools];
        }

        const results = await Promise.allSettled(
            composioApps.map(app =>
                axios.post(
                    `${this.backendGatewayUrl}/api/greta/gateway/composio/tools`,
                    { agentId: this.agentId, userId: this.userId, apps: [app] },
                    { headers: { 'x-gateway-signature': this.gatewaySignature } }
                )
            )
        );

        const toolDefs = [];
        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'fulfilled' && results[i].value.data.success) {
                toolDefs.push(...results[i].value.data.tools);
                console.log(`[AgentExecutor] Loaded ${results[i].value.data.tools.length} tools for ${composioApps[i]}`);
            } else {
                console.error(`[AgentExecutor] Failed tools for ${composioApps[i]}:`, results[i].reason?.message);
            }
        }

        triggerToolsCacheMap.set(cacheKey, { tools: toolDefs, expiresAt: now + TRIGGER_TOOLS_CACHE_TTL_MS });
        if (triggerToolsCacheMap.size > 10) {
            const oldest = [...triggerToolsCacheMap.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
            triggerToolsCacheMap.delete(oldest[0]);
        }

        return toolDefs;
    }

    async runAgentLoop({ systemPrompt, userPrompt, toolDefs, localTools = new Map(), connectedComposioApps = [] }) {
        const llm = createOpenRouterLLM({ temperature: 0 });
        // Mutable: COMPOSIO_SEARCH_TOOLS injects discovered schemas at runtime and rebinds.
        // task_complete is always present — the agent MUST call it to end the task.
        let dynamicTools = [GET_CURRENT_TIME_TOOL, TASK_COMPLETE_TOOL, ...toolDefs, COMPOSIO_SEARCH_TOOL_DEF];
        let llmWithTools = dynamicTools.length > 0 ? llm.bindTools(dynamicTools) : llm;
        const AGENT_MODEL_NAME = 'google/gemini-3-flash-preview';
        let totalPromptTokens = 0, totalCompletionTokens = 0;
        // Honesty + pre-flight trackers (parity with chat path).
        // - composioExecuteAttempted: any Composio tool was called this run
        // - composioExecuteSucceeded: at least one Composio call returned ok
        // - failedComposioApps: apps the model tried whose execute path failed
        //   (used in the truthful summary the HONESTY GUARDRAIL writes).
        let composioExecuteAttempted = false;
        let composioExecuteSucceeded = false;
        let composioCallCount = 0;
        const failedComposioApps = new Set();
        const connectedAppsUpper = new Set((connectedComposioApps || []).map(a => String(a).toUpperCase()));
        function trackCall(msg) {
            if (!msg) return;
            const u = msg.usage_metadata || msg.response_metadata?.tokenUsage || msg.response_metadata?.usage;
            if (!u) return;
            totalPromptTokens     += u.input_tokens  || u.promptTokens  || u.prompt_tokens  || 0;
            totalCompletionTokens += u.output_tokens || u.completionTokens || u.completion_tokens || 0;
        }

        const messages = [
            new SystemMessage(systemPrompt),
            new HumanMessage(userPrompt)
        ];

        // Tracks consecutive failures per tool name within this run.
        // After 2 failures the tool gets a TOOL_UNAVAILABLE response so the LLM stops retrying it.
        const toolFailureCount = new Map();

        const executeTool = async (tc) => {
            // LangChain format: tc.name / tc.args (already parsed object)
            const name = tc.name;
            const args = tc.args || {};

            if (name === 'get_current_time') return executeGetCurrentTime();

            // COMPOSIO_SEARCH_TOOLS: session.search() → slugs → load schemas → inject into tool set
            if (name === 'COMPOSIO_SEARCH_TOOLS') {
                try {
                    const res = await axios.post(
                        `${this.backendGatewayUrl}/api/greta/gateway/composio/meta/search`,
                        { agentId: this.agentId, userId: this.userId, queries: args.queries || [] },
                        { headers: { 'x-gateway-signature': this.gatewaySignature } }
                    );
                    if (!res.data.success) return `Search failed: ${res.data.error}`;
                    const newSchemas = res.data.tools || [];
                    const added = [];
                    for (const schema of newSchemas) {
                        const toolName = schema.function?.name || schema.name;
                        if (toolName && !dynamicTools.find(d => (d.function?.name || d.name) === toolName)) {
                            dynamicTools.push(schema);
                            added.push(toolName);
                        }
                    }
                    if (added.length > 0) {
                        llmWithTools = llm.bindTools(dynamicTools);
                        console.log(`[AgentExecutor] COMPOSIO_SEARCH_TOOLS injected ${added.length} tools: ${added.slice(0, 5).join(', ')}`);
                    }
                    return JSON.stringify({
                        found: newSchemas.length,
                        tools: newSchemas.map(t => t.function?.name || t.name),
                        message: newSchemas.length > 0
                            ? `Found ${newSchemas.length} tools. They are now available — call them directly by name.`
                            : 'No tools found for this query. Try the tools already in your tool set.'
                    });
                } catch (e) { return `COMPOSIO_SEARCH_TOOLS failed: ${e.message}`; }
            }

            if (localTools.has(name)) {
                try { return JSON.stringify(await localTools.get(name)(args)); }
                catch (e) { return `Tool failed: ${e.message}`; }
            }
            if (name.startsWith('mcp_')) {
                try {
                    const res = await axios.post(
                        `${this.backendGatewayUrl}/api/greta/gateway/mcp/execute`,
                        { agentId: this.agentId, userId: this.userId, toolName: name, args },
                        { headers: { 'x-gateway-signature': this.gatewaySignature } }
                    );
                    return res.data.success
                        ? (typeof res.data.result === 'string' ? res.data.result : JSON.stringify(res.data.result))
                        : `Error: ${res.data.error}`;
                } catch (e) { return `Tool failed: ${e.message}`; }
            }
            // Catch-all path — direct Composio tool call. Every Composio tool name
            // begins APPNAME_VERB_OBJECT, so the prefix tells us which app this needs.
            // GATE 1: reject calls for apps the agent isn't connected to. Returns a
            // structured error the model can convert into a truthful task_complete.
            const appPrefix = String(name).split('_')[0].toUpperCase();
            if (connectedAppsUpper.size > 0 && !connectedAppsUpper.has(appPrefix)) {
                failedComposioApps.add(appPrefix);
                console.warn(`[AgentExecutor] GATE 1 — rejected ${name}: ${appPrefix} not in connected apps`);
                return JSON.stringify({
                    success: false,
                    rejected: true,
                    reason: `${appPrefix} is not connected to this agent. You cannot execute ${name} or any other ${appPrefix}_* tool until the user connects ${appPrefix}.`,
                    requiredAction: `Stop trying other tools for ${appPrefix}. Call task_complete with summary: "Cannot complete — ${appPrefix} is not connected for this agent."`,
                });
            }
            composioExecuteAttempted = true;
            composioCallCount += 1;
            try {
                const res = await axios.post(
                    `${this.backendGatewayUrl}/api/greta/gateway/composio/execute`,
                    { agentId: this.agentId, userId: this.userId, action: name, params: args },
                    { headers: { 'x-gateway-signature': this.gatewaySignature } }
                );
                if (res.data.success) {
                    composioExecuteSucceeded = true;
                    return JSON.stringify(res.data.data);
                }
                failedComposioApps.add(appPrefix);
                const failures = (toolFailureCount.get(name) || 0) + 1;
                toolFailureCount.set(name, failures);
                if (failures >= 2) {
                    return `TOOL_UNAVAILABLE: "${name}" is not available for this user (failed ${failures} times). Do not call this tool again. Use only tools that have succeeded or find an alternative.`;
                }
                return `Error: ${res.data.error}`;
            } catch (e) {
                failedComposioApps.add(appPrefix);
                const failures = (toolFailureCount.get(name) || 0) + 1;
                toolFailureCount.set(name, failures);
                if (failures >= 2) {
                    return `TOOL_UNAVAILABLE: "${name}" is not available for this user (failed ${failures} times). Do not call this tool again.`;
                }
                return `Tool failed: ${e.message}`;
            }
        };

        let nudgeCount = 0;
        let toolsCalledCount = 0;

        // 20 steps for trigger execution — complex multi-step workflows (e.g. check email
        // thread state → decide action → send reply → update watch state → schedule follow-up)
        // routinely need 12-15 steps when processing multiple items.
        for (let step = 0; step < 20; step++) {
            // Fix 4: defensive wrap — LLM invocation must never crash the agent loop.
            // Network errors, content filter, rate limits, and 400 token-limit errors all surface here.
            let msg;
            try {
                msg = await llmWithTools.invoke(messages);
            } catch (err) {
                console.error(`[AgentExecutor] LLM invoke failed at step ${step + 1}:`, err.message);
                Sentry.captureException(err, {
                    tags: { agent_id: this.agentId, phase: 'llm_invoke_executor', step: step + 1 },
                    user: { id: this.userId },
                    extra: { model: AGENT_MODEL_NAME, totalPromptTokens, totalCompletionTokens }
                });
                const tokenUsage = { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, model: AGENT_MODEL_NAME };
                return { output: `Task failed at step ${step + 1}: ${err.message || 'LLM error'}`, tokenUsage, composioCallCount, failed: true };
            }
            if (!msg || typeof msg !== 'object') {
                console.error(`[AgentExecutor] LLM returned invalid response at step ${step + 1}`);
                const tokenUsage = { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, model: AGENT_MODEL_NAME };
                return { output: `Task failed at step ${step + 1}: invalid LLM response`, tokenUsage, composioCallCount, failed: true };
            }
            trackCall(msg);
            messages.push(msg);

            const text = typeof msg.content === 'string' ? msg.content : '';
            const toolCalls = msg.tool_calls || [];
            console.log(`[AgentExecutor] Step ${step + 1} — tools:${toolCalls.length} text:"${text.substring(0, 80)}"`);

            // Fix 3: task_complete is the explicit completion signal. If the agent calls it,
            // we stop immediately and return its summary. No nudging, no guessing.
            const completionCall = toolCalls.find(tc => tc.name === 'task_complete');
            if (completionCall) {
                let summary = completionCall.args?.summary || text || 'Task completed.';
                const itemsProcessed = completionCall.args?.itemsProcessed;

                // HONESTY GUARDRAIL — the worst failure mode for autonomous tasks is
                // claiming success when nothing actually happened. No human is watching;
                // the lie reaches credit deduction + the run-history UI as if the work
                // succeeded. If the model attempted Composio work but nothing succeeded,
                // and the summary contains success language, rewrite it truthfully.
                if (composioExecuteAttempted && !composioExecuteSucceeded) {
                    const SUCCESS_CLAIM_RE = /\b(scheduled|sent|posted|created|added|booked|invited|emailed|messaged|delivered|done|completed|set ?up|all set)\b/i;
                    if (SUCCESS_CLAIM_RE.test(summary)) {
                        const apps = [...failedComposioApps];
                        const appList = apps.length ? apps.join(', ') : 'the required app';
                        console.warn(`[AgentExecutor] ⚠ HONESTY GUARDRAIL — summary claimed success but no Composio execute succeeded. Apps tried: [${appList}]. Rewriting.`);
                        const wasNotConnected = apps.length > 0 && apps.every(a => !connectedAppsUpper.has(a));
                        summary = wasNotConnected
                            ? `Task did not complete — ${appList} ${apps.length > 1 ? 'are' : 'is'} not connected to this agent. No action was performed.`
                            : `Task did not complete — tool calls to ${appList} all failed. No action was performed. Details in the run logs.`;
                    }
                }

                console.log(`[AgentExecutor] ✓ task_complete called — ${summary.substring(0, 100)}`);
                const tokenUsage = { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, model: AGENT_MODEL_NAME };
                return { output: summary, itemsProcessed, tokenUsage, composioCallCount };
            }

            if (toolCalls.length === 0) {
                const isFailureReport = /payload too large|tool response.*too large|413.*payload/i.test(text);
                if (isFailureReport) throw new Error(text);

                // Fix 3: only ONE nudge — explicitly tell the agent to call task_complete.
                // If it still won't, accept the text and stop. Eliminates the 3-nudge infinite loop.
                if (nudgeCount < 1 && toolsCalledCount > 0 && step < 19) {
                    nudgeCount++;
                    console.log(`[AgentExecutor] Step ${step + 1} — LLM gave text without task_complete, nudging once`);
                    messages.push(new HumanMessage('You must signal completion explicitly. Call task_complete with a summary if you are done, or continue with the next action.'));
                    continue;
                }

                const tokenUsage = { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, model: AGENT_MODEL_NAME };
                console.log(`[AgentExecutor] Tokens: ${totalPromptTokens}in/${totalCompletionTokens}out`);
                return { output: text || 'Task completed.', tokenUsage, composioCallCount };
            }

            console.log(`[AgentExecutor] Executing:`, toolCalls.map(t => t.name).join(', '));
            let successCount = 0;
            const errors = [];
            await Promise.all(
                toolCalls.map(async (tc) => {
                    const rawResult = await executeTool(tc);
                    // Fix 2: shape tool result before pushing to context.
                    // Strips email headers, MIME parts, large arrays, etc. Prevents 1M-token explosion.
                    const result = shapeToolResult(rawResult);
                    messages.push(new ToolMessage({ tool_call_id: tc.id, content: result }));
                    if (result.startsWith('Tool failed:') || result.startsWith('Error:')) {
                        errors.push(`${tc.name}: ${result}`);
                    } else {
                        successCount++;
                    }
                })
            );

            // Do not throw on tool failures — pass errors back to the LLM as ToolMessages
            // so it can recover gracefully. Throwing here crashes /execute → ERR_BAD_RESPONSE
            // → false "dead container" detection → unnecessary redeploy.
            if (successCount > 0 || errors.length > 0) toolsCalledCount++;
        }

        const tokenUsage = { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, model: AGENT_MODEL_NAME };
        console.log(`[AgentExecutor] Tokens: ${totalPromptTokens}in/${totalCompletionTokens}out`);
        return { output: 'Task completed.', tokenUsage, composioCallCount };
    }

    buildPrompt(trigger, payload, headers) {
        switch (trigger.type) {
            case 'SCHEDULED': {
                const basePrompt = trigger.schedule?.runPrompt || `Execute scheduled task: ${trigger.name}`;
                // Inject the last-run timestamp so the agent knows what counts as "new".
                // Without this, every run would re-process all historical emails/records.
                const lastRunAt = trigger.lastRunAt ? new Date(trigger.lastRunAt) : null;
                const sinceNote = lastRunAt
                    ? `\n\n[Run context: This trigger last completed at ${lastRunAt.toISOString()}. Only process emails, messages, events, or records created/received AFTER that timestamp. Use this as your "since" filter to avoid reprocessing data from previous runs.]`
                    : `\n\n[Run context: This is the first run of this trigger. Process all relevant recent data (e.g. last 24 hours or last 7 days as appropriate for the task).]`;
                return basePrompt + sinceNote;
            }

            case 'DB_EVENT': {
                const template = trigger.dbEvent?.runPromptTemplate || `New {{event}} in {{collection}}:\n{{record}}`;
                const record = payload.record || {};
                return template
                    .replace(/\{\{event\}\}/g, payload.event || '')
                    .replace(/\{\{collection\}\}/g, trigger.dbEvent?.collectionName || '')
                    .replace(/\{\{record\}\}/g, JSON.stringify(record, null, 2))
                    .replace(/\{\{records\}\}/g, payload.records ? JSON.stringify(payload.records, null, 2) : '')
                    .replace(/\{\{count\}\}/g, String(payload.count ?? 1))
                    .replace(/\{\{record\.([^}]+)\}\}/g, (match, path) => {
                        const value = path.split('.').reduce((obj, key) => obj?.[key], record);
                        return value !== undefined ? String(value) : match;
                    });
            }

            case 'WEBHOOK_RECEIVED': {
                const template = trigger.webhookReceived?.runPromptTemplate || `Webhook received:\n{{payload}}`;
                return template
                    // Dot-notation first so {{payload.x}} resolves before {{payload}} expands
                    .replace(/\{\{payload\.([^}]+)\}\}/g, (match, path) => {
                        const value = path.split('.').reduce((obj, key) => obj?.[key], payload);
                        return value !== undefined ? String(value) : '(not provided)';
                    })
                    .replace(/\{\{payload\}\}/g, JSON.stringify(payload, null, 2))
                    .replace(/\{\{headers\}\}/g, JSON.stringify(headers, null, 2));
            }

            case 'FOLLOWUP': {
                // Agent-created delayed task — instruction is the exact thing to do now.
                // The payload contains everything the agent stored in context when it called create_task.
                const ctx = { ...payload };
                delete ctx.followup; // internal flag — not useful to the agent
                delete ctx.timestamp;
                const ctxStr = Object.keys(ctx).length > 0
                    ? `\n\nContext you stored when scheduling this follow-up:\n${JSON.stringify(ctx, null, 2)}`
                    : '';
                return `${trigger.instruction || trigger.name}${ctxStr}

[Follow-up rules: Complete the specific task above using the context data. If you are waiting for a condition that is not yet met (e.g. no reply received yet), you MAY call create_task again to check later — include the same context so future follow-ups have the same data. Once the full workflow is complete (meeting booked, PR reviewed, etc.), do NOT create another follow-up.]`;
            }

            default:
                return `Trigger "${trigger.name}" fired.\nPayload: ${JSON.stringify(payload, null, 2)}`;
        }
    }

    buildSystemPrompt(agent, { projectMongoUrl = null, appsToLoad = null } = {}) {
        // Timestamp omitted — use get_current_time tool. Keeps the prompt stable
        // for prefix caching across runs of the same trigger.
        const memorySection = agent.memory ? `\n\n## What you remember about this user\n${agent.memory}` : '';
        // Use appsToLoad (the actual tools loaded for this run) so the agent isn't told it has
        // apps it can't actually call. Falls back to the full agent list if not specified.
        const displayApps = (appsToLoad?.length > 0) ? appsToLoad : (agent.composioApps || []);
        const appsSection = displayApps.length > 0 ? `\n\n## Connected apps\n${displayApps.join(', ')}` : '';
        const projectSection = projectMongoUrl
            ? `\n\n## Linked project database\nThis task is connected to a Greta v2 project's MongoDB. Use the \`mongo_query\` tool to read it.\n- "the app", "signups", "users", "orders", "the database" → \`mongo_query\`.\n- Totals → operation="count". Breakdowns → "groupBy". Trends → "timeSeries". Lists → "find". Unique values → "distinct".\n- Always query for real numbers before writing a summary. Never invent or estimate.`
            : '';

        return `You are ${agent.name || 'Assistant'}, running an autonomous task. No user is present — you must complete or fail without asking questions.

${agent.coreInstructions || 'You are a helpful assistant.'}
${memorySection}${appsSection}${projectSection}

## How you work — five invariants

1. **Honesty over confidence.** Only claim work succeeded if its tool returned ok this run. "Done — sent the email" without a successful send is the worst failure mode in autonomous mode: no one is watching, the lie reaches credit deduction and run-history as if it were real. The runtime now rewrites false success summaries — don't lie, and you won't be overruled.

2. **Pre-flight every required app.** Before any Composio work, identify which apps your task needs. If any aren't in your **Connected apps** list above, call task_complete immediately with summary "Cannot complete — [App] is not connected for this agent." Don't search for tools, don't try anyway — the runtime rejects calls to disconnected apps.

3. **No questions, no narration.** There is no one to answer "please tell me…" / "could you share…". There is no one to wait for "let me check…" / "I am going to…". Call tools first; words come only in your final task_complete summary.

4. **task_complete is the only way out.** Plain text without task_complete is treated as paused and the loop nudges you once. Call task_complete when work is done, when no more items remain, or when a hard blocker means you cannot proceed (auth failure, app not connected, API down). Include the failure reason in the summary so the run history is useful.

5. **Dedup and stop.** Use watch_get / watch_set with keys that include item IDs ("handled_email_abc123", "notified_pr_42") to track what you've already processed. After this run's items are handled, call task_complete — do NOT re-fetch "to check if more arrived." The next scheduled run handles new items.

## Tools

- **get_current_time** — today's date / current time. Call first when you need to compute "since last run" or relative dates.
- **COMPOSIO_SEARCH_TOOLS** — find tools by capability. Use Composio's verbs (list / fetch / send / search / get / create / update / delete), not your end-goal phrasing. One call with all queries in the array. Outcome phrases like "unread messages" return 0 results — translate to "list slack conversations" (returns unread_count per channel).
- **After search, call the discovered tools directly by name** (APPNAME_VERB_OBJECT). The runtime routes them through Composio.
- **watch_set(key, value, ttlHours?)** / **watch_get(key)** / **watch_clear(key)** — persistent state between runs. Always set ttlHours for time-bounded items (e.g. 72h for email threads).
- **create_task(instruction, delayMinutes, context?)** — schedule ONE-TIME delayed follow-up ("check back in 24h if no reply"). Never use to recreate the recurring schedule — that's externally managed.${projectMongoUrl ? '\n- **mongo_query** — read the linked project database (see above).' : ''}

## Patterns worth knowing

- **Batch fetches at 10 items max** for "summarize all" / "process all" tasks. Tell the user the sample size in your task_complete summary.
- **Slack "unread"** — no dedicated tool. \`LIST_CONVERSATIONS\` returns unread_count per channel/DM; filter > 0, then fetch.
- **Parallel calls in one step** when tools are independent (e.g. fetch emails AND fetch calendar events).`;
    }

    async loadAgentConfig() {
        if (this.agentConfig && this.agentConfigExpiresAt && Date.now() < this.agentConfigExpiresAt) {
            return this.agentConfig;
        }

        const res = await axios.post(
            `${this.backendGatewayUrl}/api/greta/gateway/agent/config`,
            { agentId: this.agentId, userId: this.userId },
            { headers: { 'x-gateway-signature': this.gatewaySignature } }
        );

        if (!res.data.success) throw new Error(`Failed to load agent config: ${res.data.error}`);
        const agent = res.data.agent;
        agent.composioApps = agent.composioApps || [];
        this.agentConfig = agent;
        this.agentConfigExpiresAt = Date.now() + AGENT_CONFIG_TTL_MS;
        console.log(`[AgentExecutor] Loaded agent config: ${agent.name}`);
        return agent;
    }
}

module.exports = { AgentExecutor, shapeToolResult };
