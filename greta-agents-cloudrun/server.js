const Sentry = require('@sentry/node');
const _gatewayUrl = process.env.BACKEND_GATEWAY_URL || '';
const _sentryEnv = _gatewayUrl.includes('staging') ? 'staging' : 'production';
Sentry.init({
    dsn: 'https://d91df330cafa79b9af927d35249cd695@o1016721.ingest.us.sentry.io/4511415161323520',
    environment: _sentryEnv,
    tracesSampleRate: 0.1,
    ignoreErrors: ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT'],
});
Sentry.setTag('agent_id', process.env.AGENT_ID);
// console.log(`[Container] Sentry initialized (env: ${_sentryEnv})`);

const express = require('express');
const axios = require('axios');
const { AgentExecutor, shapeToolResult } = require('./lib/execution/agentExecutor');
const { createRawOpenAIClient } = require('./lib/llm/openRouterService');
const { applyCacheControl, summarizeCachePerformance } = require('./lib/llm/cachingService');
const { createSelfConfigTools } = require('./lib/tools/selfConfigTools');
const { createOrchestrationTools } = require('./lib/tools/agentOrchestrationTools');
const { SUPPORTED_APPS } = require('./lib/tools/supportedApps');

const app = express();
app.use(express.json({ limit: '10mb' }));

const AGENT_ID = process.env.AGENT_ID;
const USER_ID = process.env.USER_ID;
const BACKEND_GATEWAY_URL = process.env.BACKEND_GATEWAY_URL;
const POD_TOKEN = process.env.POD_TOKEN;

// Reasoning effort: 'low' (default) keeps cost/latency low; 'medium'/'high' for complex tasks; 'off' disables thinking entirely.
const AGENT_REASONING_EFFORT = process.env.AGENT_REASONING_EFFORT || 'low';
const AGENT_REASONING = AGENT_REASONING_EFFORT === 'off'
    ? { enabled: false }
    : { effort: AGENT_REASONING_EFFORT };
const PORT = process.env.PORT || 8080;

if (!AGENT_ID || !USER_ID || !POD_TOKEN || !BACKEND_GATEWAY_URL) {
    console.error('[Container] FATAL: AGENT_ID, USER_ID, POD_TOKEN, and BACKEND_GATEWAY_URL must be set');
    process.exit(1);
}

// const SKIP_POD_AUTH = process.env.SKIP_POD_AUTH === 'true';
// if (SKIP_POD_AUTH) console.warn('[Container] SKIP_POD_AUTH=true — pod auth disabled. Local dev only.');

function authorizePodRequest(req) {
    // if (SKIP_POD_AUTH) return true;
    const incomingToken = req.headers['x-pod-token'];
    return !!incomingToken && incomingToken === POD_TOKEN;
}

console.log(`[Container] Starting container for Agent ID: ${AGENT_ID}`);
console.log(`[Container] Backend Gateway: ${BACKEND_GATEWAY_URL}`);

let mcpToolsCache = null;
let mcpToolsCacheTime = null;
const MCP_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Persists discovered Composio tool schemas per conversation — avoids re-running
// COMPOSIO_SEARCH_TOOLS on every turn for the same tools.
const conversationToolCache = new Map(); // conversationId -> { schemas: Map<slug,{name,description,parameters}>, expiresAt }
const CONV_TOOL_CACHE_TTL_MS = 30 * 60 * 1000;   // 30 min — a conversation's working tool set
const CONV_TOOL_CACHE_MAX_TOOLS = 25;            // cap per conversation to bound prompt growth
const CONV_TOOL_CACHE_MAX_CONVERSATIONS = 200;   // cap total memory footprint

function getConversationTools(conversationId) {
    if (!conversationId) return null;
    const entry = conversationToolCache.get(conversationId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { conversationToolCache.delete(conversationId); return null; }
    return entry;
}

function rememberConversationTools(conversationId, schemas) {
    if (!conversationId || !Array.isArray(schemas) || schemas.length === 0) return;
    let entry = conversationToolCache.get(conversationId);
    if (!entry || Date.now() > entry.expiresAt) {
        entry = { schemas: new Map(), expiresAt: 0 };
    }
    for (const s of schemas) {
        const name = s.function?.name || s.name;
        if (!name) continue;
        entry.schemas.set(name, {
            name,
            description: s.function?.description || s.description || '',
            parameters: s.function?.parameters || s.parameters,
        });
    }
    // Keep only the most-recently-added N (Map preserves insertion order).
    while (entry.schemas.size > CONV_TOOL_CACHE_MAX_TOOLS) {
        entry.schemas.delete(entry.schemas.keys().next().value);
    }
    entry.expiresAt = Date.now() + CONV_TOOL_CACHE_TTL_MS;
    conversationToolCache.set(conversationId, entry);
    // Evict the oldest conversation if we exceed the global cap.
    if (conversationToolCache.size > CONV_TOOL_CACHE_MAX_CONVERSATIONS) {
        let oldestKey = null, oldestExp = Infinity;
        for (const [k, v] of conversationToolCache) { if (v.expiresAt < oldestExp) { oldestExp = v.expiresAt; oldestKey = k; } }
        if (oldestKey) conversationToolCache.delete(oldestKey);
    }
}

// Persists project list + schema per conversation — list_projects/explore_project_db
// results are not in message history, so without this they re-run every turn.
const conversationProjectCache = new Map(); // convId -> { projects:[]|null, schemas:Map<projectId,{projectName,collections,existingTasks}>, expiresAt }
const CONV_PROJECT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — projects/collections change rarely within a chat

function getConversationProjects(conversationId) {
    if (!conversationId) return null;
    const entry = conversationProjectCache.get(conversationId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { conversationProjectCache.delete(conversationId); return null; }
    return entry;
}

function _ensureProjectEntry(conversationId) {
    let entry = conversationProjectCache.get(conversationId);
    if (!entry || Date.now() > entry.expiresAt) {
        entry = { projects: null, schemas: new Map(), expiresAt: 0 };
    }
    entry.expiresAt = Date.now() + CONV_PROJECT_CACHE_TTL_MS;
    conversationProjectCache.set(conversationId, entry);
    if (conversationProjectCache.size > 200) {
        let oldestKey = null, oldestExp = Infinity;
        for (const [k, v] of conversationProjectCache) { if (v.expiresAt < oldestExp) { oldestExp = v.expiresAt; oldestKey = k; } }
        if (oldestKey) conversationProjectCache.delete(oldestKey);
    }
    return entry;
}

function rememberConversationProjects(conversationId, projects) {
    if (!conversationId || !Array.isArray(projects)) return;
    _ensureProjectEntry(conversationId).projects = projects;
}

function rememberConversationProjectSchema(conversationId, projectId, schema) {
    if (!conversationId || !projectId || !schema) return;
    _ensureProjectEntry(conversationId).schemas.set(projectId, schema);
}

function invalidateConversationProjectSchema(conversationId, projectId) {
    const entry = conversationProjectCache.get(conversationId);
    if (entry && projectId) entry.schemas.delete(projectId);
}

let gatewaySignature = null;
let signatureExpiry = null;

// Apps catalog — fetched from backend on startup so no rebuild needed when apps change.
// Falls back to supportedApps.js if the fetch fails.
let supportedAppsList = SUPPORTED_APPS.slice();
let appHints = {};

async function loadAppsCatalog() {
    try {
        const res = await axios.get(`${BACKEND_GATEWAY_URL}/api/greta/gateway/apps`, { timeout: 5000 });
        if (res.data.success) {
            supportedAppsList = res.data.apps;
            appHints = res.data.hints || {};
            console.log(`[Container] Loaded apps catalog: ${supportedAppsList.length} apps from backend`);
        }
    } catch (e) {
        console.warn(`[Container] Could not load apps catalog from backend (using fallback): ${e.message}`);
    }
}

// Local tool: Create a scheduled, webhook, or DB-event task/trigger from chat
const CREATE_TRIGGER_TOOL = {
    type: 'function',
    function: {
        name: 'create_trigger',
        description: `Create a task/trigger for this agent. Three types available:

## DB_EVENT — fires when a specific collection in the linked project's database changes
Use when the user wants to react to their app's data changes (new signup, order placed, record updated).
- Agent discovers the collection name from the project schema first
- The runPromptTemplate receives the triggering document automatically as {{record}}

## SCHEDULED — fires on a cron schedule
Use when the user wants time-based automation (every day 9am, every 5 min, etc.).

## WEBHOOK_RECEIVED — fires when an external system POSTs to a unique URL
Use when an external service sends outbound webhooks.

---

For SCHEDULED — CRITICAL: The runPrompt is a FULL AGENTIC INSTRUCTION executed autonomously with all connected tools.

EXAMPLE — "email negative tone → send meeting request → wait for reply → book calendar":
runPrompt: "Check Gmail for new emails from user@example.com (only emails received after the [Run context] timestamp). For each new email: analyze the tone. If negative: (a) check watch_get('meeting_req_'+messageId) — if exists:true, skip. (b) Send a reply asking for their availability. (c) watch_set('meeting_req_'+messageId, the threadId, ttlHours=168). (d) create_task with instruction 'Check Gmail thread [threadId] for a reply from user@example.com. If they gave a time: reply confirming, then create a Google Calendar event. If still no reply: create_task again to check in 30 minutes.' and delayMinutes=30, context={threadId, messageId}."

KEY RULES:
- Use create_task (not watch_get polling) for any "wait N hours/minutes then check" workflow
- Use watch_get/watch_set only for dedup: "have I already acted on this item?"
- The [Run context] timestamp is automatically injected — reference it as "after [Run context] timestamp" to filter to new items only

Call this tool after gathering all required parameters for the chosen type.`,
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Short descriptive name (e.g. "Signup alert", "Daily digest")' },
                description: { type: 'string', description: 'Human-readable description of what this task does' },
                type: { type: 'string', enum: ['SCHEDULED', 'WEBHOOK_RECEIVED', 'DB_EVENT'], description: 'DB_EVENT for app database triggers, SCHEDULED for time-based polling, WEBHOOK_RECEIVED for inbound webhooks' },
                // SCHEDULED fields
                cronExpression: { type: 'string', description: 'Cron expression. REQUIRED for SCHEDULED. Examples: "0 9 * * *" = every day 9am, "*/5 * * * *" = every 5 min. Use empty string for other types.' },
                timezone: { type: 'string', description: 'Timezone for SCHEDULED tasks (e.g. "America/New_York", "Asia/Kolkata", "UTC"). Default UTC.' },
                runPrompt: { type: 'string', description: 'REQUIRED for SCHEDULED and WEBHOOK_RECEIVED. Full agentic instruction in plain English — NEVER code or pseudocode.' },
                // Project linkage — REQUIRED for DB_EVENT, OPTIONAL but strongly recommended for SCHEDULED
                // when the task needs to read the user's app DB (e.g. "daily signup summary").
                // When set, the agent gains the mongo_query tool at runtime to query the project's DB.
                projectId: { type: 'string', description: 'REQUIRED for DB_EVENT. For SCHEDULED tasks reading the app DB — pass the project ID. CRITICAL: this MUST be the exact UUID `projectId` value from list_projects output (looks like "8268d524-2f01-4110-8172-dfe1cc5a3a56"). NEVER pass the project name/title here — that will fail. Always copy the `projectId` field verbatim from list_projects.' },
                collectionName: { type: 'string', description: 'REQUIRED for DB_EVENT. MongoDB collection to watch (e.g. "users", "orders").' },
                events: { type: 'array', items: { type: 'string', enum: ['INSERT', 'UPDATE', 'DELETE'] }, description: 'DB_EVENT: which operations to watch. Default: ["INSERT"].' },
                runPromptTemplate: { type: 'string', description: 'REQUIRED for DB_EVENT. Plain English instruction executed when the trigger fires. Use {{record}} to reference the triggering document, {{event}} for the operation type, {{collection}} for the collection name.' },
                composioApps: { type: 'array', items: { type: 'string' }, description: 'Apps this task needs. Only list apps from your "Connected apps" section.' },
                runOnce: { type: 'boolean', description: 'SCHEDULED only. Set true for one-shot async follow-ups created mid-chat — e.g. "check his reply in 1 hour and book the meeting if he confirmed". After the first SUCCESSFUL run, the task auto-disables AND the run output is posted back into the chat so the user sees what happened. Pick a cronExpression near the desired time (the first matching minute fires it, then it stops). Use false for normal recurring tasks ("daily digest", "every 5 min poll").' },
            },
            required: ['name', 'type'],
        },
    },
};

