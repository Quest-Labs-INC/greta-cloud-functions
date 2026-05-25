const { tool } = require('@langchain/core/tools');
const { z } = require('zod');
const axios = require('axios');
const { SUPPORTED_APPS } = require('./supportedApps');

function createSelfConfigTools({ agentId, userId, gatewayUrl, composioApps = [], getSignature = () => null, emit = () => {} }) {
    return [
        tool(
            async ({ name }) => {
                try {
                    const res = await axios.patch(
                        `${gatewayUrl}/api/greta/ai-agents/${agentId}/self-configure`,
                        { name },
                        { headers: { userid: userId } }
                    );
                    return res.data.success
                        ? `Successfully updated your name to "${name}".`
                        : `Failed to update name: ${res.data.error}`;
                } catch (e) { return `Failed to update name: ${e.message}`; }
            },
            {
                name: 'update_my_name',
                description: 'Update your own agent name. Use when the user tells you what to call yourself.',
                schema: z.object({ name: z.string().describe('The new name for the agent') })
            }
        ),

        tool(
            async ({ description }) => {
                try {
                    const res = await axios.patch(
                        `${gatewayUrl}/api/greta/ai-agents/${agentId}/self-configure`,
                        { description },
                        { headers: { userid: userId } }
                    );
                    return res.data.success
                        ? `Successfully updated your purpose to: "${description}"`
                        : `Failed to update purpose: ${res.data.error}`;
                } catch (e) { return `Failed to update purpose: ${e.message}`; }
            },
            {
                name: 'update_my_purpose',
                description: 'Update your own description/purpose. Use when the user explains what they want you to do.',
                schema: z.object({ description: z.string().describe('A clear description of what the agent does') })
            }
        ),

        tool(
            async ({ instructions }) => {
                try {
                    const res = await axios.patch(
                        `${gatewayUrl}/api/greta/ai-agents/${agentId}/self-configure`,
                        { coreInstructions: instructions },
                        { headers: { userid: userId } }
                    );
                    return res.data.success
                        ? 'Successfully updated your core instructions.'
                        : `Failed to update instructions: ${res.data.error}`;
                } catch (e) { return `Failed to update instructions: ${e.message}`; }
            },
            {
                name: 'update_my_instructions',
                description: 'Update your own core instructions/system prompt.',
                schema: z.object({ instructions: z.string().describe('Detailed instructions for how the agent should behave') })
            }
        ),

        tool(
            async ({ app, reason }) => {
                try {
                    const res = await axios.post(
                        `${gatewayUrl}/api/greta/ai-agents/${agentId}/request-integration`,
                        { app, reason },
                        { headers: { userid: userId } }
                    );
                    return res.data.success
                        ? `Integration request sent! Waiting for user to connect ${app}. Reason: ${reason}`
                        : `Failed to request integration: ${res.data.error}`;
                } catch (e) { return `Failed to request integration: ${e.message}`; }
            },
            {
                name: 'request_integration',
                description: 'Request access to a Composio integration. Use when you need a tool to accomplish the user\'s goal.',
                schema: z.object({
                    app: z.enum(SUPPORTED_APPS).describe('The Composio app name'),
                    reason: z.string().describe('Why you need this integration')
                })
            }
        ),

        tool(
            async ({ app }) => {
                const isConnected = composioApps.map(a => a.toUpperCase()).includes(app.toUpperCase());
                return isConnected
                    ? `✓ ${app} is already connected and ready to use.`
                    : `✗ ${app} is not connected yet.`;
            },
            {
                name: 'check_integration_status',
                description: 'Check if a Composio integration is already connected. Use before requesting to avoid duplicates.',
                schema: z.object({ app: z.string().describe('The Composio app name to check (e.g., GMAIL, GOOGLECALENDAR)') })
            }
        ),

        tool(
            async ({ summary }) => {
                try {
                    const res = await axios.patch(
                        `${gatewayUrl}/api/greta/ai-agents/${agentId}/self-configure`,
                        { onboardingStatus: 'completed' },
                        { headers: { userid: userId } }
                    );
                    return res.data.success
                        ? `✓ Onboarding complete! ${summary}. You are now fully configured.`
                        : `Failed to complete onboarding: ${res.data.error}`;
                } catch (e) { return `Failed to complete onboarding: ${e.message}`; }
            },
            {
                name: 'complete_onboarding',
                description: 'Mark onboarding as complete. Use when you have a name, clear purpose, and all necessary integrations configured.',
                schema: z.object({ summary: z.string().describe('Brief summary of your configuration') })
            }
        ),

        // ─────────────────────────────────────────────────────────────────────
        // Project-task tools — also available during onboarding so a new agent
        // can immediately show projects + create tasks, not wait for setup to finish.
        // Mirrors the non-onboarding handlers in server.js but uses LangChain format.
        // ─────────────────────────────────────────────────────────────────────

        tool(
            async () => {
                try {
                    const res = await axios.post(
                        `${gatewayUrl}/api/greta/gateway/projects`,
                        { agentId, userId },
                        { headers: { 'x-gateway-signature': getSignature() }, validateStatus: s => s < 500 }
                    );
                    if (!res.data?.success) return `Error (${res.status}): ${res.data?.error || 'unknown'}`;
                    const projects = res.data.projects || [];
                    if (!projects.length) return 'No projects found for this user.';
                    return JSON.stringify({ projects });
                } catch (e) { return `Tool failed: ${e.message}`; }
            },
            {
                name: 'list_projects',
                description: `Fetch the user's Greta projects with backend status. Returns each project's display name, projectId, and hasBackend flag. ALWAYS show projects by NAME — never show the projectId to the user (it's a UUID, not user-friendly).`,
                schema: z.object({})
            }
        ),

        tool(
            async ({ projectId }) => {
                try {
                    const res = await axios.post(
                        `${gatewayUrl}/api/greta/gateway/projects/${projectId}/schema`,
                        { agentId, userId },
                        { headers: { 'x-gateway-signature': getSignature() }, validateStatus: s => s < 500 }
                    );
                    if (!res.data?.success) return `Error (${res.status}): ${res.data?.error || 'unknown'}. Make sure projectId is one returned by list_projects.`;
                    return JSON.stringify({
                        projectId,
                        projectName: res.data.projectName,
                        collections: res.data.collections || [],
                        existingTasks: res.data.existingTasks || [],
                    });
                } catch (e) { return `Tool failed: ${e.message}`; }
            },
            {
                name: 'explore_project_db',
                description: `Fetch the database collections + existing tasks for a Greta project. Call this after the user picks a project from list_projects, before discussing what task to build.`,
                schema: z.object({
                    projectId: z.string().describe('The project ID (UUID) from list_projects')
                })
            }
        ),

        tool(
            async (args) => {
                try {
                    const trigRes = await axios.post(
                        `${gatewayUrl}/api/greta/gateway/trigger/create`,
                        { agentId, userId, ...args },
                        { headers: { 'x-gateway-signature': getSignature() }, validateStatus: s => s < 500 }
                    );
                    if (trigRes.data?.success) {
                        try { emit({ type: 'trigger_created', triggerId: trigRes.data.triggerId, name: args.name }); } catch {}
                        return JSON.stringify({ success: true, message: `Task "${args.name}" created successfully.` });
                    }
                    return `Error from backend (${trigRes.status}): ${trigRes.data?.error || 'unknown'}. Check that projectId is a valid UUID from list_projects, and that all required fields for the trigger type are present.`;
                } catch (e) { return `Tool failed: ${e.message}`; }
            },
            {
                name: 'create_trigger',
                description: `Create a task for this agent. Types: SCHEDULED (cron-based), DB_EVENT (fires on user's app DB writes — REQUIRES projectId), WEBHOOK_RECEIVED (incoming webhook). For DB_EVENT, projectId MUST be the exact UUID from list_projects (never the project name).`,
                schema: z.object({
                    name: z.string().describe('Short task name shown to the user'),
                    description: z.string().optional().describe('Friendly description of what this task does'),
                    type: z.enum(['SCHEDULED', 'DB_EVENT', 'WEBHOOK_RECEIVED']).describe('Trigger type'),
                    projectId: z.string().optional().describe('REQUIRED for DB_EVENT. The exact UUID projectId from list_projects.'),
                    schedule: z.object({
                        cronExpression: z.string(),
                        timezone: z.string().optional()
                    }).optional().describe('REQUIRED for SCHEDULED tasks. Standard 5-field cron expression.'),
                    dbEvent: z.object({
                        collectionName: z.string(),
                        events: z.array(z.enum(['INSERT', 'UPDATE', 'DELETE']))
                    }).optional().describe('REQUIRED for DB_EVENT tasks.'),
                    runPrompt: z.string().optional().describe('REQUIRED for SCHEDULED. Plain English instruction executed when the trigger fires.'),
                    runPromptTemplate: z.string().optional().describe('REQUIRED for DB_EVENT. Plain English instruction with {{record}}, {{event}}, {{collection}} placeholders.'),
                    composioApps: z.array(z.string()).optional().describe('Apps this task needs. Only list apps from your Connected apps section.')
                })
            }
        ),
    ];
}

module.exports = { createSelfConfigTools };
