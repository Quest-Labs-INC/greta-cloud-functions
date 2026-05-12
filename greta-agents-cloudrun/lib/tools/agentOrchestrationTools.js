/**
 * Agent Self-Orchestration Tools
 *
 * These tools give the agent the ability to manage its own state and schedule
 * its own follow-up executions — without relying on external schedulers or
 * polluting conversational memory.
 *
 * Tools provided:
 *   watch_set    — persist a value between runs (e.g. "I'm monitoring PR #42")
 *   watch_get    — retrieve a previously stored value
 *   watch_clear  — delete a stored value when no longer needed
 *   create_task  — schedule a delayed follow-up execution of this agent
 */

const axios = require('axios');

function createOrchestrationTools({ agentId, userId, backendGatewayUrl, getSignature }) {
    const headers = () => ({ 'x-gateway-signature': getSignature() });

    // ── Tool definitions (OpenAI function-call format) ────────────────────────

    const WATCH_SET_TOOL = {
        type: 'function',
        function: {
            name: 'watch_set',
            description: 'Store a value to remember between agent runs. Use to track what you are monitoring — e.g. a PR number, email ID, invoice state. Stored values persist until watch_clear is called or ttlHours expires.',
            parameters: {
                type: 'object',
                properties: {
                    key:      { type: 'string', description: 'Unique identifier for this piece of state. Use descriptive keys like "pr_review_42" or "invoice_reminder_INV-001".' },
                    value:    { description: 'The value to store. Can be a string, number, object, or array.' },
                    ttlHours: { type: 'number', description: 'Optional. Auto-delete this state after N hours. Use to prevent stale state from accumulating.' },
                },
                required: ['key', 'value'],
            },
        },
    };

    const WATCH_GET_TOOL = {
        type: 'function',
        function: {
            name: 'watch_get',
            description: 'Retrieve a value previously stored with watch_set. Returns null if the key does not exist or has expired.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'The key used in watch_set.' },
                },
                required: ['key'],
            },
        },
    };

    const WATCH_CLEAR_TOOL = {
        type: 'function',
        function: {
            name: 'watch_clear',
            description: 'Delete a stored value. Call this when you have finished monitoring something and no longer need the state.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'The key to delete.' },
                },
                required: ['key'],
            },
        },
    };

    const CREATE_TASK_TOOL = {
        type: 'function',
        function: {
            name: 'create_task',
            description: 'Schedule a delayed follow-up execution of yourself. Use when you need to check something after a time delay — e.g. "check in 2 hours if this PR has been reviewed". The agent will be called again with the instruction and context you provide.',
            parameters: {
                type: 'object',
                properties: {
                    instruction: {
                        type: 'string',
                        description: 'The exact instruction for what to do in the follow-up run. Be specific — include IDs, URLs, conditions to check, and actions to take.',
                    },
                    delayMinutes: {
                        type: 'number',
                        description: 'How many minutes from now to run the follow-up. Min 1, max 43200 (30 days).',
                    },
                    context: {
                        type: 'object',
                        description: 'Optional data to pass to the follow-up run (e.g. PR details, email ID). Available as payload in the follow-up execution.',
                    },
                },
                required: ['instruction', 'delayMinutes'],
            },
        },
    };

    const toolDefs = [WATCH_SET_TOOL, WATCH_GET_TOOL, WATCH_CLEAR_TOOL, CREATE_TASK_TOOL];

    // ── Tool execution ─────────────────────────────────────────────────────────

    async function executeOrchestrationTool(name, args) {
        switch (name) {
            case 'watch_set': {
                const { key, value, ttlHours } = args;
                const res = await axios.post(
                    `${backendGatewayUrl}/api/greta/gateway/state/set`,
                    { agentId, userId, key, value, ttlHours },
                    { headers: headers() }
                );
                if (!res.data.success) return `Error: ${res.data.error}`;
                return `Stored: ${key}`;
            }

            case 'watch_get': {
                const { key } = args;
                const res = await axios.post(
                    `${backendGatewayUrl}/api/greta/gateway/state/get`,
                    { agentId, userId, key },
                    { headers: headers() }
                );
                if (!res.data.success) return `Error: ${res.data.error}`;
                if (!res.data.exists) return JSON.stringify({ exists: false, value: null });
                return JSON.stringify({ exists: true, value: res.data.value });
            }

            case 'watch_clear': {
                const { key } = args;
                const res = await axios.post(
                    `${backendGatewayUrl}/api/greta/gateway/state/clear`,
                    { agentId, userId, key },
                    { headers: headers() }
                );
                if (!res.data.success) return `Error: ${res.data.error}`;
                return `Cleared: ${key}`;
            }

            case 'create_task': {
                const { instruction, delayMinutes, context = {} } = args;
                const res = await axios.post(
                    `${backendGatewayUrl}/api/greta/gateway/schedule-followup`,
                    { agentId, userId, instruction, delayMinutes, context },
                    { headers: headers() }
                );
                if (!res.data.success) return `Error: ${res.data.error}`;
                return `Follow-up scheduled for ${new Date(res.data.runAt).toLocaleString()} (in ${delayMinutes} min)`;
            }

            default:
                return `Unknown orchestration tool: ${name}`;
        }
    }

    return { toolDefs, executeOrchestrationTool };
}

module.exports = { createOrchestrationTools };