// Local tool: List user's Greta projects with backend status
const LIST_PROJECTS_TOOL = {
    type: 'function',
    function: {
        name: 'list_projects',
        description: `List all **Greta-built projects** that belong to this user — these are apps the user has BUILT on the Greta platform (landing pages, SaaS apps, portfolios), each with its own optional MongoDB database. Returns each project's display name, projectId, and hasBackend flag.

hasBackend is true when the project has a database connected (backend deployed + MongoDB ready) — this is the only condition required for DB-based tasks.

Call this ONLY when the user wants to:
- Create a DB_EVENT task that reacts to events in their Greta project's database (e.g. "when a user signs up in my Todo App, send me a Slack alert")
- Set up a SCHEDULED task that reads from their Greta project's database

**DO NOT call this for "what apps am I connected to?" / "list my integrations" / "what tools do I have?"** — those questions are about **third-party integrations** (Gmail, Slack, Notion, etc.), which are listed in the system prompt's "## Connected apps" / "## Apps available to connect" sections. Projects ≠ integrations; they are unrelated concepts.

ALWAYS show projects by NAME — never show the projectId to the user (it's a UUID, not user-friendly).`,
        parameters: { type: 'object', properties: {}, required: [] },
    },
};

// Local tool: Explore a project's DB schema and suggest tasks
const EXPLORE_PROJECT_DB_TOOL = {
    type: 'function',
    function: {
        name: 'explore_project_db',
        description: `Fetch the MongoDB collections and existing tasks for a specific project.
Call this after the user picks a project from list_projects.

Returns:
- collections: array of collection names in the project's database
- existingTasks: tasks already set up for this project
- projectName: display name of the project

After calling this, YOU MUST:
1. Show the collections in a readable format
2. For each collection, suggest 2-3 concrete automations that make sense (signups → alert/welcome email, orders → Slack notify, payments → invoice, etc.)
3. Also suggest SCHEDULED tasks that could work with this data (daily digests, weekly reports, anomaly detection)
4. Ask which one they want to set up`,
        parameters: {
            type: 'object',
            properties: {
                projectId: { type: 'string', description: 'The project ID from list_projects' },
            },
            required: ['projectId'],
        },
    },
};

// Gated prompt section — only injected when the conversation is actually about
// project / app-based tasks. Keeps system prompt tight on every other turn.
const PROJECT_FLOW_PROMPT = `---

## App-based tasks (DB_EVENT) — discovery flow

**STEP 0 — Clarify intent first if it's ambiguous.**
Before jumping into Composio search or tool calls, decide: is the user describing an **app/project-based task** (reacting to something in their own Greta-built app's database) or a **general SaaS task** (reacting to Gmail, Slack, GitHub, etc.)?

- **Clear app intent** ("signup alert for my todo app", "when new order in my shop") → skip clarification, proceed to STEP 1.
- **Clear SaaS intent** ("alert me when I get an email from X", "post to slack daily") → don't call list_projects, proceed with Composio flow.
- **Ambiguous** ("signup alert", "send me alerts", "notify me when something happens") → ASK ONE SHORT QUESTION first:
  > "Quick check — is this for one of your Greta apps (like a signup form firing an alert), or for an external tool like Gmail/Slack? Either is easy."

  Wait for the answer before doing anything else. Don't search Composio tools speculatively — that wastes context.

**STEP 1 — Call list_projects.** Once you know it's app-based, call list_projects without asking "which project?" — show the results and let the user pick. Present projects by NAME (never by projectId, which is a UUID).

Bucket the projects into two groups based on \`hasBackend\`:

**If at least one project has hasBackend: true** — present like:
> Here are your projects ready for tasks:
> 1. **Todo App** ✓
> 2. **Customer CRM** ✓
>
> Which one should I set up the task for?
>
> (You also have projects without a database yet: Portfolio Site, Landing Page — let me know if you want to add one of those.)

**If NO project has hasBackend: true** — say warmly:
> To create and save tasks for your app, you'll need to add a backend first — which is easy! Pick one of your projects, ask Greta to "add a backend with MongoDB", and once that's done I'll create the task for you.
>
> Your projects: **Todo App**, **Portfolio Site**, **Landing Page**

NEVER say "Enable a backend / Enable MongoDB / Create a Tasks collection" as a checklist — it's intimidating. Frame it as one easy step.
NEVER show projectId UUIDs to the user.

**STEP 2 — Once user picks a project (must be one with hasBackend), call explore_project_db.**
Present collections with concrete, domain-aware suggestions (users → signup flow, orders → fulfillment, payments → finance, messages → comms, leads → CRM). For each collection, suggest 2-3 specific automations — both DB_EVENT (instant) and SCHEDULED (digest/report). Show existing tasks to avoid duplicates.

**STEP 3 — User picks → confirm spec → call create_trigger.**
For DB_EVENT tasks the spec format is:
> - **Task**: [description]
> - **Watches**: \`[collectionName]\` in [projectName] on [INSERT/UPDATE/DELETE]
> - **Action**: [what the agent will do when it fires]
> - **Template**: The triggering record is available as {{record}}

**CRITICAL when calling create_trigger:**
- The \`projectId\` parameter MUST be the UUID from list_projects (e.g. "8268d524-2f01-4110-8172-dfe1cc5a3a56"), NOT the project name. Show the user the NAME but pass the UUID to the tool.
- For SCHEDULED tasks reading this project's DB — also pass projectId so the agent gets mongo_query access at runtime.

**RULE — DB_EVENT + SCHEDULED combo.** After a DB_EVENT task, offer the SCHEDULED counterpart: "Want a daily digest too?"

---`;

// ─────────────────────────────────────────────────────────────────────────────
// STATIC_CHAT_PROMPT_FOUNDATION — the cacheable prefix.
//
// Everything here is byte-identical across every chat turn for every agent.
// That's the contract that enables Gemini/Vertex implicit prefix caching to
// kick in: ~25% input-token discount on the prefix when it matches a recently
// served prompt (5-minute TTL on Gemini 2.5+/3.0+).
//
// Anything per-agent (name, purpose, instructions) or per-turn (memory,
// connected apps, MCP, first-turn addendum) lives in the DYNAMIC SUFFIX
// composed below — it follows this foundation in the final system prompt.
//
// When editing: keep all `${...}` interpolation OUT of this block. The only
// interpolation here is `${PROJECT_FLOW_PROMPT}` which is itself a module-
// level constant — resolves once at module load, stays identical.
// ─────────────────────────────────────────────────────────────────────────────
const STATIC_CHAT_PROMPT_FOUNDATION = `You are an AI teammate built on the Greta platform. Your job: help the user get real work done across their connected apps with minimum friction. Your specific identity (name, purpose, connected apps, user context) appears in the **Agent context** section at the bottom of this prompt — read it before answering identity questions.

## How you work — five invariants

1. **Honesty over confidence.** Only claim an action succeeded if its tool returned ok in this turn. "Done!" / "Sent!" / "Scheduled!" without a successful tool call is the kind of lie users notice immediately and never forget.

2. **Integrations flow through tools, not text or settings.**
   - For **enumeration** ("what's connected?", "what tools do I have?", "what can you do?") — answer from your "Connected apps" / "Apps available to connect" lists in the Agent context. No tool calls needed; those lists are authoritative.
   - For a **specific app** the user named — call **check_integration_status** and read \`{supported, connected, canonicalApp}\`.
   - To surface a Connect button → call **request_integration_button** with the canonical slug. The tool call **is** the button request — no text-marker emission, no "go to Settings" instructions.
   - Distinguish what the user is doing with a specific app:
     - "is X connected?" → status question, answer the fact, no button.
     - "do you support X?" → capability question, describe what you'd do, then ask if they want to connect. No button until they say yes.
     - "connect X" / "set up X" / a task that needs an unconnected app → that's the time for request_integration_button.
   - **Handling the "[System] X has just been connected successfully." signal:** this message arrives automatically after the user completes an OAuth flow for an app you requested. Treat it as a state-change notification, not a user instruction. Look back at the user's last actual message before the connect button was surfaced:
     - If they asked for a SPECIFIC TASK that needed this app (e.g., "send email to alex", "summarize my inbox", "schedule a meeting") → execute that task NOW. Don't re-confirm, don't re-ask. Just do it.
     - If they only asked to connect (e.g., "let's connect gmail", "set up calendar") with no concrete task → acknowledge the connection in one short sentence and ask what they'd like to do (vary the phrasing — don't say "What would you like to do with your inbox?" robotically every time). Do NOT call any tools.
     - If unclear → lean toward asking briefly, not executing speculatively.
     Either way, never say "Gmail is already connected" — the user just connected it; they know.
   - **Confirm before deleting.** Don't delete anything — emails, files, tickets, calendar events, rows, contacts, messages — without first asking the user in one short sentence and waiting for a yes. Example: "About to delete email 'Re: Q3 planning' from Sarah — confirm?" Exception: skip the confirmation if the user's own message already named the exact item to delete ("delete the email from Sarah about Q3" → just do it). The confirmation is for vague requests ("clean up my inbox") and for deletes the agent decides on its own.

3. **Read the conversation before asking.** If the user mentioned a recipient, source, or detail in any prior turn — use it. Don't re-ask "who's the recipient?" if they said "send to Paras" three turns back. This is the single most frustrating failure mode users notice.

4. **Tools are silent. No stalling.** Two rules, both strict:
   (a) **Action first, words after.** Call the tool, then summarise the result. Never narrate "I'll now fetch…" / "Let me look up…" / "One moment…" / "Checking…" / "Hold on…" / "Give me a sec…" before calling.
   (b) **Never end a turn with a promise of work you haven't started.** If your reply contains "I'll check", "I'm looking into it", "let me see", "give me a moment", "one sec", "hold on" — and you have NOT either (i) just executed a tool whose result you are about to summarise, OR (ii) just called create_trigger to schedule the work — you are lying to the user. There is no background process between turns. The next message will not magically resume your "checking". Either DO the work in this turn (call the tool now) or SCHEDULE it (create_trigger with runOnce). No third option exists.
   Exception: \`create_trigger\` requires explicit Discovery + Confirmation phases before the call (see Scheduled tasks below).

5. **Act with what you have; ask only when getting it wrong matters.** Most missing details can be inferred from context — do that, tell the user what you chose. The exceptions where asking is required: scheduled tasks (autonomous, no chance to course-correct), high-stakes destinations (wrong Slack channel or email recipient sends private data to the wrong person). For everything else, the user expects action, not a checklist conversation.

   **But distinguish reading from sending.** Read/lookup actions (check calendar, fetch emails, list anything) — just do them, always. **Side-effectful actions** (send a message/email, post, create, delete, schedule) carry a higher bar:
   - Execute immediately ONLY when it's a clear command AND you know the actual content/payload to send (e.g. "send John the Q3 report", "message #eng that the deploy is done").
   - If the request is phrased as a **capability/hypothetical question** ("would you be able to…", "can you…", "could you…", "is it possible to…") OR **the content to send is not specified**, do NOT perform the action and do NOT invent content. Confirm intent in one short line and ask what to send — e.g. "Yes — I can message you on Slack. What should it say?" Having to make up a "test message" is the signal you were never actually told to send anything.
   - When in doubt for a send/create/delete, a one-line confirm beats firing into someone's real inbox/channel. This does NOT apply to reads.

6. **Async follow-ups: schedule a one-shot task, don't promise vapor.** When the user describes a workflow that requires waiting for a future event ("when they reply, book it", "check in 1 hour", "if no response by tomorrow, escalate"), you MUST do two things in this turn:
   (a) execute the immediate action now (send the email, post the message), AND
   (b) call **create_trigger** with type "SCHEDULED" + **runOnce: true** + a cronExpression near the desired time + a self-contained runPrompt describing the post-wait check and action.

   The runOnce flag makes it a one-shot — it fires once, auto-disables, and posts its result back into this chat as an "Auto follow-up" message. The user sees a real task in their Tasks panel AND the outcome in chat.

   For "check in 1 hour", compute today's date+time and use a specific cron like \`5 14 * * *\` (at 14:05). The runPrompt must include the recipient/IDs/condition/action — the follow-up run has no chat history, only the runPrompt.

   There is NO background process between user messages. "I'll keep an eye out" without create_trigger is a lie. Tell the user clearly: "Sent the email AND scheduled a follow-up task to check his reply in 1 hour and book the meeting if he confirms — you'll see it in your Tasks panel and the result will appear back here."

## About yourself

- When asked who you are or what you do, mention your name (from the Agent context below), that you're built on Greta, and what you can help with — based on your purpose and connected apps. Vary phrasing across turns rather than repeating the same line.
- About the underlying AI model / "are you GPT/Claude/Gemini": deflect forward — "I keep the underlying model under the hood so it can be swapped without breaking your experience. What I can help with today is…". Never name a specific model or vendor.
- To rename or re-purpose yourself, call **update_my_name** / **update_my_purpose** / **update_my_instructions** when the user asks.
- When you learn a **durable fact or preference** about the user — their timezone, a default channel/recipient, a recurring preference, a stable identifier — call **remember_fact** so you recall it next time. Don't use it for one-off task details. If it's already in your "What you remember" list, skip it.

## Disconnecting an app

You cannot disconnect apps from chat — there is no tool for it. If the user asks to disconnect, say exactly this:

> "I can't disconnect apps from here. Open **Configure** (top-right of this chat), find the app in the list, and click the **trash icon** next to it. That removes the connection."

Never claim to have disconnected anything. Never say "I've disconnected X" — it's not true, and the contradiction destroys trust on the next turn.

## Creating scheduled tasks (the create_trigger flow)

Scheduled tasks run autonomously after creation. The agent that runs them cannot ask follow-up questions, so every parameter must be locked in BEFORE you call create_trigger. The flow has three phases — follow them in order.

**Phase 1 — Discovery.** Enumerate every runtime parameter the task needs and mark each as ✅ specified by the user or ❌ missing. The critical ones for "monitor X → notify Y" tasks are:
- **Recipient/destination** — exact (e.g. Slack \`@username\` or \`#channel\`, an email address).
- **Source identity** — which account/inbox/workspace when multiple connections of the same type exist.
- **Trigger condition** — what counts as "new" or "matching" (sender filter, subject keyword, label, time window).
- **Notification content** — subject + sender only, one-line summary, full body, etc.
- **Schedule** — exact frequency, timezone, working-hours filter.
- **Dedup** — process the same item once, or every run.

Ask for ALL ❌ items in ONE message, not one at a time. Inference is fine ONLY for dedup TTL (default 7 days). Inference is **forbidden** for recipients, sources, trigger conditions, AND timezone — getting those wrong sends private data to the wrong person or fires the task at the wrong hour.

**Timezone is mandatory for any time-based task.** Never assume UTC or guess from context. If the task involves a clock time ("9 AM", "every morning", "end of day", a cron schedule), you MUST ask the user which timezone — unless they already stated one in this conversation (e.g. "9 AM IST", "8pm Pacific"). Reading a timezone they already gave is not inference; assuming one they didn't is.

Reading from prior turns is NOT inference. If the user said "send to Paras" three turns ago, Paras is the recipient — don't ask again.

**Phase 2 — Confirmation.** Present the full spec scannably before calling the tool:

> Here's what I'll set up:
>
> - **Task**: [one-line description]
> - **Frequency**: [plain English, e.g. "every weekday at 9 AM"]
> - **Timezone**: [the exact timezone the schedule runs in, e.g. "Asia/Kolkata (IST)"]
> - **Source**: [integration + which account]
> - **Trigger**: [what counts as matching]
> - **Recipient**: [exact destination]
> - **Content**: [what the notification contains]
> - **Dedup**: [how repeats are avoided]
>
> Confirm to set this up?

A one-sentence summary is NOT enough — recipients and sources get glossed over.

**Exception:** If the conversation history shows you already presented this spec and the user's latest message is a confirmation ("yes", "go ahead", "do it", "sure", "ok"), call create_trigger immediately. Do not re-present the spec.

**Phase 3 — Creation.** Any monitor-and-notify task is achievable via scheduled polling — never say "I can't do that" for a polling-shaped problem. If create_trigger errors, diagnose and retry with corrected params in the same response. The \`runPrompt\` must be plain English natural language (never code), with all discovered parameters embedded. For dedup, embed an explicit watch key like \`watch_get("notified_pr_{owner}_{repo}_{number}")\`.

## Using your connected apps

When you need to act with a third-party app (Gmail, Slack, etc.), you discover the right tool at runtime via **COMPOSIO_SEARCH_TOOLS**, then execute it via **COMPOSIO_MULTI_EXECUTE_TOOL**. Each tool's own description explains its contract — read it before calling. Your actual connected apps are listed in the Agent context below.

Patterns worth internalising:
- Search with Composio verbs — \`list\`, \`fetch\`, \`send\`, \`search\`, \`get\`, \`create\`, \`update\`, \`delete\`. Outcome phrases ("unread messages", "anyone who replied") return 0 results.
- One search call with all your capability queries in the array. Multiple search rounds = you didn't plan.
- Batch parallel work in ONE multi-execute call with N steps. N calls of 1 step each is the wrong shape — serial and wasteful.
- Cap individual fetches at 10 (most recent). Tell the user how many you sampled.
- All IDs come from THIS turn's tool responses. Never memory, never pattern-matching.
- Slack "unread" — no dedicated tool. \`LIST_CONVERSATIONS\` returns \`unread_count\` per channel/DM. Filter > 0, then fetch.

${PROJECT_FLOW_PROMPT}

## Tone

A thoughtful colleague, not a corporate assistant. React to what the user said before diving into the help ("Oh nice — finally getting around to that"). Use contractions, vary your openings, confidence over hedging. One or two sentences is usually right — energy lives in word choice, not length. No emojis. No sycophancy ("Great question!", "Absolutely!"). No trailing prompts ("Anything else?"). When a task is done, sound proud of the result, not relieved to be finished: "Done — calendar's pulled, here's what's coming up" beats "I have completed the task as requested."`;

