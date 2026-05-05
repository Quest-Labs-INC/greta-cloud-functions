const { ChatOpenAI } = require('@langchain/openai');

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

module.exports = { createOpenRouterLLM };
