const OpenAI = require('openai');
const axios = require('axios');

const OPEN_ROUTER_API_KEY = process.env.OPEN_ROUTER_API_KEY;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function createRawOpenAIClient() {
    if (!OPEN_ROUTER_API_KEY) {
        throw new Error('OPEN_ROUTER_API_KEY not configured in container');
    }
    return new OpenAI({
        baseURL: OPENROUTER_BASE_URL,
        apiKey: OPEN_ROUTER_API_KEY,
        defaultHeaders: {
            'HTTP-Referer': 'https://www.greta.sh/',
            'X-Title': 'Greta-AI-Agents',
        },
    });
}

async function fetchGenerationCost(generationId, { retryOn404 = true } = {}) {
    if (!generationId) return null;
    console.log(`[OpenRouter] Fetching cost for id: "${generationId}"`);
    try {
        const res = await axios.get(`${OPENROUTER_BASE_URL}/generation?id=${generationId}`, {
            headers: { Authorization: `Bearer ${OPEN_ROUTER_API_KEY}` },
            timeout: 8000,
        });
        const d = res.data?.data;
        // For BYOK accounts total_cost = 0 — actual cost is in byok_usage_inference
        const cost = d?.byok_usage_inference || d?.total_cost;
        console.log(`[OpenRouter] id:${generationId} cost:${cost} byok:${d?.byok_usage_inference} total:${d?.total_cost}`);
        return (typeof cost === 'number' && cost > 0) ? cost : null;
    } catch (e) {
        const status = e.response?.status;
        console.warn(`[OpenRouter] fetchGenerationCost(${generationId}) failed: ${status} ${e.message}`);
        // OpenRouter returns 404 if data isn't indexed yet — retry once after 3s
        if (status === 404 && retryOn404) {
            await new Promise(r => setTimeout(r, 3000));
            return fetchGenerationCost(generationId, { retryOn404: false });
        }
        return null;
    }
}

async function fetchTotalRunCost(generationIds) {
    const ids = generationIds.filter(Boolean);
    if (!ids.length) return null;
    await new Promise(r => setTimeout(r, 3000));
    const costs = await Promise.all(ids.map(fetchGenerationCost));
    const valid = costs.filter(c => c !== null);
    if (!valid.length) return null;
    return valid.reduce((sum, c) => sum + c, 0);
}

module.exports = { createRawOpenAIClient, OPENROUTER_BASE_URL, fetchGenerationCost, fetchTotalRunCost };