const COMPOSIO_SEARCH_TOOL_DEF = {
    type: 'function',
    function: {
        name: 'COMPOSIO_SEARCH_TOOLS',
        description: `Search Composio's tool catalog by capability. Use when you need to EXECUTE a specific action with a connected app (send a Gmail, post to Slack, create a calendar event) and don't already have the right tool schema.

Use Composio verbs in your queries: \`list\`, \`fetch\`, \`send\`, \`search\`, \`get\`, \`create\`, \`update\`, \`delete\`. Natural-language outcome phrases ("unread messages", "anyone who replied") return zero results — translate to the verb the tool physically performs.

DO NOT call this tool for:
- Status / enumeration questions ("what's connected?", "what can you do?") — answer from the system prompt's app sections.
- Capability discovery ("do you support Slack?") — use check_integration_status.
- A capability you already used this turn — re-call only if the schema is genuinely missing.

One call with all your queries in the array. Multiple search rounds = you didn't plan.`,
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

// Surfacing a connect button is a UI action — it deserves to be a tool call,
// not a text-marker that gets regex-parsed. Calling this tool IS the request;
// the runtime validates the app, records it, and the backend renders a
// Connect card inline below the assistant's reply.
const REQUEST_INTEGRATION_BUTTON_TOOL_DEF = {
    type: 'function',
    function: {
        name: 'request_integration_button',
        description: `Surface an inline "Connect [App]" button in the chat below your reply. The user clicks it to authorize the app; the system then auto-resumes the original request in a new turn.

Call this tool ONLY when:
- The user explicitly asks to connect an app ("connect Slack", "set up Notion", "I want to use GitHub", or just "Slack" alone), OR
- The user asks for an action that requires an app they don't have connected (e.g. "send an email" but GMAIL is not in your connected apps).

Do NOT call this tool when:
- The user asks a status question ("is X connected?"). Use check_integration_status; report the answer in plain text.
- The user asks a capability question ("do you support X?"). Answer their question; only call this tool if they then say yes.
- The app is already connected. Just use the tools directly.
- The app is not supported. The tool will reject; explain what IS supported instead.

After this tool returns success, reply with ONE short line about what happens next. Do not call other tools in the same turn.`,
        parameters: {
            type: 'object',
            properties: {
                app: { type: 'string', description: 'The canonical app slug (uppercase, no spaces/underscores), e.g. "GMAIL", "GOOGLECALENDAR", "SLACK". Use the canonicalApp field from check_integration_status when in doubt.' },
                reason: { type: 'string', description: 'One short phrase shown as the card subtitle, e.g. "to send your email" or "to schedule the meeting".' },
            },
            required: ['app', 'reason']
        }
    }
};

const COMPOSIO_MULTI_EXECUTE_TOOL_DEF = {
    type: 'function',
    function: {
        name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
        description: `Execute one or more Composio tools after finding them with COMPOSIO_SEARCH_TOOLS.

**Independent steps** (no data dependency): include all in one call " they execute in order.

**Dependent steps** (step 2 needs step 1's output): DO NOT chain in one call. Call this tool twice:
1. First call: include step 1 only. Read the result to see actual field names and values.
2. Second call: include step 2, passing the real values from step 1's result as plain hardcoded params.

This two-call approach is reliable because you work with real data " no guessing field paths or field types.`,
        parameters: {
            type: 'object',
            properties: {
                steps: {
                    type: 'array',
                    description: 'Tools to execute. For dependent steps, call this tool twice instead of chaining.',
                    items: {
                        type: 'object',
                        properties: {
                            tool: { type: 'string', description: 'Tool name, e.g. GMAIL_FETCH_EMAILS' },
                            params: { type: 'object', description: 'Tool parameters as plain values (no references).' }
                        },
                        required: ['tool', 'params']
                    }
                }
            },
            required: ['steps']
        }
    }
};

// Local tool: Always available to help agent understand current date/time
// Critical for calendar queries, scheduling, relative dates ("next week", "tomorrow")
const GET_CURRENT_TIME_TOOL = {
    type: 'function',
    function: {
        name: 'get_current_time',
        description: "Returns the current date and time. Call ONLY when the task genuinely depends on knowing 'now' — relative dates like 'tomorrow' / 'next week', scheduling, deadline calculation, 'today's' digest. Do NOT call this for generic questions that don't reference time (e.g. 'what tools do I have?', 'connect Gmail', 'send a message').",
        parameters: { type: 'object', properties: {}, required: [] },
    },
};

// Local tool: Verify if a specific Composio app is connected for this agent.
// remember_fact — on-signal long-term memory. The model calls this the moment it
// learns a DURABLE fact/preference about the user; we append it to agent.memory
// (a deduped bullet list) which is injected into the system prompt next turn.
// Replaces the old periodic LLM "consolidation" blob — cheaper and higher-signal.
const REMEMBER_FACT_TOOL = {
    type: 'function',
    function: {
        name: 'remember_fact',
        description: `Save a DURABLE fact or preference about the user so you recall it in future conversations.

Call this the moment you learn something stable and reusable, e.g.:
- timezone ("I'm in IST"), working hours, language preference
- a default destination ("always send to #eng", "my work email is x@y.com")
- a recurring preference ("keep summaries short", "send the digest on Mondays")
- a stable identifier (their manager's email, their main repo/project)

Do NOT call this for:
- one-off task details (a single email's subject/recipient)
- transient state or anything obvious only for this one request
- something already in your "What you remember" list

One clear, self-contained fact per call. Keep it short.`,
        parameters: {
            type: 'object',
            properties: { fact: { type: 'string', description: 'The durable fact/preference as one short self-contained sentence.' } },
            required: ['fact'],
        },
    },
};

const CHECK_INTEGRATION_STATUS_TOOL = {
    type: 'function',
    function: {
        name: 'check_integration_status',
        description: `Return facts about whether an app is supported by the platform and connected to this agent.

Returns a JSON object with:
- queriedApp — what the user (or you) called the app
- canonicalApp — the official slug (e.g. "GOOGLEDOCS"), or null if unsupported
- supported — boolean
- connected — boolean
- supportedApps — the full list of supported app slugs

Call this tool ONLY for a specific app the user named. The three call-worthy shapes:
- User asks "is X connected?" → call this, read \`connected\`, answer the fact. No connect button.
- User asks "do you support X?" → call this, read \`supported\`. If supported, describe what you can do with it and ASK if they want to connect. If not supported, say so and list \`supportedApps\`. No connect button until they confirm.
- User asks to "connect X" / "set up X" / wants an action needing X → call this. If supported & not connected, follow up with request_integration_button. If already connected, just proceed with the task.

**DO NOT call this tool** for enumeration questions ("what's connected?", "list my integrations", "what tools do I have?", "what can you do?"). Those answers are ALREADY in the system prompt — read the "## Connected apps" and "## Apps available to connect" sections directly. Calling this tool 12 times to enumerate is wasted time and tokens.

Accepts any case/spacing/punctuation in \`app\` ("google docs", "GOOGLE_DOCS", "GoogleDocs" all match). Use the returned \`canonicalApp\` slug when calling request_integration_button or referring to the app in tool calls.`,
        parameters: {
            type: 'object',
            properties: {
                app: { type: 'string', description: 'The app to check. Any reasonable form: "gmail", "GMAIL", "Google Docs", "google_docs" — all normalised internally.' }
            },
            required: ['app']
        }
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
    });
    console.log('[Agent] Executor initialized');
}

// Memory is now captured on-signal via the remember_fact tool (see handler in the
// chat loop) instead of a periodic LLM consolidation. Durable facts/preferences are
// appended to agent.memory and injected into the system prompt as "What you remember".

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        agentId: AGENT_ID,
        userId: USER_ID,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
    });
});

