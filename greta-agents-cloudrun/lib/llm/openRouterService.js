const { ChatOpenAI } = require('@langchain/openai');
const axios = require('axios');

const OPEN_ROUTER_API_KEY = process.env.OPEN_ROUTER_API_KEY;
const DEFAULT_AGENT_MODEL = process.env.AGENT_MODEL || 'google/gemini-2.5-flash';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Create OpenRouter LLM client for LangChain
 * Used by both agent containers and backend for consistent LLM access
 */
function createOpenRouterLLM({ model, temperature } = {}) {
    if (!OPEN_ROUTER_API_KEY) {
        throw new Error('OPEN_ROUTER_API_KEY not configured in container');
    }

    return new ChatOpenAI({
        modelName: model || DEFAULT_AGENT_MODEL,
        temperature: temperature ?? 0.2,
        openAIApiKey: OPEN_ROUTER_API_KEY,
        configuration: {
            baseURL: OPENROUTER_BASE_URL,
            defaultHeaders: {
                'HTTP-Referer': 'https://questera.ai',
                'X-Title': 'Greta-AI-Agents',
            }
        }
    });
}

/**
 * Fetch the actual USD cost of a completed generation from OpenRouter.
 * Returns null if unavailable (caller should fall back to token-based estimation).
 *
 * OpenRouter generation data is usually available within ~2s after the call completes.
 * Pass the generation ID from msg.id (e.g. "gen-xxxxxxxx").
 */
async function fetchGenerationCost(generationId) {
    if (!generationId) return null;
    console.log(`[OpenRouter] Fetching cost for id: "${generationId}"`);
    try {
        const res = await axios.get(`${OPENROUTER_BASE_URL}/generation?id=${generationId}`, {
            headers: { Authorization: `Bearer ${OPEN_ROUTER_API_KEY}` },
            timeout: 5000,
        });
        const d = res.data?.data;
        // For BYOK accounts total_cost = 0 — actual cost is in byok_usage_inference
        const cost = d?.byok_usage_inference || d?.total_cost;
        console.log(`[OpenRouter] id:${generationId} cost:${cost} byok:${d?.byok_usage_inference} total:${d?.total_cost}`);
        return (typeof cost === 'number' && cost > 0) ? cost : null;
    } catch (e) {
        console.warn(`[OpenRouter] fetchGenerationCost(${generationId}) failed: ${e.response?.status} ${e.message}`);
        return null;
    }
}

/**
 * Fetch actual USD costs for multiple generations and return the total.
 * Waits 2s first to let OpenRouter finalize the generation data.
 * Returns null if none of the IDs resolve successfully.
 */
async function fetchTotalRunCost(generationIds) {
    const ids = generationIds.filter(Boolean);
    if (!ids.length) return null;
    await new Promise(r => setTimeout(r, 2000));
    const costs = await Promise.all(ids.map(fetchGenerationCost));
    const valid = costs.filter(c => c !== null);
    if (!valid.length) return null;
    return valid.reduce((sum, c) => sum + c, 0);
}

module.exports = { createOpenRouterLLM, fetchGenerationCost, fetchTotalRunCost };
