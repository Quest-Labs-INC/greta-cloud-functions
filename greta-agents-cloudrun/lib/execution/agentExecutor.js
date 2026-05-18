const axios = require('axios');
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
            const { output, tokenUsage } = await this.runAgentLoop({ systemPrompt, userPrompt, toolDefs, localTools });

            const executionTime = Date.now() - startTime;
            console.log(`[AgentExecutor] ✅ Completed in ${executionTime}ms`);
            return { output, executionTime, success: true, tokenUsage };

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

    async runAgentLoop({ systemPrompt, userPrompt, toolDefs, localTools = new Map() }) {
        const llm = createOpenRouterLLM({ temperature: 0 });
        // Mutable: COMPOSIO_SEARCH_TOOLS injects discovered schemas at runtime and rebinds
        let dynamicTools = [GET_CURRENT_TIME_TOOL, ...toolDefs, COMPOSIO_SEARCH_TOOL_DEF];
        let llmWithTools = dynamicTools.length > 0 ? llm.bindTools(dynamicTools) : llm;
        const AGENT_MODEL_NAME = process.env.AGENT_MODEL || 'google/gemini-2.5-flash';
        let totalPromptTokens = 0, totalCompletionTokens = 0;
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
            try {
                const res = await axios.post(
                    `${this.backendGatewayUrl}/api/greta/gateway/composio/execute`,
                    { agentId: this.agentId, userId: this.userId, action: name, params: args },
                    { headers: { 'x-gateway-signature': this.gatewaySignature } }
                );
                if (res.data.success) return JSON.stringify(res.data.data);
                const failures = (toolFailureCount.get(name) || 0) + 1;
                toolFailureCount.set(name, failures);
                if (failures >= 2) {
                    return `TOOL_UNAVAILABLE: "${name}" is not available for this user (failed ${failures} times). Do not call this tool again. Use only tools that have succeeded or find an alternative.`;
                }
                return `Error: ${res.data.error}`;
            } catch (e) {
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
            const msg = await llmWithTools.invoke(messages);
            trackCall(msg);
            messages.push(msg);

            const text = typeof msg.content === 'string' ? msg.content : '';
            const toolCalls = msg.tool_calls || [];
            console.log(`[AgentExecutor] Step ${step + 1} — tools:${toolCalls.length} text:"${text.substring(0, 80)}"`);

            if (toolCalls.length === 0) {
                const isFailureReport = /payload too large|tool response.*too large|413.*payload/i.test(text);
                if (isFailureReport) throw new Error(text);

                // Allow up to 3 nudges — complex workflows (check new emails + check all pending
                // reply threads + schedule calendar) can legitimately pause multiple times.
                if (nudgeCount < 3 && toolsCalledCount > 0 && step < 19) {
                    nudgeCount++;
                    console.log(`[AgentExecutor] Step ${step + 1} — LLM paused mid-task, nudging (${nudgeCount}/3)`);
                    messages.push(new HumanMessage('Continue with any remaining tasks.'));
                    continue;
                }

                const tokenUsage = { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, model: AGENT_MODEL_NAME };
                console.log(`[AgentExecutor] Tokens: ${totalPromptTokens}in/${totalCompletionTokens}out`);
                return { output: text || 'Task completed.', tokenUsage };
            }

            console.log(`[AgentExecutor] Executing:`, toolCalls.map(t => t.name).join(', '));
            let successCount = 0;
            const errors = [];
            await Promise.all(
                toolCalls.map(async (tc) => {
                    const result = await executeTool(tc);
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
        return { output: 'Task completed.', tokenUsage };
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
        // Timestamp removed — use get_current_time tool instead so system prompt stays stable for caching.
        const memorySection = agent.memory ? `\n\n## What you remember about this user\n${agent.memory}` : '';
        // Use appsToLoad (the actual tools loaded for this run) so the agent isn't told it has
        // apps it can't actually call. Falls back to the full agent list if not specified.
        const displayApps = (appsToLoad?.length > 0) ? appsToLoad : (agent.composioApps || []);
        const appsSection = displayApps.length > 0 ? `\n\n## Connected apps\n${displayApps.join(', ')}` : '';
        const projectSection = projectMongoUrl
            ? `\n\n## Linked project database\nThis task is connected to a Greta v2 project database. You have the \`mongo_query\` tool to read data from it directly.\n- "the app", "signups", "users", "orders", "the database" → use \`mongo_query\`\n- For totals: operation="count". For breakdowns: operation="groupBy". For trends over time: operation="timeSeries". For lists: operation="find". For unique values: operation="distinct".\n- Always call \`mongo_query\` to get real numbers before writing any summary. Never invent or estimate data.`
            : '';

        return `You are ${agent.name || 'Assistant'}.

${agent.coreInstructions || 'You are a helpful assistant.'}
${memorySection}${appsSection}${projectSection}

## Self-orchestration tools always available
- **watch_set(key, value, ttlHours?)** — persist state between runs. Use descriptive keys that include item IDs: "handled_email_abc123", "notified_pr_42". Always set ttlHours for time-bounded state (e.g. 72h for email threads).
- **watch_get(key)** — retrieve previously stored state. Returns {exists: false, value: null} if key was never set or expired.
- **watch_clear(key)** — delete a stored value when a workflow is fully complete (e.g. meeting booked, ticket resolved).
- **create_task(instruction, delayMinutes, context?)** — schedule a ONE-TIME delayed follow-up (e.g. "check back in 24h if they replied to my meeting request email"). NEVER use this to re-schedule the current task — you are already running on a schedule managed externally.

Use watch_set/watch_get to track which items you've already processed. Use create_task only for conditional one-time follow-ups (e.g. waiting for a reply), never to recreate the recurring schedule.

## AUTONOMOUS TASK — CRITICAL RULES
You are running as a background job. There is NO USER present. No one will see your questions or reply to them.

1. NEVER ask a question. There is nobody to answer.
2. NEVER say "please tell me" or "could you share". There is nobody listening.
3. If you need data — use your tools to fetch it RIGHT NOW.
4. ALWAYS complete the task with whatever data is available. If any tool returns zero results, note it briefly and continue with all remaining steps.
5. Call tools immediately. NEVER narrate or describe what you are about to do — just call the tool. Never say "Now I will fetch...", "Next I'll...", "I am going to...", etc. Call first, narrate never.
6. If multiple independent tools are needed (e.g., fetch emails AND fetch calendar events), call ALL of them — you can call them in parallel in the same step.
7. Only write a final response AFTER all tools have been called and all results received.
8. After all tools return, write a clear summary of what was found/done. That summary is the task output.
9. Zero results from a tool is a valid outcome — include it in your summary and keep going. Never abort the whole task because one data source was empty.
10. Only respond with "Task could not complete: [reason]" if a hard infrastructure error (auth failure, API down) makes it impossible to proceed at all.
11. If you have no tools connected and the task requires external integrations, respond with "Task could not complete: no integrations connected for this agent."
12. DEDUPLICATION — for tasks that process items across runs (emails, tickets, records): call watch_get("handled_{type}_{id}") BEFORE acting on each item. If it returns exists:true, skip that item. After successfully acting, immediately call watch_set("handled_{type}_{id}", true, ttlHours?) so future runs don't reprocess it. The [Run context] above tells you what's "new" since the last run — use it as your primary filter, then use watch_get as a safety net for items that fall near the boundary.`;
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

module.exports = { AgentExecutor };
