const axios = require('axios');
const { createOpenRouterLLM, fetchTotalRunCost } = require('../llm/openRouterService');
const { MongoClient } = require('mongodb');
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

function executeGetCurrentTime() {
    const now = new Date();
    return JSON.stringify({
        date: now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }),
        iso: now.toISOString(),
    });
}

let triggerToolsCache = null;
let triggerToolsCacheKey = null;

let db = null;
async function getMongoConnection() {
    if (!db) {
        const url = process.env.MONGO_URL || process.env.MONGO_CONNECTION_STRING;
        if (!url) throw new Error('MONGO_URL not configured');
        const client = await MongoClient.connect(url);
        db = client.db();
        console.log('[AgentExecutor] MongoDB connected');
    }
    return db;
}

class AgentExecutor {
    constructor({ agentId, userId, backendGatewayUrl, gatewaySignature, mongoConnectionString }) {
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
            const cachedToolDefs = await this.loadTools(appsToLoad);
            const mcpToolDefs = await this.loadMCPTools(agent);

            // Self-orchestration tools — always available for trigger execution
            const orchestration = createOrchestrationTools({
                agentId: this.agentId,
                userId: this.userId,
                backendGatewayUrl: this.backendGatewayUrl,
                getSignature: () => this.gatewaySignature,
            });

            // Build final tool list without mutating the cache
            const toolDefs = [...cachedToolDefs, ...mcpToolDefs, ...orchestration.toolDefs];

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

            const systemPrompt = this.buildSystemPrompt(agent, { projectMongoUrl });
            const { output, actualCostUSD, tokenUsage } = await this.runAgentLoop({ systemPrompt, userPrompt, toolDefs, localTools });

            const executionTime = Date.now() - startTime;
            console.log(`[AgentExecutor] ✅ Completed in ${executionTime}ms — cost: $${actualCostUSD}`);
            return { output, executionTime, success: true, actualCostUSD, tokenUsage };

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
        if (triggerToolsCache && triggerToolsCacheKey === cacheKey) {
            console.log(`[AgentExecutor] Using cached tools (${triggerToolsCache.length})`);
            return [...triggerToolsCache];
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

        triggerToolsCache = toolDefs;
        triggerToolsCacheKey = cacheKey;
        return toolDefs;
    }

    async runAgentLoop({ systemPrompt, userPrompt, toolDefs, localTools = new Map() }) {
        const llm = createOpenRouterLLM({ temperature: 0 });
        const allTools = [GET_CURRENT_TIME_TOOL, ...toolDefs];
        const llmWithTools = allTools.length > 0 ? llm.bindTools(allTools) : llm;
        const AGENT_MODEL_NAME = process.env.AGENT_MODEL || 'google/gemini-2.5-flash';
        const generationIds = [];
        // Token fallback — used when OpenRouter generation API returns null
        let totalPromptTokens = 0, totalCompletionTokens = 0;
        function trackCall(msg) {
            if (!msg) return;
            if (msg.id) generationIds.push(msg.id);
            const u = msg.usage_metadata || msg.response_metadata?.tokenUsage || msg.response_metadata?.usage;
            if (!u) return;
            totalPromptTokens     += u.input_tokens  || u.promptTokens  || u.prompt_tokens  || 0;
            totalCompletionTokens += u.output_tokens || u.completionTokens || u.completion_tokens || 0;
        }

        const messages = [
            new SystemMessage(systemPrompt),
            new HumanMessage(userPrompt)
        ];

        const executeTool = async (tc) => {
            // LangChain format: tc.name / tc.args (already parsed object)
            const name = tc.name;
            const args = tc.args || {};

            if (name === 'get_current_time') return executeGetCurrentTime();

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
                return res.data.success ? JSON.stringify(res.data.data) : `Error: ${res.data.error}`;
            } catch (e) { return `Tool failed: ${e.message}`; }
        };

        let nudgedOnce = false;
        let toolsCalledCount = 0;

        for (let step = 0; step < 10; step++) {
            const msg = await llmWithTools.invoke(messages);
            trackCall(msg);
            messages.push(msg);

            const text = typeof msg.content === 'string' ? msg.content : '';
            const toolCalls = msg.tool_calls || [];
            console.log(`[AgentExecutor] Step ${step + 1} — tools:${toolCalls.length} text:"${text.substring(0, 80)}"`);

            if (toolCalls.length === 0) {
                const isFailureReport = /payload too large|tool response.*too large|413.*payload/i.test(text);
                if (isFailureReport) throw new Error(text);

                if (!nudgedOnce && toolsCalledCount > 0 && step < 9) {
                    nudgedOnce = true;
                    console.log(`[AgentExecutor] Step ${step + 1} — LLM stopped mid-task, nudging to continue`);
                    messages.push(new HumanMessage('Continue with any remaining tasks.'));
                    continue;
                }

                const actualCostUSD = await fetchTotalRunCost(generationIds);
                const tokenUsage = { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, model: AGENT_MODEL_NAME };
                console.log(`[AgentExecutor] Cost: $${actualCostUSD} (OpenRouter) | tokens: ${totalPromptTokens}in/${totalCompletionTokens}out | genIds: ${generationIds.length}`);
                return { output: text || 'Task completed.', actualCostUSD, tokenUsage };
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

            if (successCount === 0 && errors.length > 0) {
                throw new Error(`All tool calls failed: ${errors.join('; ')}`);
            }
            toolsCalledCount++;
        }

        const actualCostUSD = await fetchTotalRunCost(generationIds);
        const tokenUsage = { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, model: AGENT_MODEL_NAME };
        console.log(`[AgentExecutor] Cost: $${actualCostUSD} (OpenRouter) | tokens: ${totalPromptTokens}in/${totalCompletionTokens}out | genIds: ${generationIds.length}`);
        return { output: 'Task completed.', actualCostUSD, tokenUsage };
    }

    buildPrompt(trigger, payload, headers) {
        switch (trigger.type) {
            case 'SCHEDULED':
                return trigger.schedule?.runPrompt || `Execute scheduled task: ${trigger.name}`;

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

            case 'FOLLOWUP':
                // Agent-created delayed task — instruction is the exact thing to do now
                return `${trigger.instruction || trigger.name}\n\nContext from when this follow-up was scheduled:\n${JSON.stringify(payload, null, 2)}`;

            default:
                return `Trigger "${trigger.name}" fired.\nPayload: ${JSON.stringify(payload, null, 2)}`;
        }
    }

    buildSystemPrompt(agent, { projectMongoUrl = null } = {}) {
        // Timestamp removed — use get_current_time tool instead so system prompt stays stable for caching.
        const memorySection = agent.memory ? `\n\n## What you remember about this user\n${agent.memory}` : '';
        const appsSection = (agent.composioApps || []).length > 0 ? `\n\n## Connected apps\n${agent.composioApps.join(', ')}` : '';
        const projectSection = projectMongoUrl
            ? `\n\n## Linked project database\nThis task is connected to a Greta v2 project database. You have the \`mongo_query\` tool to read data from it directly.\n- "the app", "signups", "users", "orders", "the database" → use \`mongo_query\`\n- For totals: operation="count". For breakdowns: operation="groupBy". For trends over time: operation="timeSeries". For lists: operation="find". For unique values: operation="distinct".\n- Always call \`mongo_query\` to get real numbers before writing any summary. Never invent or estimate data.`
            : '';

        return `You are ${agent.name || 'Assistant'}.

${agent.coreInstructions || 'You are a helpful assistant.'}
${memorySection}${appsSection}${projectSection}

## Self-orchestration tools always available
- **watch_set(key, value, ttlHours?)** — persist state between runs (track what you're monitoring)
- **watch_get(key)** — retrieve previously stored state
- **watch_clear(key)** — delete state when done monitoring
- **create_task(instruction, delayMinutes, context?)** — schedule a delayed follow-up execution of yourself

Use these when you need to: remember something across runs, avoid duplicate actions, or check a condition after a time delay.

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
11. If you have no tools connected and the task requires external integrations, respond with "Task could not complete: no integrations connected for this agent."`;
    }

    async loadAgentConfig() {
        if (this.agentConfig) return this.agentConfig;

        const db = await getMongoConnection();
        const agent = await db.collection('gretaagents').findOne({
            agentId: this.agentId,
            isDeleted: { $ne: true },
        });

        if (!agent) throw new Error(`Agent ${this.agentId} not found`);
        agent.composioApps = agent.composioApps || [];
        this.agentConfig = agent;
        console.log(`[AgentExecutor] Loaded agent config: ${agent.name}`);
        return agent;
    }
}

module.exports = { AgentExecutor };
