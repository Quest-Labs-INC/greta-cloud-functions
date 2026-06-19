/**
 * Slim caching helper for the agent container.
 *
 * Ported from greta_agentic/services/cachingService.js (the app-builder stack),
 * trimmed to the Gemini-via-OpenRouter strategy the agents use.
 *
 * Strategy (Gemini): OpenRouter honours only the LAST cache_control breakpoint,
 * and everything UP TO it must be byte-identical across requests. So we mark the
 * SYSTEM PROMPT only — it's the large, stable prefix. Per-turn volatile content
 * (current time, known-tools, the user's message) lives AFTER it and is never
 * marked, so it can change every turn without busting the cached prefix.
 *
 * Cache reads are ~10x cheaper than fresh input on Gemini Flash, so a stable
 * system prompt across a turn's multi-step loop (and across turns) is the single
 * biggest cost lever.
 */

/**
 * Attach cache_control to the system message's last content block.
 * Gemini accepts only { type: 'ephemeral' } (no ttl field). Returns a NEW array;
 * the input messages are not mutated.
 *
 * @param {Array}  messages  OpenAI-format messages (system first)
 * @param {string} model     model id (used only to confirm Gemini strategy)
 */
function applyCacheControl(messages, model = '') {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    const result = messages.map(m => ({ ...m }));
    const cacheControl = { type: 'ephemeral' };

    const markLastBlock = (idx) => {
        const msg = result[idx];
        if (!msg) return;
        if (typeof msg.content === 'string') {
            msg.content = [{ type: 'text', text: msg.content, cache_control: cacheControl }];
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
            const last = { ...msg.content[msg.content.length - 1], cache_control: cacheControl };
            msg.content = [...msg.content.slice(0, -1), last];
        } else {
            msg.cache_control = cacheControl;
        }
    };

    // System prompt is the stable cache prefix — the only breakpoint for Gemini.
    const systemIdx = result.findIndex(m => m.role === 'system');
    if (systemIdx !== -1) markLastBlock(systemIdx);

    return result;
}

/**
 * Pull a compact cache-performance summary out of an OpenRouter usage object
 * (from the final stream chunk). Logging/observability only.
 */
function summarizeCachePerformance(usage, model = 'google/gemini-3-flash-preview') {
    if (!usage) return null;
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;
    const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens || usage.cache_read_input_tokens || 0;
    // Hidden "thinking" tokens the model generated before its visible answer. This is the
    // DIRECT signal that the `reasoning` setting is taking effect: it should shrink with
    // effort 'low' and be ~0 with 'off'.
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;
    const cacheHitRate = inputTokens > 0 ? (cacheReadTokens / inputTokens) * 100 : 0;
    const cost = usage.cost ?? usage.cost_details?.upstream_inference_cost ?? null;
    return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        reasoningTokens,
        cacheHitRate: Math.round(cacheHitRate * 10) / 10,
        cost,
        model,
    };
}

module.exports = { applyCacheControl, summarizeCachePerformance };
