const axios = require('axios');
const { HumanMessage, SystemMessage, ToolMessage } = require('@langchain/core/messages');
const { createOpenRouterLLM } = require('../llm/openRouterService');
const { MongoClient } = require('mongodb');
const { createMongoQueryTool } = require('../tools/mongoQueryTool');

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

            const toolDefs = await this.loadTools(agent.composioApps || []);

            // Load MCP tools via gateway
            const mcpToolDefs = await this.loadMCPTools(agent);
            toolDefs.push(...mcpToolDefs);

            const localTools = new Map();
            if (projectMongoUrl) {
                const mongoTool = createMongoQueryTool(projectMongoUrl);
                toolDefs.push(mongoTool.toolDef);
                localTools.set('mongo_query', mongoTool.execute);
                console.log(`[AgentExecutor] mongo_query tool injected`);
            }

            console.log(`[AgentExecutor] ${toolDefs.length} tools ready (incl. ${mcpToolDefs.length} MCP)`);

            const systemPrompt = this.buildSystemPrompt(agent, { projectMongoUrl });
            const output = await this.runAgentLoop({ systemPrompt, userPrompt, toolDefs, localTools });

            const executionTime = Date.now() - startTime;
            console.log(`[AgentExecutor] ✅ Completed in ${executionTime}ms`);
            return { output, executionTime, success: true };

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
        return toolDefs;
    }

    async runAgentLoop({ systemPrompt, userPrompt, toolDefs, localTools = new Map() }) {
        const llm = createOpenRouterLLM({ temperature: 0 });
        const llmWithTools = toolDefs.length > 0 ? llm.bindTools(toolDefs) : llm;

        const messages = [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)];

        const extractText = (r) => {
            if (typeof r.content === 'string') return r.content;
            if (Array.isArray(r.content)) return r.content.filter(p => p.type === 'text').map(p => p.text).join('');
            return '';
        };

        const executeTool = async (tc) => {
            if (localTools.has(tc.name)) {
                try { return JSON.stringify(await localTools.get(tc.name)(tc.args)); }
                catch (e) { return `Tool failed: ${e.message}`; }
            }
            if (tc.name.startsWith('mcp_')) {
                try {
                    const res = await axios.post(
                        `${this.backendGatewayUrl}/api/greta/gateway/mcp/execute`,
                        { agentId: this.agentId, userId: this.userId, toolName: tc.name, args: tc.args },
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
                    { agentId: this.agentId, userId: this.userId, action: tc.name, params: tc.args },
                    { headers: { 'x-gateway-signature': this.gatewaySignature } }
                );
                return res.data.success ? JSON.stringify(res.data.data) : `Error: ${res.data.error}`;
            } catch (e) { return `Tool failed: ${e.message}`; }
        };

        for (let step = 0; step < 10; step++) {
            const response = await llmWithTools.invoke(messages);
            messages.push(response);

            const text = extractText(response);
            const hasTools = response.tool_calls?.length > 0;
            console.log(`[AgentExecutor] Step ${step + 1} — tools:${response.tool_calls?.length ?? 0} text:"${text.substring(0, 80)}"`);

            if (!hasTools) {
                // Detect prompt-too-vague: agent asked a question on the very first step
                const isQuestion = /\?\s*$/.test(text.trim()) ||
                    /please (tell|share|provide|give|let me know|specify|clarify|describe)/i.test(text) ||
                    /what (are|is) your/i.test(text) ||
                    /could you (tell|share|provide|give|clarify)/i.test(text);
                if (isQuestion && step === 0) {
                    throw new Error(`Agent asked a question instead of acting. Prompt needs to be more specific. Response: "${text.substring(0, 150)}"`);
                }
                // Detect real infrastructure failures — NOT empty results
                const isFailureReport = /payload too large|tool response.*too large|413.*payload/i.test(text);
                if (isFailureReport) throw new Error(text);
                return text || 'Task completed.';
            }

            // Execute all tool calls in parallel, track failures
            console.log(`[AgentExecutor] Executing:`, response.tool_calls.map(t => t.name).join(', '));
            let successCount = 0;
            const errors = [];
            await Promise.all(
                response.tool_calls.map(async (tc) => {
                    const result = await executeTool(tc);
                    messages.push(new ToolMessage({ tool_call_id: tc.id, content: result }));
                    if (result.startsWith('Tool failed:') || result.startsWith('Error:')) {
                        errors.push(`${tc.name}: ${result}`);
                    } else {
                        successCount++;
                    }
                })
            );

            // All tools failed — no point continuing
            if (successCount === 0 && errors.length > 0) {
                throw new Error(`All tool calls failed: ${errors.join('; ')}`);
            }

            // Tool results are in messages — loop continues so the agent can
            // call more tools (e.g. send email after fetching data) or produce a final summary.
        }

        return 'Task completed.';
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

            default:
                return `Trigger "${trigger.name}" fired.\nPayload: ${JSON.stringify(payload, null, 2)}`;
        }
    }

    buildSystemPrompt(agent, { projectMongoUrl = null } = {}) {
        const now = new Date();
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
        const memorySection = agent.memory ? `\n\n## What you remember about this user\n${agent.memory}` : '';
        const appsSection = (agent.composioApps || []).length > 0 ? `\n\n## Connected apps\n${agent.composioApps.join(', ')}` : '';
        const projectSection = projectMongoUrl
            ? `\n\n## Linked project database\nThis task is connected to a Greta v2 project database. You have the \`mongo_query\` tool to read data from it directly.\n- "the app", "signups", "users", "orders", "the database" → use \`mongo_query\`\n- For totals: operation="count". For breakdowns: operation="groupBy". For trends over time: operation="timeSeries". For lists: operation="find". For unique values: operation="distinct".\n- Always call \`mongo_query\` to get real numbers before writing any summary. Never invent or estimate data.`
            : '';

        return `You are ${agent.name || 'Assistant'}.

${agent.coreInstructions || 'You are a helpful assistant.'}

## Current date and time
Today is ${dateStr} at ${timeStr}. Always use this when working with dates or schedules.
${memorySection}${appsSection}${projectSection}

## AUTONOMOUS TASK — CRITICAL RULES
You are running as a background job. There is NO USER present. No one will see your questions or reply to them.

1. NEVER ask a question. There is nobody to answer.
2. NEVER say "please tell me" or "could you share". There is nobody listening.
3. If you need data — use your tools to fetch it RIGHT NOW.
4. ALWAYS complete the task with whatever data is available. If any tool returns zero results, note it briefly and continue with all remaining steps.
5. Call tools immediately. Do not narrate what you are about to do.
6. After tools return, write a clear summary of what was found/done. That summary is the task output.
7. Zero results from a tool is a valid outcome — include it in your summary and keep going. Never abort the whole task because one data source was empty.
8. Only respond with "Task could not complete: [reason]" if a hard infrastructure error (auth failure, API down) makes it impossible to proceed at all.`;
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