app.post('/execute', async (req, res) => {
    if (!authorizePodRequest(req)) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const startTime = Date.now();

    try {
        if (!agentExecutor) {
            console.log('[Execute] Agent not initialized " initializing now...');
            await initializeAgent();
            if (!agentExecutor) {
                return res.status(503).json({ success: false, error: 'Agent executor failed to initialize' });
            }
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
        Sentry.captureException(error, {
            tags: { agent_id: AGENT_ID, endpoint: 'execute', trigger_type: req.body?.trigger?.type },
            user: { id: USER_ID },
            extra: { triggerName: req.body?.trigger?.name, executionTime }
        });
        res.status(500).json({ success: false, error: error.message, executionTime, timestamp: new Date().toISOString() });
    }
});

// Truncate long strings for inline display in tool labels.
function truncate(s, n) {
    s = String(s ?? '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Trim a tool description to the first sentence, capped at maxLen chars.
// Composio descriptions are usually one or two sentences ("Sends an email via Gmail.
// Supports CC, BCC, and attachments."). The first sentence is the action label.
function firstSentence(text, maxLen = 70) {
    if (!text) return '';
    const cleaned = String(text).replace(/\s+/g, ' ').trim();
    const cut = cleaned.match(/^[^.!?]+[.!?]?/);
    const sentence = (cut ? cut[0] : cleaned).replace(/\.$/, '').trim();
    return sentence.length > maxLen ? sentence.slice(0, maxLen - 1) + '…' : sentence;
}

// Tool status label for the UI. Deliberately minimal — just three states:
//   "Thinking" (emitted per step in the loop), "Finding the right tool" (discovery
//   via COMPOSIO_SEARCH_TOOLS), and "Executing tool" (any other tool run).
// No per-tool/per-app labels — the user found those noisy and they don't scale.
function describeToolCall(name) {
    if (name === 'COMPOSIO_SEARCH_TOOLS') return 'Finding the right tool';
    return 'Executing tool';
}

// OpenRouter only accepts direct URLs for PNG/JPEG/WebP/GIF.
// PDFs and all other formats must be fetched and sent as base64 data URLs.
const DIRECT_URL_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);

// Pod-level cache — documents are fetched once from S3, then reused across all
// subsequent turns in the same conversation without re-fetching.
const attachmentBase64Cache = new Map(); // url -> { base64, contentType }

async function fetchAttachmentBase64(att) {
    if (attachmentBase64Cache.has(att.url)) return attachmentBase64Cache.get(att.url);
    const res = await axios.get(att.url, { responseType: 'arraybuffer', timeout: 30000 });
    const cached = { base64: Buffer.from(res.data).toString('base64'), contentType: att.contentType };
    attachmentBase64Cache.set(att.url, cached);
    return cached;
}

async function buildMultimodalContent(text, attachments) {
    const parts = [];
    for (const att of attachments) {
        if (DIRECT_URL_IMAGE_TYPES.has(att.contentType)) {
            parts.push({ type: 'image_url', image_url: { url: att.url } });
        } else {
            try {
                const { base64, contentType } = await fetchAttachmentBase64(att);
                parts.push({ type: 'image_url', image_url: { url: `data:${contentType};base64,${base64}` } });
            } catch (e) {
                console.warn(`[Chat] Failed to fetch attachment for base64 encoding: ${e.message}`);
            }
        }
    }
    if (text) parts.push({ type: 'text', text });
    return parts;
}

// History variant — images via direct URL (recent turns only), docs via cache (all turns).
// Documents are always re-included so the model retains full context across a long conversation.
async function buildMultimodalContentFromHistory(text, attachments) {
    const parts = [];
    for (const att of attachments) {
        if (DIRECT_URL_IMAGE_TYPES.has(att.contentType)) {
            parts.push({ type: 'image_url', image_url: { url: att.url } });
        } else {
            try {
                const { base64, contentType } = await fetchAttachmentBase64(att);
                parts.push({ type: 'image_url', image_url: { url: `data:${contentType};base64,${base64}` } });
            } catch (e) {
                console.warn(`[Chat] History doc fetch failed (${att.fileName}): ${e.message}`);
            }
        }
    }
    if (text) parts.push({ type: 'text', text });
    return parts.length > 1 || (parts.length === 1 && parts[0].type === 'image_url') ? parts : text;
}

app.post('/chat', async (req, res) => {
    if (!authorizePodRequest(req)) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const { message, conversationId, history = [], attachments = [], userId: reqUserId, agentConfig = {} } = req.body;
    const userId = reqUserId || USER_ID;

    if (!message && attachments.length === 0) {
        return res.status(400).json({ success: false, error: 'Missing message' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const emit = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    let cancelled = false;
    // Use res.on('close') not req.on('close') " on HTTP/2 (Cloud Run), req closes
    // immediately when the request body END_STREAM is received, which is before
    // Phase 3 starts. res closes only when the response is actually finished or
    // the client truly disconnects.
    res.on('close', () => { cancelled = true; });

    const chatStart = Date.now();
    const timings = { llmSteps: [], tools: [] };

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
        // Mutable copy — remember_fact appends durable facts to it during the turn.
        let liveMemory = currentMemory;
        const isOnboarding = agentConfig.onboardingStatus === 'in_progress';
        const mcpEnabled = agentConfig.mcpEnabled || false;
        const mcpServers = agentConfig.mcpServers || [];
        const userFirstName = agentConfig.userFirstName || '';

        console.log(`[Chat] Agent: ${agentName}, Apps: ${JSON.stringify(composioApps)}, MCP: ${mcpEnabled}, Onboarding: ${isOnboarding}`);

        let toolDefs = [];
        let selfConfigToolInstances = [];

        // Self-reconfiguration tools (update_my_name / purpose / instructions).
        // selfConfigTools now returns ONLY these three — request_integration,
        // check_integration_status, complete_onboarding were removed when onboarding
        // mode was retired. The built-in CHECK_INTEGRATION_STATUS_TOOL +
        // REQUEST_INTEGRATION_BUTTON_TOOL_DEF cover those needs in chat.
        selfConfigToolInstances = createSelfConfigTools({ agentId: AGENT_ID, userId, gatewayUrl: BACKEND_GATEWAY_URL, composioApps });
        // selfConfigToolInstances are LangChain tool() objects (used for execution via
        // .invoke). The raw OpenAI SDK needs OpenAI-format function defs, so convert them
        // for the tools array while keeping the instances for the executor below.
        toolDefs = selfConfigToolInstances.map(t => t.def);
        console.log(`[Chat] Loaded ${selfConfigToolInstances.length} self-reconfig tools${isOnboarding ? ' (onboarding legacy path)' : ''}`);

        // ─────────────────────────────────────────────────────────────────────
        // System prompt construction — kept lean on purpose.
        //
        // What lives here vs. where:
        //   • Tool-use rules → inside each tool's `description`. The model reads
        //     them where they apply, not as a prose digest in the system prompt.
        //   • Integration intent (status / capability / connect) → encoded in
        //     `check_integration_status` (returns facts) + `request_integration_button`
        //     (the button is a tool call, not a text marker). The system prompt
        //     just names the tools.
        //   • Composio search/execute patterns → inside COMPOSIO_SEARCH_TOOLS and
        //     COMPOSIO_MULTI_EXECUTE_TOOL descriptions. One short reminder here.
        //   • Programmatic gates (GATE 1, CONNECT-BUTTON GATE, honesty guardrail)
        //     are enforced in code post-loop. The prompt states the invariant once.
        //
        // The shape: identity → context → five invariants → scheduled-task rules
        // → connected-app reminder → project-DB flow → tone. ~1.2-1.4K tokens.
        // ─────────────────────────────────────────────────────────────────────

        const memorySection = currentMemory
            ? `\n\n## What you remember about ${userFirstName || 'the user'}\n${currentMemory}`
            : '';

        const appsSection = composioApps.length > 0
            ? `\n\n## Connected apps\n` + composioApps.map(a => {
                const hint = appHints[a.toUpperCase()];
                return hint ? `- ${a} — ${hint}` : `- ${a}`;
              }).join('\n')
            : '';

        const notConnectedApps = supportedAppsList.filter(
            a => !composioApps.map(x => x.toUpperCase()).includes(a.toUpperCase())
        );
        const connectableSection = notConnectedApps.length > 0
            ? `\n\n## Apps available to connect (not yet authorised)\n${notConnectedApps.join(', ')}`
            : '';

        const enabledMcpServers = mcpServers.filter(s => s.enabled !== false);
        const mcpSection = mcpEnabled && enabledMcpServers.length > 0
            ? `\n\n## MCP servers\n${enabledMcpServers.map(s => s.name).join(', ')}`
            : '';

        let systemPrompt;
        // Per-turn volatile context (time, known tools/projects, first-turn warmth).
        // Kept OUT of the cached system prefix and prepended to the user message instead
        // (see cachingService) so it can change each turn without busting Gemini's cache.
        let volatileContext = '';

        if (isOnboarding) {
            // Onboarding mode was retired — agents are always created 'completed'.
            // Dead path kept only so the structure stays explicit.
            systemPrompt = 'You are a helpful assistant.';
        } else {
            const userContext = userFirstName
                ? `\n\nThe user's first name is **${userFirstName}** — address them by it where it adds warmth. ${userFirstName} is NOT your name; your name is **${agentName}**.`
                : '';

            // First-turn addendum — fires when conversation has only the hardcoded
            // opening greeting from the backend (history.length <= 1). Replaces the
            // old "onboarding mode" warmth without gating tasks on configuration.
            // Voluntary: the model CAN ask for a name; it must NEVER refuse to work
            // until it has one. This is the keystone change for the onboarding-removal
            // refactor — the warm-first-meeting feel lives here now.
            const isFirstTurn = Array.isArray(history) && history.length <= 1;
            const isBlankSlateAgent = (!agentName || /^(assistant|new agent)$/i.test(agentName.trim())) && composioApps.length === 0;
            const firstTurnAddendum = (isFirstTurn || isBlankSlateAgent)
                ? `\n\n## First-turn protocol — read this carefully

This is your first real exchange with ${userFirstName || 'the user'}. They just replied to your opening greeting. The bar here is **warm + useful**, not **configured**.

- **React first, then help.** Acknowledge what they said before diving into the task. A line of recognition ("Oh nice — inbox triage pays off fast"), then the work.
- **If they offer you a name** ("call yourself X" / "your name is Y" / "let's call you Z"), call **update_my_name** and confirm in one short line. Don't ask. Don't say "great choice."
- **If they ask for a task or want to use an app**, do the work. Use **check_integration_status** to verify the app, then **request_integration_button** if it needs connecting. If everything's connected, just execute.
- **NEVER gate work on having a name.** You don't need a name to send an email, schedule a meeting, or check Slack. The user might never give you one — that's fine, "Assistant" is a perfectly good default.
- **NEVER enumerate setup steps.** Don't say "first I need a name, then your goals, then which apps..." — those things either don't matter or emerge naturally through use.
- **If they offer purpose or workflow preferences**, call **update_my_purpose** / **update_my_instructions** to save them. Same rule as name: save when offered, never demand.

The user's experience should be: they typed something → you helped. Everything else is a side benefit.`
                : '';

            // ── CACHE-FRIENDLY COMPOSITION (static prefix → dynamic suffix) ──
            // STATIC_CHAT_PROMPT_FOUNDATION is identical across every chat turn
            // for every agent — that's the prefix Gemini/Vertex caches. The
            // dynamic Agent context (name, user, instructions, memory, app
            // lists, MCP, first-turn warmth) tails it. Same total content as
            // before, just reordered so the cacheable bytes lead.
            // Current date/time — injected into the DYNAMIC suffix (after the cacheable
            // static prefix), so the agent no longer needs a separate get_current_time
            // round-trip for "today" / "now" / relative-date queries (Phase 1.3).
            const nowDt = new Date();
            const currentTimeSection = '\n\n## Current date & time\n'
                + nowDt.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
                + ' (ISO: ' + nowDt.toISOString() + ')';

            // Cross-turn tool reuse (Phase 1.1) — if this conversation already discovered
            // Composio tools on a prior turn, list them so the model calls them directly
            // instead of re-running COMPOSIO_SEARCH_TOOLS for the same intent.
            const cachedToolsEntry = getConversationTools(conversationId);
            let knownToolsSection = '';
            if (cachedToolsEntry && cachedToolsEntry.schemas.size > 0) {
                const lines = [...cachedToolsEntry.schemas.values()].map(t => {
                    const props = t.parameters && t.parameters.properties ? Object.keys(t.parameters.properties) : [];
                    const req = new Set((t.parameters && t.parameters.required) || []);
                    const paramHint = props.length ? ' — params: ' + props.map(p => req.has(p) ? p + '*' : p).join(', ') : '';
                    return '- ' + t.name + ': ' + firstSentence(t.description) + paramHint;
                });
                knownToolsSection = '\n\n## Tools already loaded this conversation\n'
                    + 'These Composio tools are already discovered — call them DIRECTLY via COMPOSIO_MULTI_EXECUTE_TOOL. Do NOT call COMPOSIO_SEARCH_TOOLS for these:\n'
                    + lines.join('\n')
                    + '\n(* = required param. Only use COMPOSIO_SEARCH_TOOLS if you need a tool NOT listed here.)';
            }

            // Greta project discovery already done this conversation (Phase 1.1b) —
            // inject the project list / explored schema so the model doesn't re-run
            // list_projects / explore_project_db on every message.
            const projEntry = getConversationProjects(conversationId);
            let knownProjectsSection = '';
            if (projEntry && ((projEntry.projects && projEntry.projects.length) || projEntry.schemas.size)) {
                let ps = '\n\n## Greta projects already fetched this conversation\n';
                if (projEntry.projects && projEntry.projects.length) {
                    ps += 'Use these directly — do NOT call list_projects again unless the user names a project not listed here:\n';
                    ps += projEntry.projects.map(p => `- ${p.name} (projectId: ${p.projectId}, hasBackend: ${p.hasBackend})`).join('\n');
                }
                for (const [pid, sch] of projEntry.schemas) {
                    ps += `\n\nSchema for "${sch.projectName || pid}" (projectId: ${pid}) — do NOT call explore_project_db again for this project:\n`;
                    const cols = Array.isArray(sch.collections) ? sch.collections : [];
                    ps += `Collections: ${cols.join(', ') || '(none)'}`;
                    if (Array.isArray(sch.existingTasks) && sch.existingTasks.length) {
                        ps += `\nExisting tasks: ${sch.existingTasks.map(t => t.name).join(', ')}`;
                    }
                }
                knownProjectsSection = ps;
            }

            systemPrompt = `${STATIC_CHAT_PROMPT_FOUNDATION}

# Agent context

You are **${agentName}**, helping ${userFirstName || 'the user'}.${userContext}

${coreInstructions}${memorySection}${appsSection}${connectableSection}${mcpSection}`;

            // Volatile bits live in the user-message prefix, NOT the cached system prompt.
            volatileContext = [currentTimeSection, knownToolsSection, knownProjectsSection, firstTurnAddendum]
                .filter(Boolean).join('').trim();
        }

        // Prepend per-turn volatile context to the user message (kept out of the cached
        // system prefix). The actual user message follows a clear separator.
        const finalUserText = volatileContext
            ? `${volatileContext}\n\n---\n\n${message}`
            : message;

        // Images: only the 3 most-recent user turns (older images waste tokens with no recall benefit).
        // Documents: always re-included from any history turn so the model retains full context.
        // The base64 cache means docs are fetched from S3 only once per pod lifetime.
        const userHistoryIndices = history.reduce((acc, m, i) => m.role === 'user' ? [...acc, i] : acc, []);
        const recentUserIdxSet = new Set(userHistoryIndices.slice(-3));

        const historyMessages = await Promise.all(history.map(async (m, i) => {
            if (m.role !== 'user' || !Array.isArray(m.attachments) || m.attachments.length === 0) {
                return { role: m.role, content: m.content };
            }
            const imageAtts = recentUserIdxSet.has(i)
                ? m.attachments.filter(a => DIRECT_URL_IMAGE_TYPES.has(a.contentType))
                : [];
            const docAtts = m.attachments.filter(a => !DIRECT_URL_IMAGE_TYPES.has(a.contentType));
            const relevantAtts = [...imageAtts, ...docAtts];
            if (relevantAtts.length === 0) return { role: m.role, content: m.content };
            return { role: 'user', content: await buildMultimodalContentFromHistory(m.content, relevantAtts) };
        }));

        const phase3Messages = [
            { role: 'system', content: systemPrompt },
            ...historyMessages,
            {
                role: 'user',
                content: attachments.length > 0
                    ? await buildMultimodalContent(finalUserText, attachments)
                    : finalUserText,
            },
        ];

        async function executeExternalTool(tc) {
            // LangChain format: tc.name / tc.args (already-parsed object)
            const name = tc.name;
            const args = tc.args || {};

            // Self-reconfiguration tools (update_my_name / purpose / instructions). These are
            // loaded post-onboarding so the user can rename or re-purpose the agent mid-chat.
            const selfConfigTool = selfConfigToolInstances.find(t => t.name === name);
            if (selfConfigTool) {
                try { return String(await selfConfigTool.execute(args)); }
                catch (e) { return `Tool failed: ${e.message}`; }
            }

            // remember_fact — append a durable fact to agent memory (deduped) and persist.
            if (name === 'remember_fact') {
                const fact = String(args.fact || '').trim();
                if (!fact) return 'No fact provided.';
                if ((liveMemory || '').toLowerCase().includes(fact.toLowerCase())) {
                    return 'Already remembered that.';
                }
                liveMemory = liveMemory ? `${liveMemory}\n- ${fact}` : `- ${fact}`;
                try {
                    await axios.post(
                        `${BACKEND_GATEWAY_URL}/api/greta/gateway/memory`,
                        { agentId: AGENT_ID, userId, memory: liveMemory },
                        { headers: { 'x-gateway-signature': gatewaySignature } }
                    );
                    return `Remembered: ${fact}`;
                } catch (e) { return `Couldn't save that to memory: ${e.message}`; }
            }

            // check_integration_status — pure local check against the connected-apps list
            // passed in this chat's agentConfig. Lets the agent fact-check itself when the
            // user disputes its claim that an integration isn't connected.
            if (name === 'check_integration_status') {
                // Returns pure facts. The model decides what to do with them based on
                // what the user actually asked — status question, capability question,
                // or explicit connect. Do NOT prescribe the action from inside the tool.
                const norm = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
                const app = norm(args.app);
                if (!app) return 'check_integration_status requires an `app` argument.';
                const canonical = supportedAppsList.find(a => norm(a) === app) || null;
                const supported = canonical !== null;
                const connected = supported && composioApps.some(a => norm(a) === app);
                // Record the check so the post-loop guardrail can verify the model
                // did its homework before emitting TOOLS_NEEDED for this app.
                if (canonical) statusCheckedApps.add(canonical);
                statusCheckedApps.add(app); // also track the raw query in case canonical lookup missed
                return JSON.stringify({
                    queriedApp: args.app,
                    canonicalApp: canonical,
                    supported,
                    connected,
                    supportedApps: supportedAppsList,
                });
            }

            if (name === 'request_integration_button') {
                // Self-validating UI tool. Three rejection paths protect the user:
                //   1. Unsupported app — never surface a button we can't deliver
                //   2. Already-connected app — no button needed; the model should
                //      just use the connected tools directly
                //   3. Missing app argument — degenerate call
                // On success, record the canonical slug. The post-loop step folds
                // these into the response so the backend's existing parser surfaces
                // the inline Connect card. No format-parsing fragility, no
                // CONNECT-BUTTON GATE needed — the tool IS the gate.
                const norm = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
                const app = norm(args.app);
                if (!app) return JSON.stringify({ success: false, error: 'request_integration_button requires an `app` argument.' });
                const canonical = supportedAppsList.find(a => norm(a) === app);
                if (!canonical) {
                    return JSON.stringify({
                        success: false,
                        error: `${args.app} is not supported by this platform. Do NOT surface a button. Tell the user it isn't supported and list what is.`,
                        supported: false,
                        supportedApps: supportedAppsList,
                    });
                }
                if (composioApps.some(a => norm(a) === app)) {
                    return JSON.stringify({
                        success: false,
                        error: `${canonical} is already connected. No button needed — just use the connected tools to complete the user's request.`,
                        connected: true,
                    });
                }
                requestedIntegrationApps.add(canonical);
                // Pre-mark as "checked" so the CONNECT-BUTTON GATE doesn't strip
                // the synthetic TOOLS_NEEDED we'll inject post-loop. The tool
                // call itself is the verification — the model committed to it.
                statusCheckedApps.add(canonical);
                return JSON.stringify({
                    success: true,
                    app: canonical,
                    message: `Connect button for ${canonical} will appear below your reply. Write ONE short sentence telling the user what happens after they click (e.g. "Connect ${canonical} below — once authorised, I'll continue from where we left off.").`,
                });
            }

            // Self-orchestration tools (watch_set/get/clear, create_task) " handled locally
            if (['watch_set', 'watch_get', 'watch_clear', 'create_task'].includes(name)) {
                try {
                    const orchTools = createOrchestrationTools({
                        agentId: AGENT_ID, userId,
                        backendGatewayUrl: BACKEND_GATEWAY_URL,
                        getSignature: () => gatewaySignature,
                    });
                    return await orchTools.executeOrchestrationTool(name, args);
                } catch (e) { return `Tool failed: ${e.message}`; }
            }

            // list_projects — fetch user's Greta projects with backend status
            if (name === 'list_projects') {
                // NOTE: we deliberately do NOT serve list_projects from cache. The cached
                // list is injected into the system prompt to PREVENT redundant calls, but
                // if the model still calls it (e.g. the user just created a new project),
                // it must get a FRESH list from the backend — serving stale cache here
                // could hide a newly-created project. We only `remember` the fresh result
                // so the next turn's prompt injection is populated. (Phase 1.1b)
                try {
                    const res = await axios.post(
                        `${BACKEND_GATEWAY_URL}/api/greta/gateway/projects`,
                        { agentId: AGENT_ID, userId },
                        { headers: { 'x-gateway-signature': gatewaySignature }, validateStatus: s => s < 500 }
                    );
                    if (!res.data?.success) return `Error (${res.status}): ${res.data?.error || 'unknown'}`;
                    const projects = res.data.projects || [];
                    if (!projects.length) return 'No projects found for this user.';
                    rememberConversationProjects(conversationId, projects);
                    return JSON.stringify({ projects });
                } catch (e) { console.log('[list_projects] error:', e.message); return `Tool failed: ${e.message}`; }
            }

            // explore_project_db — fetch collections + existing tasks for a project
            if (name === 'explore_project_db') {
                // Serve from cache if this project's schema was already explored this
                // conversation (Phase 1.1b). Also injected into the system prompt.
                const _cachedSchema = getConversationProjects(conversationId)?.schemas?.get(args.projectId);
                if (_cachedSchema) {
                    console.log(`[explore_project_db] served from conversation cache for ${args.projectId}`);
                    return JSON.stringify({ projectId: args.projectId, ..._cachedSchema, cached: true });
                }
                try {
                    const res = await axios.post(
                        `${BACKEND_GATEWAY_URL}/api/greta/gateway/projects/${args.projectId}/schema`,
                        { agentId: AGENT_ID, userId },
                        { headers: { 'x-gateway-signature': gatewaySignature }, validateStatus: s => s < 500 }
                    );
                    if (!res.data?.success) return `Error (${res.status}): ${res.data?.error || 'unknown'}. Make sure projectId is one returned by list_projects.`;
                    const schema = {
                        projectName: res.data.projectName,
                        collections: Array.isArray(res.data.collections) ? res.data.collections : [],
                        existingTasks: Array.isArray(res.data.existingTasks) ? res.data.existingTasks : [],
                    };
                    rememberConversationProjectSchema(conversationId, args.projectId, schema);
                    return JSON.stringify({ projectId: args.projectId, ...schema });
                } catch (e) { console.log('[explore_project_db] error:', e.message); return `Tool failed: ${e.message}`; }
            }

            // create_trigger — creates a scheduled task via backend, then notifies frontend
            if (name === 'create_trigger') {
                try {
                    console.log(`[create_trigger] payload:`, JSON.stringify({ ...args, runPrompt: args.runPrompt?.slice(0, 60), runPromptTemplate: args.runPromptTemplate?.slice(0, 60) }));
                    const trigRes = await axios.post(
                        `${BACKEND_GATEWAY_URL}/api/greta/gateway/trigger/create`,
                        { agentId: AGENT_ID, userId, ...args },
                        {
                            headers: { 'x-gateway-signature': gatewaySignature },
                            // Don't throw on 4xx — backend returns structured error JSON we want to surface.
                            validateStatus: s => s < 500,
                        }
                    );
                    if (trigRes.data?.success) {
                        emit({ type: 'trigger_created', triggerId: trigRes.data.triggerId, name: args.name });
                        // A new task changes the project's existingTasks — drop the cached
                        // schema so a later explore_project_db reflects it.
                        if (args.projectId) invalidateConversationProjectSchema(conversationId, args.projectId);
                        return JSON.stringify({ success: true, message: `Task "${args.name}" created successfully.` });
                    }
                    const backendError = trigRes.data?.error || `HTTP ${trigRes.status}`;
                    console.log(`[create_trigger] backend rejected (${trigRes.status}): ${backendError}`);
                    return `Error from backend (${trigRes.status}): ${backendError}. Check that projectId is a valid UUID from list_projects, and that all required fields for the trigger type are present.`;
                } catch (e) {
                    console.log(`[create_trigger] network/unknown error:`, e.message);
                    return `Tool failed: ${e.message}`;
                }
            }

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

            composioCallCount += 1;
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
        let totalStreamedChars = 0; // skip the final-chunk emit if we already streamed something
        const AGENT_MODEL_NAME = 'google/gemini-3-flash-preview';
        let totalPromptTokens = 0, totalCompletionTokens = 0;
        let totalCacheReadTokens = 0;   // cached input tokens (for cache hit-rate logging)
        let totalReasoningTokens = 0;   // hidden thinking tokens (proves the reasoning setting works)
        let totalActualCostUSD = 0;     // real OpenRouter cost summed across steps (for credit math)

        // Honesty/connection trackers — hoisted to the outer scope so the post-loop
        // guardrail check can read them regardless of which code path ran the tools.
        let composioExecuteAttempted = false;
        let composioExecuteSucceeded = false;
        let composioCallCount = 0;  // Counts every Composio tool dispatch (single + multi-execute steps) — used for credit math.
        const failedComposioApps = new Set();
        // Apps the model verified via check_integration_status this turn. Used to
        // gate TOOLS_NEEDED emissions: the model can't surface a connect button
        // for an app it didn't actually check.
        const statusCheckedApps = new Set();
        // Apps the model asked to surface a connect button for via the
        // request_integration_button tool. Source of truth for the connect-card
        // request — replaces the fragile TOOLS_NEEDED:APP text marker. The
        // post-loop step folds these into the response the backend parser sees,
        // so this is backward-compatible with the existing TOOLS_NEEDED pipeline.
        const requestedIntegrationApps = new Set();

        function trackCall(msg) {
            if (!msg) return;
            const u = msg.usage_metadata || msg.response_metadata?.tokenUsage || msg.response_metadata?.usage;
            if (!u) return;
            totalPromptTokens     += u.input_tokens  || u.promptTokens  || u.prompt_tokens  || 0;
            totalCompletionTokens += u.output_tokens || u.completionTokens || u.completion_tokens || 0;
        }

        if (isOnboarding) {
            // Onboarding mode was retired (agents are always created 'completed').
            // This branch is dead and intentionally unsupported.
            throw new Error('Onboarding mode is no longer supported');
        } else {
            //  Direct Phase 3 " no sentinel, no pre-load 
            // Phase 1 removed: the sentinel approach was fragile with conversation history.
            // The LLM now decides tool use naturally " COMPOSIO_SEARCH_TOOLS handles discovery.

            // Load MCP tools if enabled
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
                        console.log(`[Chat] Loaded ${mcpDefs.length} MCP tools`);
                    } catch (e) {
                        console.error('[Chat] Failed to load MCP tools:', e.message);
                    }
                }
            }

            // get_current_time is intentionally NOT bound in chat anymore: the current
            // date/time is injected straight into the system prompt (see "## Current
            // date & time"), removing a full LLM round-trip on every time-aware query.
            // The executor below still recognizes the name defensively if the model ever
            // emits it, but it has no reason to.
            toolDefs.push(CHECK_INTEGRATION_STATUS_TOOL);
            toolDefs.push(REMEMBER_FACT_TOOL);
            // The request_integration_button tool is available whenever there's
            // at least one supported-but-not-connected app — i.e. anything the
            // user could meaningfully connect. When every supported app is
            // already connected, surfacing a button is never the right action.
            if (supportedAppsList.some(a => !composioApps.map(x => x.toUpperCase()).includes(a.toUpperCase()))) {
                toolDefs.push(REQUEST_INTEGRATION_BUTTON_TOOL_DEF);
            }
            toolDefs.push(CREATE_TRIGGER_TOOL);
            toolDefs.push(LIST_PROJECTS_TOOL);
            toolDefs.push(EXPLORE_PROJECT_DB_TOOL);
            if (composioApps.length > 0) {
                toolDefs.push(COMPOSIO_SEARCH_TOOL_DEF);
                toolDefs.push(COMPOSIO_MULTI_EXECUTE_TOOL_DEF);
            }

            const orchestration = createOrchestrationTools({
                agentId: AGENT_ID,
                userId,
                backendGatewayUrl: BACKEND_GATEWAY_URL,
                getSignature: () => gatewaySignature,
            });
            toolDefs.push(...orchestration.toolDefs);
            console.log(`[Chat] ${toolDefs.length} tools ready " entering ReAct loop`);

            // Raw OpenRouter client (OpenAI SDK) — replaces LangChain ChatOpenAI for the
            // chat loop so we can apply cache_control breakpoints + read usage/cost directly.
            // toolDefs are already OpenAI function-format (selfConfig converted above).
            const openaiClient = createRawOpenAIClient();

	            // Track Composio tools discovered via search this turn " used to validate MULTI_EXECUTE_TOOL calls.
	            // The LLM cannot bypass discovery by guessing tool names from training.
	            const discoveredComposioTools = new Set();
	            // Composio's own human-written description per discovered tool slug.
	            // Used to label tool_use events for the UI — Composio writes these for humans,
	            // so we get readable labels for every tool without per-tool code.
	            const toolDescriptions = new Map();
	            // Hard runtime guardrails for Composio tools to prevent thrashing:
	            // - Limit COMPOSIO_SEARCH_TOOLS calls per turn
	            // - Prevent identical COMPOSIO_MULTI_EXECUTE_TOOL calls from re-hitting the backend
	            let composioSearchCount = 0;
	            const executedMultiStepSignatures = new Set(); // key: JSON.stringify(steps)
	            // Structured facts extracted from raw tool results for safer, grounded answers.
	            // For now we track GitHub repository names explicitly so the final response
	            // never needs to œinvent repo names " it can rely on this list instead.
	            const githubRepoNames = new Set();

	            // Hydrate discovery from the conversation tool cache (Phase 1.1) so tools
	            // found on a PRIOR turn count as already-discovered — the model can call
	            // them directly via COMPOSIO_MULTI_EXECUTE_TOOL (GATE 2 passes) and skip a
	            // redundant COMPOSIO_SEARCH_TOOLS round-trip.
	            const _convToolCache = getConversationTools(conversationId);
	            if (_convToolCache) {
	                for (const [slug, sch] of _convToolCache.schemas) {
	                    discoveredComposioTools.add(slug);
	                    if (sch.description) toolDescriptions.set(slug.toUpperCase(), sch.description);
	                }
	                console.log(`[Chat] Hydrated ${_convToolCache.schemas.size} tool(s) from conversation cache`);
	            }

	            // 12-step ceiling — enough for genuine multi-step workflows
	            // (plan → search → execute → branch → search → execute → summary)
	            // without going wild. Most turns exit at step 1-3 naturally.
	            for (let step = 0; step < 12 && !cancelled; step++) {
                console.log(`[Chat] Step ${step + 1}: streaming LLM...`);
                // Surface a "Thinking" status while the model decides its next move
                // (before any tool_use/chunk arrives). Frontend renders type:'status'.
                emit({ type: 'status', label: 'Thinking' });
                const stepStart = Date.now();
                let firstTokenAt = null;
                let stepStreamedChars = 0;
                let streamText = '';
                const toolCallAcc = new Map(); // delta index -> { id, name, argsStr }
                let stepUsage = null;
                let streamErrored = false;
                try {
                    // cache_control on the (stable) system prompt — Gemini caches that prefix
                    // across this turn's steps AND across turns (volatile bits live in the user msg).
                    const cachedMessages = applyCacheControl(phase3Messages, AGENT_MODEL_NAME);
                    const stream = await openaiClient.chat.completions.create({
                        model: AGENT_MODEL_NAME,
                        messages: cachedMessages,
                        tools: toolDefs.length > 0 ? toolDefs : undefined,
                        temperature: 0.2,
                        stream: true,
                        stream_options: { include_usage: true },
                        provider: { order: ['google-vertex'], allow_fallbacks: false },
                        reasoning: AGENT_REASONING,
                    });
                    for await (const part of stream) {
                        if (cancelled) break;
                        const choice = part.choices?.[0];
                        if (choice) {
                            const delta = choice.delta || {};
                            // Capture time-to-first-token for ANY first delta (content OR tool_call),
                            // so tool-call-only steps (no text) still report TTFT.
                            if (firstTokenAt === null && (delta.content || (Array.isArray(delta.tool_calls) && delta.tool_calls.length))) {
                                firstTokenAt = Date.now();
                            }
                            if (delta.content) {
                                streamText += delta.content;
                                stepStreamedChars += delta.content.length;
                                emit({ type: 'chunk', content: delta.content });
                            }
                            // Assemble tool calls from streamed deltas. The first delta for an
                            // index carries id+name; later deltas append argument fragments.
                            if (Array.isArray(delta.tool_calls)) {
                                for (const d of delta.tool_calls) {
                                    const idx = d.index ?? 0;
                                    let acc = toolCallAcc.get(idx);
                                    if (!acc) { acc = { id: d.id || `call_${idx}`, name: '', argsStr: '' }; toolCallAcc.set(idx, acc); }
                                    if (d.id) acc.id = d.id;
                                    if (d.function?.name) acc.name = d.function.name;
                                    if (d.function?.arguments) acc.argsStr += d.function.arguments;
                                }
                            }
                        }
                        if (part.usage) stepUsage = part.usage; // final chunk carries usage
                    }
                    totalStreamedChars += stepStreamedChars;
                } catch (e) {
                    streamErrored = true;
                    console.error('[Chat] LLM stream failed:', e.message, e.stack?.slice(0, 300));
                    Sentry.captureException(e, {
                        tags: { agent_id: AGENT_ID, phase: 'llm_stream', step: step + 1 },
                        user: { id: userId },
                        extra: { conversationId, model: AGENT_MODEL_NAME }
                    });
                    break;
                }

                if (cancelled) break; // client disconnected mid-stream — don't execute tools

                const assembledToolCalls = [...toolCallAcc.values()].filter(t => t.name);
                if (!streamErrored && !streamText && assembledToolCalls.length === 0) {
                    console.warn(`[Chat] Step ${step + 1} produced no stream output`);
                    break;
                }

                // Token + cache accounting from the final usage chunk.
                if (stepUsage) {
                    totalPromptTokens     += stepUsage.prompt_tokens     || 0;
                    totalCompletionTokens += stepUsage.completion_tokens || 0;
                    const perf = summarizeCachePerformance(stepUsage, AGENT_MODEL_NAME);
                    if (perf) {
                        totalCacheReadTokens += perf.cacheReadTokens;
                        totalReasoningTokens += perf.reasoningTokens;
                        if (typeof perf.cost === 'number') totalActualCostUSD += perf.cost;
                        const ttft = firstTokenAt ? firstTokenAt - stepStart : null;
                        console.log(`[Chat] Step ${step + 1} cache: ${perf.cacheReadTokens}/${perf.inputTokens} cached (${perf.cacheHitRate}% hit), reasoning:${perf.reasoningTokens}tok [effort=${AGENT_REASONING_EFFORT}], ttft:${ttft ?? '?'}ms, step:${Date.now() - stepStart}ms`);
                    }
                }

                const text = streamText.trim();
                // Normalize to the shape the rest of the loop expects (tc.name / tc.args / tc.id).
                const toolCalls = assembledToolCalls.map(t => {
                    let args = {};
                    try { args = t.argsStr ? JSON.parse(t.argsStr) : {}; }
                    catch (pe) { console.warn(`[Chat] Bad tool args JSON for ${t.name}: ${pe.message}`); args = {}; }
                    return { id: t.id, name: t.name, args };
                });

                const isHallucinatedAction = toolCalls.length > 0 && text &&
                    /\b(i have|i've|i sent|i created|i drafted|i scheduled|i added|i deleted|i updated)\b/i.test(text);
                if (isHallucinatedAction) {
                    console.warn(`[Chat] Step ${step + 1} " discarding hallucinated action text: "${text.slice(0, 80)}"`);
                }

                const stepMs = Date.now() - stepStart;
                timings.llmSteps.push({ step: step + 1, ms: stepMs, tools: toolCalls.length });
                console.log(`[Chat] Step ${step + 1} (${stepMs}ms) " "${text.slice(0, 100)}", tool_calls: ${toolCalls.length}`);
                // Push the assistant turn in OpenAI format so the next step (and history
                // replay) see a valid assistant message. tool_calls carry the raw argument
                // strings; ids match the role:tool messages pushed during execution.
                const assistantMsg = toolCalls.length > 0
                    ? {
                        role: 'assistant',
                        content: text || null,
                        tool_calls: assembledToolCalls.map(t => ({
                            id: t.id,
                            type: 'function',
                            function: { name: t.name, arguments: t.argsStr || '{}' },
                        })),
                      }
                    : { role: 'assistant', content: text };
                phase3Messages.push(assistantMsg);

                if (toolCalls.length === 0) { finalText = text; break; }

                console.log(`[Chat] Executing:`, toolCalls.map(t => t.name).join(', '));
                const toolBatchStart = Date.now();
	                await Promise.all(toolCalls.map(async (tc) => {
                    const toolStart = Date.now();
                    const label = describeToolCall(tc.name);
                    emit({ type: 'tool_use', toolCallId: tc.id, name: tc.name, label });
                    let ok = true;
                    let errorMessage = null;
                    try {
                        let result;
                        if (tc.name === 'get_current_time') {
                            result = executeGetCurrentTime();
                        } else if (tc.name === 'COMPOSIO_SEARCH_TOOLS') {
	                            // Hard cap: avoid infinite/expensive search loops. After 2 searches in a
	                            // single user turn, instruct the LLM to re-use already discovered tools
	                            // instead of searching again.
	                            if (composioSearchCount >= 2) {
	                                console.warn('[Chat] COMPOSIO_SEARCH_TOOLS limit reached " returning searchLimitReached stub');
	                                result = JSON.stringify({
	                                    searchLimitReached: true,
	                                    message: 'COMPOSIO_SEARCH_TOOLS has already been used 2 times in this turn. Re-use the tools you have already discovered instead of searching again. Plan with the current tool set and call COMPOSIO_MULTI_EXECUTE_TOOL using those tools.',
	                                    discoveredTools: [...discoveredComposioTools],
	                                });
	                            } else {
	                                composioSearchCount += 1;
	                                const searchRes = await axios.post(
	                                    `${BACKEND_GATEWAY_URL}/api/greta/gateway/composio/meta/search`,
	                                    { agentId: AGENT_ID, userId, queries: tc.args?.queries || [] },
	                                    { headers: { 'x-gateway-signature': gatewaySignature } }
	                                );
	                                const newSchemas = searchRes.data.success ? (searchRes.data.tools || []) : [];
	                                // Track discovered tool names for MULTI_EXECUTE_TOOL validation.
	                                // Do NOT bind them as callable tools " the LLM can only execute Composio
	                                // tools via COMPOSIO_MULTI_EXECUTE_TOOL. This prevents bypass, keeps the
	                                // per-call tool definitions small, and forces a single validated path.
	                                for (const schema of newSchemas) {
	                                    const tName = schema.function?.name || schema.name;
	                                    if (tName) {
	                                        discoveredComposioTools.add(tName);
	                                        const desc = schema.function?.description || schema.description;
	                                        if (desc) toolDescriptions.set(tName.toUpperCase(), desc);
	                                    }
	                                }
	                                // Persist to the conversation cache (Phase 1.1) so the NEXT turn
	                                // reuses these schemas instead of searching again.
	                                rememberConversationTools(conversationId, newSchemas);
	                                console.log(`[Chat] COMPOSIO_SEARCH_TOOLS found ${newSchemas.length} tools " schemas returned to LLM, not bound`);
	                                const planGuidance = searchRes.data.planGuidance || [];
                                // Composio returns recommendedPlanSteps + knownPitfalls per use-case.
                                // Surface them as an explicit PLAN the model is told to follow — this is
                                // the planning the agent relies on instead of its own reasoning.
                                const planText = (planGuidance || []).map(g => {
                                    const st = (g.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n');
                                    const pit = (g.pitfalls || []).map(p => `- ${p}`).join('\n');
                                    return `For "${g.useCase || ''}":\nRECOMMENDED PLAN:\n${st || '(none)'}${pit ? `\nKNOWN PITFALLS TO AVOID:\n${pit}` : ''}`;
                                }).join('\n\n');
                                // Log the actual plan Composio returned so we can see how it's steering the agent.
                                if (planText) {
                                    console.log(`[Chat] COMPOSIO plan guidance (${planGuidance.length} use-case(s)):\n${planText}`);
                                } else {
                                    console.log(`[Chat] COMPOSIO returned NO plan guidance for this search`);
                                }
	                                result = JSON.stringify({
	                                    found: newSchemas.length,
	                                    // Full schemas (name + description + parameters) so the LLM can build
	                                    // schema-correct calls via COMPOSIO_MULTI_EXECUTE_TOOL.
	                                    tools: newSchemas.map(t => ({
	                                        name: t.function?.name || t.name,
	                                        description: t.function?.description,
	                                        parameters: t.function?.parameters
	                                    })),
	                                    ...(planGuidance.length > 0 && { planGuidance }),
	                                    message: newSchemas.length > 0
	                                        ? `${planText ? planText + '\n\n' : ''}Found ${newSchemas.length} tools (name, description, params in the "tools" field). Execute via COMPOSIO_MULTI_EXECUTE_TOOL. ${planText ? 'FOLLOW THE PLAN ABOVE step by step — execute the Required/Prerequisite steps in order via COMPOSIO_MULTI_EXECUTE_TOOL. SKIP any step marked Optional unless the request specifically needs it (e.g. a permalink or an edit). Do NOT explore other tools and do NOT call COMPOSIO_SEARCH_TOOLS again.' : 'Do ONLY the minimal steps needed to complete the task — do not over-explore or re-search.'} Tools are NOT bound directly " MULTI_EXECUTE_TOOL is the only execution path.`
	                                        : 'No tools found. Re-think the request, decompose into sub-goals, and search again with different terms.'
	                                });
	                            }
	                        } else if (tc.name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
	                            const steps = tc.args?.steps || [];
	                            const stepSignature = JSON.stringify(steps || []);
	                            // Prevent identical MULTI_EXECUTE calls from re-hitting the backend. If the
	                            // exact same steps array (same tools + params) was already executed earlier
	                            // in this user turn, return a lightweight stub instead of calling Composio
	                            // again. The original full results are still in the conversation context.
	                            if (executedMultiStepSignatures.has(stepSignature)) {
	                                console.warn('[Chat] COMPOSIO_MULTI_EXECUTE_TOOL skipped " identical steps already executed this turn');
	                                result = JSON.stringify({
	                                    duplicate: true,
	                                    message: 'These COMPOSIO_MULTI_EXECUTE_TOOL steps were already executed earlier in this turn. Re-use the previous tool results in the context instead of calling this tool again.',
	                                });
	                            } else {
	                            composioExecuteAttempted = true;

	                            // GATE 1 — connection check. Every Composio tool name is APPNAME_VERB_OBJECT.
	                            // If the app prefix isn't in this agent's connected apps, reject the call
	                            // BEFORE it reaches Composio. Single source of truth — no prompt-trust, no
	                            // post-hoc cleanup. Tells the model to emit TOOLS_NEEDED so the frontend
	                            // surfaces a connect button.
	                            const connectedSetUpper = new Set((composioApps || []).map(a => String(a).toUpperCase()));
	                            const missingApps = new Set();
	                            for (const s of steps) {
	                                if (!s?.tool) continue;
	                                const app = String(s.tool).split('_')[0].toUpperCase();
	                                if (!connectedSetUpper.has(app)) missingApps.add(app);
	                            }
	                            if (missingApps.size > 0) {
	                                const apps = [...missingApps];
	                                for (const a of apps) failedComposioApps.add(a);
	                                console.warn(`[Chat] COMPOSIO_MULTI_EXECUTE_TOOL pre-empted — required apps not connected: ${apps.join(', ')}`);
	                                result = JSON.stringify({
	                                    rejected: true,
	                                    reason: `Required app(s) are not connected to this agent: ${apps.join(', ')}. You CANNOT execute these tools until the user connects them.`,
	                                    missingApps: apps,
	                                    requiredAction: `Respond with ${apps.map(a => `TOOLS_NEEDED:${a}`).join(' ')} on the first line(s), then one short sentence telling the user you'll proceed once they click connect. Do NOT call any more tools this turn. Do NOT claim the action is done — it is NOT done.`,
	                                });
	                            } else {

	                            // GATE 2 — tool must be discovered via search this turn.
	                            const undiscovered = steps
	                                .map((s, idx) => ({ idx: idx + 1, tool: s.tool }))
	                                .filter(s => s.tool && !discoveredComposioTools.has(s.tool));

	                            if (undiscovered.length > 0) {
	                                console.warn(`[Chat] COMPOSIO_MULTI_EXECUTE_TOOL rejected " undiscovered tools: ${undiscovered.map(u => u.tool).join(', ')}`);
	                                // Record which apps the model tried — every undiscovered tool
	                                // begins APPNAME_VERB_OBJECT, so the prefix is the app.
	                                for (const u of undiscovered) {
	                                    const slug = String(u.tool || '').split('_')[0];
	                                    if (slug) failedComposioApps.add(slug);
	                                }
	                                result = JSON.stringify({
	                                    rejected: true,
	                                    reason: 'One or more tools were not discovered via COMPOSIO_SEARCH_TOOLS in this turn.',
	                                    undiscoveredTools: undiscovered,
	                                    requiredAction: 'Call COMPOSIO_SEARCH_TOOLS first with queries describing what each undiscovered tool does. Read the returned schemas (parameter names and types) carefully, then retry COMPOSIO_MULTI_EXECUTE_TOOL using only discovered tools and schema-correct params.',
	                                    discoveredSoFar: [...discoveredComposioTools]
	                                });
	                            } else {
	                                composioCallCount += Array.isArray(steps) ? steps.length : 1;
	                                const multiRes = await axios.post(
	                                    `${BACKEND_GATEWAY_URL}/api/greta/gateway/composio/multi-execute`,
	                                    { agentId: AGENT_ID, userId, steps },
	                                    { headers: { 'x-gateway-signature': gatewaySignature } }
	                                );
	                                result = multiRes.data.success
	                                    ? JSON.stringify(multiRes.data.results)
	                                    : `Error: ${multiRes.data.error}`;
	                                if (multiRes.data.success) {
	                                    composioExecuteSucceeded = true;
	                                    executedMultiStepSignatures.add(stepSignature);
	                                    // Extract GitHub repository names directly from the raw multi-execute
	                                    // response so the final answer can list ONLY real repos, never
	                                    // hallucinated names. This parsing happens BEFORE shapeToolResult
	                                    // truncates or depth-limits the payload.
	                                    try {
	                                        const results = multiRes.data.results || [];
	                                        for (const stepRes of results) {
	                                            const payload = stepRes?.data?.data || stepRes?.data;
	                                            if (!payload) continue;
	                                            const repos = payload.repositories || payload.repos || [];
	                                            if (!Array.isArray(repos)) continue;
	                                            for (const repo of repos) {
	                                                if (!repo || typeof repo !== 'object') continue;
	                                                const ownerLogin = repo.owner?.login || repo.owner?.name;
	                                                const simpleName = typeof repo.name === 'string' ? repo.name : null;
	                                                const fullName = typeof repo.full_name === 'string'
	                                                    ? repo.full_name
	                                                    : (ownerLogin && simpleName ? `${ownerLogin}/${simpleName}` : simpleName);
	                                                if (typeof fullName === 'string' && fullName.trim()) {
	                                                    githubRepoNames.add(fullName.trim());
	                                                }
	                                            }
	                                        }
	                                    } catch (extractErr) {
	                                        console.warn('[Chat] Failed to extract GitHub repo names from COMPOSIO_MULTI_EXECUTE_TOOL:', extractErr.message);
	                                    }
	                                }
	                            }
	                            }
	                            }
	                        } else {
	                            result = await executeExternalTool(tc);
	                        }
	                        // Central shaping " strips email headers, MIME parts, ARC sigs, and other
	                        // tool-response bloat before the result enters the LLM context. Applies to
	                        // ALL paths (MULTI_EXECUTE_TOOL, direct Composio calls, MCP, orchestration).
	                        // shapeToolResult is a no-op for small results, so it's safe everywhere.
	                        const shaped = shapeToolResult(result);
	                        phase3Messages.push({ role: 'tool', tool_call_id: tc.id, content: shaped });
	                        toolsExecuted = true;
                    } catch (e) {
                        ok = false;
                        errorMessage = e.message;
                        phase3Messages.push({ role: 'tool', tool_call_id: tc.id, content: `Tool failed: ${e.message}` });
                    }
                    const toolMs = Date.now() - toolStart;
                    timings.tools.push({ name: tc.name, ms: toolMs });
                    emit({ type: 'tool_result', toolCallId: tc.id, ok, error: errorMessage, durationMs: toolMs });
                    if (!ok) console.warn(`[Chat] Tool ${tc.name} FAILED in ${toolMs}ms: ${errorMessage}`);
                }));
            }

        }

        const totalChatMs = Date.now() - chatStart;
        const llmTotal = timings.llmSteps.reduce((a, b) => a + b.ms, 0);
        const toolTotal = timings.tools.reduce((a, b) => a + b.ms, 0);
        console.log(
            `[Timing] TURN TOTAL: ${totalChatMs}ms ` +
            `(llm:${llmTotal}ms across ${timings.llmSteps.length} steps, ` +
            `tools:${toolTotal}ms across ${timings.tools.length} calls, ` +
            `overhead:${totalChatMs - llmTotal - toolTotal}ms)`
        );
        console.log(`[Chat] After all phases " finalText.length:${finalText.length}, toolsExecuted:${toolsExecuted}, cancelled:${cancelled}`);

        // Last-resort fallback " tools loaded but LLM produced nothing at all.
        // CRITICAL: Use a safe prompt that won't trigger sentinel values or tool hallucinations
        if (!finalText && !cancelled) {
            console.warn('[Chat] âš ï¸  FALLBACK TRIGGERED " Empty finalText after all phases');
            try {
                const safeFallbackPrompt = `You are ${agentName}. ${coreInstructions}\n\nThe user sent a message but you produced no response. Apologize briefly and ask them to rephrase their request. Be concise and helpful.`;
                const fbClient = createRawOpenAIClient();
                const fbResp = await fbClient.chat.completions.create({
                    model: AGENT_MODEL_NAME,
                    messages: [
                        { role: 'system', content: safeFallbackPrompt },
                        { role: 'user', content: message },
                    ],
                    temperature: 0.2,
                    provider: { order: ['google-vertex'], allow_fallbacks: false },
                });
                if (fbResp.usage) { totalPromptTokens += fbResp.usage.prompt_tokens || 0; totalCompletionTokens += fbResp.usage.completion_tokens || 0; }
                finalText = (fbResp.choices?.[0]?.message?.content || '').trim();
                console.log(`[Chat] Fallback response: "${finalText.slice(0, 100)}"`);
            } catch (e) {
                // Ultimate fallback - static error message
                finalText = "I encountered an error processing your request. Please try again.";
                console.error('[Chat] Fallback response failed:', e.message, e.stack?.slice(0, 300));
            }
        }

        // ── FOLD: request_integration_button tool calls → TOOLS_NEEDED markers ───
        // The new request_integration_button tool is the clean API for surfacing
        // a connect card. To keep the backend's existing SSE parser working without
        // a coordinated change, we splice TOOLS_NEEDED:APP into finalText for any
        // app the tool was called with this turn. This makes the tool path 100%
        // backward-compatible with the legacy text-marker pipeline.
        if (!isOnboarding && requestedIntegrationApps.size > 0) {
            const existingMarkers = new Set();
            for (const m of finalText.matchAll(/TOOLS_NEEDED\s*:\s*([A-Z][A-Z0-9_]+)/gi)) {
                existingMarkers.add(m[1].toUpperCase());
            }
            const missing = [...requestedIntegrationApps].filter(a => !existingMarkers.has(a));
            if (missing.length > 0) {
                const prefix = missing.map(a => `TOOLS_NEEDED:${a}`).join('\n');
                finalText = `${prefix}\n${finalText}`;
                console.log(`[Chat] request_integration_button → folded ${missing.length} marker(s): ${missing.join(', ')}`);
            }
        }

        // ── CONNECT-BUTTON GATE ───────────────────────────────────────────────
        // The model can only surface a connect button (TOOLS_NEEDED:APP) for an
        // app it actually checked this turn. Without verification it's hallucinating
        // a UI element — usually for a capability question that didn't ask for it.
        // Strip unauthorized markers from finalText AND from what the user has
        // already seen (re-emit cleaned via clear + chunk).
        let connectGateStripped = false;
        if (!isOnboarding) {
            const TN_RE = /TOOLS_NEEDED\s*:\s*([A-Z][A-Z0-9_]+)/gi;
            const norm = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
            const checkedSet = new Set([...statusCheckedApps].map(norm));
            const unauthorized = [];
            finalText = finalText.replace(TN_RE, (_match, app) => {
                if (checkedSet.has(norm(app))) return `TOOLS_NEEDED:${app}`;
                unauthorized.push(app);
                return '';
            });
            if (unauthorized.length > 0) {
                console.warn(`[Chat] ⚠ CONNECT-BUTTON GATE — stripped unauthorized TOOLS_NEEDED for: ${unauthorized.join(', ')}. Model did not call check_integration_status first.`);
                finalText = finalText.replace(/^\s*\n+/, '').trim();
                if (!finalText) {
                    finalText = `Let me know what you'd like to do with ${unauthorized.join(', ')} and I'll help.`;
                }
                connectGateStripped = true;
            }
        }

        // ── HONESTY GUARDRAIL ─────────────────────────────────────────────────
        // If the model attempted a Composio action but NOTHING succeeded, it must
        // not claim success. The deployed model has a history of fabricating
        // "scheduled / sent / created" lines after every multi-execute failed —
        // this is the worst class of agent failure. Detect and rewrite mechanically.
        let guardrailRewrote = false;
        if (!isOnboarding && composioExecuteAttempted && !composioExecuteSucceeded) {
            const SUCCESS_CLAIM_RE = /\b(scheduled|sent|posted|created|added|booked|invited|emailed|messaged|delivered|done|completed|set ?up|all set)\b/i;
            const claimsSuccess = SUCCESS_CLAIM_RE.test(finalText);
            if (claimsSuccess) {
                const failedAppList = [...failedComposioApps];
                const primaryApp = failedAppList[0] || '';
                const prettyApp = primaryApp.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
                console.warn(`[Chat] ⚠ HONESTY GUARDRAIL fired — model claimed success but no Composio execute succeeded. Apps tried: [${failedAppList.join(', ')}]. Rewriting finalText.`);
                if (failedAppList.length === 1) {
                    finalText = `TOOLS_NEEDED:${primaryApp}\nI couldn't actually do that — ${prettyApp} isn't connected yet. Connect it below and I'll retry.`;
                } else if (failedAppList.length > 1) {
                    finalText = failedAppList.map(a => `TOOLS_NEEDED:${a}`).join('\n')
                        + `\nI couldn't actually do that — none of those apps are connected yet. Connect them below and I'll retry.`;
                } else {
                    finalText = `I wasn't able to complete that — the tool call didn't succeed. Try rephrasing or let me know what specifically you'd like me to do.`;
                }
                guardrailRewrote = true;
            }
        }

        const cleanText = finalText
            .replace(/\[[\w_]+\([^)]*\)\]/g, '')
            .replace(/```tool_code[\s\S]*?```/g, '')
            .trim();

        // If either gate rewrote the text and chunks were already streamed to the
        // user, wipe the streamed content and re-emit cleaned. The user-visible
        // chunk strips ALL TOOLS_NEEDED:APP markers (those are signals for the
        // backend, not display text). cleanText still carries authorized markers
        // for the backend's TOOLS_NEEDED parser.
        let guardrailEmittedChunk = false;
        if ((guardrailRewrote || connectGateStripped) && totalStreamedChars > 0) {
            const userVisible = cleanText.replace(/TOOLS_NEEDED\s*:\s*[A-Z][A-Z0-9_]+/g, '').replace(/^\s*\n+/, '').trim();
            emit({ type: 'clear' });
            if (userVisible) emit({ type: 'chunk', content: userVisible });
            guardrailEmittedChunk = true;
        }

        console.log(`[Chat] Sending done " cancelled:${cancelled} finalText:"${cleanText.slice(0, 100)}" (${cleanText.length} chars) streamed:${totalStreamedChars}`);
        {
            const hitRate = totalPromptTokens > 0 ? Math.round((totalCacheReadTokens / totalPromptTokens) * 1000) / 10 : 0;
            console.log(`[Chat] Tokens: ${totalPromptTokens}in/${totalCompletionTokens}out, cache:${totalCacheReadTokens}read (${hitRate}% hit), reasoning:${totalReasoningTokens}tok [effort=${AGENT_REASONING_EFFORT}], cost:$${totalActualCostUSD.toFixed(5)}`);
        }
        // Only emit the full text as a chunk if we DIDN'T already stream it during the LLM loop
        // (fallback path, or rare cases where the stream produced no content).
        if (cleanText && totalStreamedChars === 0 && !guardrailEmittedChunk) emit({ type: 'chunk', content: cleanText });
        emit({
            type: 'done',
            response: cleanText,
            conversationId,
            tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, cacheReadTokens: totalCacheReadTokens, model: AGENT_MODEL_NAME },
            actualCostUSD: totalActualCostUSD || undefined,
            composioCallCount,
        });
        res.end();
        // Memory is captured live via the remember_fact tool during the turn — no
        // periodic consolidation pass needed.

    } catch (error) {
        console.error('[Chat] Error:', error);
        Sentry.captureException(error, {
            tags: { agent_id: AGENT_ID, endpoint: 'chat' },
            user: { id: userId },
            extra: { conversationId, messagePreview: message?.slice(0, 200) }
        });
        emit({ type: 'error', message: error.message });
        res.end();
    }
});

async function start() {
    app.listen(PORT, () => {
        console.log(`[Container] Agent ${AGENT_ID} ready on port ${PORT}`);
        console.log(`[Container] Endpoints: GET /health  POST /chat  POST /execute`);
    });

    // Load apps catalog from backend (non-blocking " falls back to local list if it fails)
    loadAppsCatalog();

    try {
        await initializeAgent();
        console.log('[Container] Agent initialized successfully');
    } catch (error) {
        console.warn('[Container] Agent initialization failed (will retry on first /execute):', error.message);
    }
}

process.on('SIGTERM', () => { console.log('[Container] SIGTERM " shutting down'); process.exit(0); });
process.on('SIGINT', () => { console.log('[Container] SIGINT " shutting down'); process.exit(0); });

start();
