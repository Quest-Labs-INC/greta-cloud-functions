const { tool } = require('@langchain/core/tools');
const { z } = require('zod');
const axios = require('axios');
const { SUPPORTED_APPS } = require('./supportedApps');

function createSelfConfigTools({ agentId, userId, gatewayUrl, composioApps = [] }) {
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
    ];
}

module.exports = { createSelfConfigTools };
