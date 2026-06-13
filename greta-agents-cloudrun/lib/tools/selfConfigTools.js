const { tool } = require('@langchain/core/tools');
const { z } = require('zod');
const axios = require('axios');

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
                description: `Persist a NEW name for YOU (the agent). The name is saved to the agent record and used in all future replies.

Call this ONLY when the user EXPLICITLY names YOU. Trigger phrases:
- "call yourself X" / "your name is X" / "let's call you X" / "name yourself X"
- A direct standalone label after you asked "what should I call you?" (e.g. user just types "Pixie")

Do NOT call this when:
- The user mentions their own name ("I'm Dhaanu", "Hey, this is Sarah") — that's the user's name, not yours
- The user mentions a third person's name ("send to Paras")
- The user says "you are X" as a role/purpose ("you are an email assistant") — that's update_my_purpose, not name
- The user is just greeting ("Hi", "Hey", "heyhey")

After saving, confirm in ONE short line ("Got it — calling myself Pixie from now on.") and continue with whatever else they asked.`,
                schema: z.object({ name: z.string().describe('The new name the user has given to the agent. Just the name, no quotes, no greeting.') })
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
                description: `Persist a NEW high-level purpose/role for YOU (the agent). This is the one-line "what kind of agent am I" that defines your scope across future conversations.

Call this ONLY when the user EXPLICITLY defines your role. Trigger phrases:
- "you're an email triage assistant" / "you handle customer support" / "your job is to..."
- "focus on [domain]" / "specialise in [area]"
- A direct answer after you asked "what should I help you with?"

Do NOT call this for:
- Individual task requests ("send an email to X") — that's a single task, not your purpose. Just do it.
- Style preferences ("be more brief", "use bullet points") — that's update_my_instructions.
- Casual conversation about what they're working on — only call this when they're defining YOU, not describing their work.

A purpose is durable — it should apply to every future turn. A task is one-off — do it without changing your purpose.`,
                schema: z.object({ description: z.string().describe('One sentence describing what kind of agent this is and what scope of work it handles.') })
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
                description: `Persist NEW behavioural instructions for YOU (the agent). These are injected into your system prompt for every future turn — durable rules about HOW you work (style, defaults, preferences).

Call this ONLY when the user explicitly asks you to change how you behave going forward. Trigger phrases:
- "from now on, always..."
- "remember to..." / "going forward..."
- "always reply in [language/format]"
- "default to [account/destination/style]"
- "never do X" / "stop doing X"

Do NOT call this for:
- One-off requests ("for this email, be brief") — that's a single-turn adjustment, not a durable rule
- Status preferences ("show me JSON this time") — same, one-off
- Task instructions ("schedule the meeting at 9pm") — that's the task, not your instructions

Instructions should compose with existing ones — write them as additions, not full replacements, unless the user is rewriting from scratch.`,
                schema: z.object({ instructions: z.string().describe('The durable behavioural rule the user is adding. Write it as actionable instructions the agent will follow on every future turn.') })
            }
        ),
        // request_integration, check_integration_status, complete_onboarding —
        // all removed. Onboarding mode is gone; the post-onboarding chat path uses
        // the container's built-in CHECK_INTEGRATION_STATUS_TOOL +
        // REQUEST_INTEGRATION_BUTTON_TOOL instead.
    ];
}

module.exports = { createSelfConfigTools };
