/**
 * Local Development Server
 * Full AI chat with OpenRouter API (same as Cloud Run)
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

import {
  GCP_PROJECT,
  GCP_REGION,
  GCS_BUCKET,
  LATEST_IMAGE_VERSION,
  CONTAINER_IMAGE,
  DB_NAME,
  FILE_MODIFYING_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  MAX_AGENTIC_LOOPS
} from './config.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = 8000;

// MongoDB Atlas connection
const MONGO_URL = process.env.MONGO_URL || '';

// OpenRouter API Key (set this in your environment!)
const OPEN_ROUTER_API_KEY = process.env.OPEN_ROUTER_API_KEY || '';

let db = null;

async function connectMongo() {
  if (db) return db;
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('✅ Connected to MongoDB Atlas');
  return db;
}

// OpenRouter client
const createOpenRouterClient = (apiKey) => {
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: apiKey || OPEN_ROUTER_API_KEY,
    defaultHeaders: {
      'HTTP-Referer': 'https://greta.questera.ai',
      'X-Title': 'Greta-Agentic-Chat',
    },
  });
};

/**
 * Sanitize code content from LLM double-escaping issues
 * Some models (like Gemini) incorrectly escape template literals in JSON
 * This fixes: \` -> ` and \${ -> ${
 */
function sanitizeCodeContent(content) {
  if (!content || typeof content !== 'string') return content;

  // Fix double-escaped template literals: \` -> `
  // Fix double-escaped template expressions: \${ -> ${
  // But be careful not to break actual escape sequences
  let sanitized = content
    // Fix \` that should be ` (template literal backticks)
    .replace(/\\`/g, '`')
    // Fix \${ that should be ${ (template expressions)
    .replace(/\\\${/g, '${');

  // Log if we made changes (for debugging)
  if (sanitized !== content) {
    console.log('[SANITIZE] Fixed double-escaped template literals in code content');
  }

  return sanitized;
}

// Load Greta system prompt from file
let SYSTEM_PROMPT = '';
try {
  const promptPath = path.join(__dirname, 'greta-system-prompt.txt');
  if (fs.existsSync(promptPath)) {
    SYSTEM_PROMPT = fs.readFileSync(promptPath, 'utf-8');
    console.log(`✅ Loaded Greta system prompt (${SYSTEM_PROMPT.length} chars)`);
  } else {
    console.log('⚠️ greta-system-prompt.txt not found, using fallback');
    SYSTEM_PROMPT = `You are Greta, an expert AI assistant that helps users build full-stack applications.`;
  }
} catch (err) {
  console.error('Error loading system prompt:', err.message);
  SYSTEM_PROMPT = `You are Greta, an expert AI assistant that helps users build full-stack applications.`;
}

// PROJECT_DIR for tool executors - points to the Cloud Run container's project
// For local dev, this would be different per chat
const getProjectDir = (chatId) => {
  // Each chat has its own Cloud Run container at /app/project
  // For local testing, we could use a local directory
  return `/app/project`;
};

// Tools in OpenRouter/OpenAI function calling format
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'mcp_view_file',
      description: 'View file or directory contents',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file or directory' },
          view_range: { type: 'array', items: { type: 'integer' }, description: 'Optional [start, end] line range' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_create_file',
      description: 'Create or overwrite a file with content',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          file_text: { type: 'string', description: 'Content for the file' }
        },
        required: ['path', 'file_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_bulk_file_writer',
      description: 'PREFERRED for creating/updating 2+ files. Write multiple files in ONE call instead of multiple mcp_create_file calls. Example: files=[{path:"/app/project/frontend/src/A.tsx",content:"..."},{path:"/app/project/frontend/src/B.tsx",content:"..."}]. ALWAYS use this when creating multiple files.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            description: 'Array of files to write. REQUIRED - must not be empty!',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              required: ['path', 'content']
            }
          }
        },
        required: ['files']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_search_replace',
      description: 'Search and replace in a file. For MULTIPLE replacements in same file: either (1) set replace_all=true to replace ALL occurrences at once, or (2) rewrite the whole file with mcp_create_file. NEVER call this 5+ times on same file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          old_str: { type: 'string', description: 'Exact string to find' },
          new_str: { type: 'string', description: 'Replacement string' },
          replace_all: { type: 'boolean', description: 'If true, replaces ALL occurrences. Use this for repeated patterns!' }
        },
        required: ['path', 'old_str', 'new_str']
      }
    }
  },
  // TEMPORARILY DISABLED - execute_bash was causing issues with AI trying to install pre-installed packages
  // {
  //   type: 'function',
  //   function: {
  //     name: 'execute_bash',
  //     description: 'Execute a bash command',
  //     parameters: {
  //       type: 'object',
  //       properties: {
  //         command: { type: 'string', description: 'The bash command to execute' }
  //       },
  //       required: ['command']
  //     }
  //   }
  // },
  {
    type: 'function',
    function: {
      name: 'mcp_add_dependency',
      description: 'Install an npm package to the frontend project. Use this when you need to add a new dependency like axios, lodash, date-fns, etc. First install takes ~30 seconds, subsequent installs are fast (~8 seconds).',
      parameters: {
        type: 'object',
        properties: {
          packageName: { type: 'string', description: 'Name of the npm package to install (e.g., "axios", "lodash", "date-fns")' },
          isDev: { type: 'boolean', description: 'If true, install as devDependency (--save-dev). Default is false.' }
        },
        required: ['packageName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_remove_dependency',
      description: 'Remove/uninstall an npm package from the frontend project. Use this when a dependency is causing errors, conflicts, or is no longer needed. This runs npm uninstall.',
      parameters: {
        type: 'object',
        properties: {
          packageName: { type: 'string', description: 'Name of the npm package to uninstall (e.g., "@studio-freight/lenis", "lodash")' }
        },
        required: ['packageName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_add_python_dependency',
      description: 'Install a Python package to the backend project. Use this when you need to add a new dependency like pyjwt, bcrypt, requests, etc. The package will be installed via pip and added to requirements.txt automatically.',
      parameters: {
        type: 'object',
        properties: {
          packageName: { type: 'string', description: 'Name of the Python package to install (e.g., "pyjwt", "bcrypt", "requests", "pillow")' },
          version: { type: 'string', description: 'Optional specific version to install (e.g., "2.8.0"). If not provided, installs latest.' }
        },
        required: ['packageName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_remove_python_dependency',
      description: 'Remove/uninstall a Python package from the backend project. Use this when a dependency is causing errors or is no longer needed. This runs pip uninstall and removes from requirements.txt.',
      parameters: {
        type: 'object',
        properties: {
          packageName: { type: 'string', description: 'Name of the Python package to uninstall (e.g., "lenis", "requests")' }
        },
        required: ['packageName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_get_backend_logs',
      description: 'Get Python/FastAPI backend logs and errors. Use this to debug 500 errors, Pydantic validation errors, import errors, or any backend crashes. Returns recent stdout/stderr from the backend process.',
      parameters: {
        type: 'object',
        properties: {
          clear: { type: 'boolean', description: 'If true, clears logs after reading. Default is false.' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_get_vite_logs',
      description: 'Get Vite/frontend build logs and errors. Use this to debug TypeScript errors, build failures, missing imports, or HMR issues. Returns recent Vite stdout/stderr including compilation errors.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['all', 'errors', 'stdout'], description: 'Type of logs to retrieve. "errors" for only errors, "stdout" for only output, "all" for both. Default is "all".' },
          clear: { type: 'boolean', description: 'If true, clears logs after reading. Default is false.' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_build_frontend',
      description: 'Build the frontend for production deployment. Creates optimized bundle in dist/ folder. Use this when: 1) User requests a production build, 2) You need to check for build errors before deployment, 3) User wants to export/download their project. Returns build output including any errors.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['production', 'development'],
            description: 'Build mode. "production" (default) creates minified bundle. "development" includes source maps for debugging.'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_screenshot',
      description: 'Take a screenshot of the frontend preview. Use this to SEE what the UI looks like, debug visual issues, or verify your changes rendered correctly. Returns a base64 PNG image. Also captures browser console errors to help debug blank/broken pages!',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Route path to screenshot (e.g., "/dashboard", "/contacts", "/login"). Default is "/" (home page).' },
          fullPage: { type: 'boolean', description: 'If true, captures the entire scrollable page. If false (default), captures only the visible viewport.' },
          width: { type: 'integer', description: 'Viewport width in pixels. Default is 1280.' },
          height: { type: 'integer', description: 'Viewport height in pixels. Default is 720.' },
          selector: { type: 'string', description: 'Optional CSS selector to screenshot a specific element (e.g., "#main-content", ".hero-section").' },
          waitFor: { type: 'integer', description: 'Milliseconds to wait after page load for dynamic content. Default is 2000.' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_screenshot_bulk',
      description: 'Take screenshots of multiple routes in ONE call. More efficient than calling mcp_screenshot multiple times. Use this to check multiple pages at once (e.g., login, dashboard, contacts). Returns array of screenshots with console errors for each.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of route paths to screenshot (e.g., ["/login", "/dashboard", "/contacts"]). Max 5 paths per call.'
          },
          width: { type: 'integer', description: 'Viewport width in pixels. Default is 1280.' },
          height: { type: 'integer', description: 'Viewport height in pixels. Default is 720.' },
          waitFor: { type: 'integer', description: 'Milliseconds to wait after page load for dynamic content. Default is 2000.' }
        },
        required: ['paths']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_view_bulk',
      description: 'PREFERRED for viewing 2+ files. View multiple files in ONE call instead of multiple mcp_view_file calls. More efficient and faster. Returns content of all requested files.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            description: 'Array of file paths to view (1-20 files)',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 20
          }
        },
        required: ['paths']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'crawl_tool',
      description: 'Fetch and extract content from any webpage URL. Returns the page content as clean markdown. Use this when you need to read documentation, articles, or any web content. Handles JavaScript-rendered pages.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL of the webpage to fetch (e.g., https://docs.example.com/guide)'
          },
          formats: {
            type: 'string',
            enum: ['markdown', 'html', 'text'],
            description: 'Output format. Default is markdown.'
          }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search_tool_v2',
      description: 'Search the web for current information, documentation, tutorials, or any topic. Returns search results with titles, URLs, and snippets. Use this when you need to find information but dont know the specific URL.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query (e.g., "React 19 new features", "Tailwind CSS v4 migration guide")'
          },
          num_results: {
            type: 'integer',
            description: 'Number of results to return (1-10). Default is 5.'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_rename',
      description: 'Rename or move a file/directory. Use this instead of deleting and recreating files. Can also move files between directories.',
      parameters: {
        type: 'object',
        properties: {
          original_path: {
            type: 'string',
            description: 'Current file path (e.g., "frontend/src/old-name.tsx")'
          },
          new_path: {
            type: 'string',
            description: 'New file path (e.g., "frontend/src/new-name.tsx")'
          }
        },
        required: ['original_path', 'new_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'ALWAYS call this tool when you complete a task. Provide a concise summary of what was done, files changed, and any important notes for the next message or handoff. This helps maintain context continuity.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Concise summary of: 1) What was accomplished, 2) Files created/modified, 3) Any follow-up actions needed'
          }
        },
        required: ['summary']
      }
    }
  },
];

// ============ TOOL EXECUTORS ============
// Helper: Safe path resolution - for Cloud Run the PROJECT_DIR is /app/project
// For local dev, we proxy tool calls to the Cloud Run container

const resolveSafePath = (inputPath, projectDir) => {
  // Remove /app/project prefix if present (LLM might include full path)
  let cleanPath = inputPath.replace(/^\/app\/project\/?/, '');
  // Also handle paths starting with frontend/ or backend/ directly
  const normalized = path.normalize(cleanPath).replace(/^(\.\.[\/\\])+/, '');
  return path.join(projectDir, normalized);
}; 

// Tool executor functions - execute on the Cloud Run container via HTTP
// Cloud Run endpoints are: /api/read-file, /api/write-file, /api/bulk-write-files, etc.
const createToolExecutors = (cloudRunUrl) => ({
  // View file or directory - uses GET /api/read-file
  async mcp_view_file({ path: filePath, view_range }) {
    try {
      const params = new URLSearchParams({ path: filePath });
      if (view_range) params.append('view_range', JSON.stringify(view_range));
      const response = await fetch(`${cloudRunUrl}/api/read-file?${params}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      return await response.json();
    } catch (err) {
      return { error: `Failed to call Cloud Run: ${err.message}` };
    }
  },

  // Create/write file - uses POST /api/write-file
  async mcp_create_file({ path: filePath, file_text }) {
    try {
      // Sanitize code content to fix LLM double-escaping issues (e.g., Gemini)
      const sanitizedContent = sanitizeCodeContent(file_text);
      const response = await fetch(`${cloudRunUrl}/api/write-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, file_text: sanitizedContent })
      });
      return await response.json();
    } catch (err) {
      return { error: `Failed to call Cloud Run: ${err.message}` };
    }
  },

  // Bulk view files - uses POST /api/bulk-read-files
  async mcp_view_bulk({ paths }) {
    try {
      const response = await fetch(`${cloudRunUrl}/api/bulk-read-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths })
      });
      return await response.json();
    } catch (err) {
      return { error: `Failed to call Cloud Run: ${err.message}` };
    }
  },

  // Crawl/fetch webpage content using Jina AI Reader (free, no API key)
  async crawl_tool({ url, formats = 'markdown' }) {
    if (!url) {
      return { error: 'url is required' };
    }
    try {
      // Jina AI Reader - prefix URL to get markdown content
      const jinaUrl = `https://r.jina.ai/${url}`;
      const response = await fetch(jinaUrl, {
        headers: {
          'Accept': 'text/plain',
        }
      });

      if (!response.ok) {
        return { error: `Failed to fetch: ${response.status} ${response.statusText}` };
      }

      const content = await response.text();
      return {
        success: true,
        url,
        format: formats,
        content,
        length: content.length
      };
    } catch (err) {
      return { error: `Failed to crawl URL: ${err.message}` };
    }
  },

  // Web search using Google Custom Search API
  async web_search_tool_v2({ query, num_results = 5 }) {
    if (!query) {
      return { error: 'query is required' };
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    const cx = process.env.GOOGLE_CX;

    if (!apiKey || !cx) {
      return { error: 'Google Search API not configured. Set GOOGLE_API_KEY and GOOGLE_CX environment variables.' };
    }

    try {
      const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=${Math.min(num_results, 10)}`;
      const response = await fetch(searchUrl);

      if (!response.ok) {
        const errorData = await response.json();
        return { error: `Google Search API error: ${errorData.error?.message || response.statusText}` };
      }

      const data = await response.json();
      const results = (data.items || []).map(item => ({
        title: item.title,
        url: item.link,
        snippet: item.snippet,
        displayLink: item.displayLink
      }));

      return {
        success: true,
        query,
        totalResults: data.searchInformation?.totalResults || '0',
        results
      };
    } catch (err) {
      return { error: `Web search failed: ${err.message}` };
    }
  },

  // Bulk write files - uses POST /api/bulk-write-files
  async mcp_bulk_file_writer({ files }) {
    try {
      // Sanitize code content in each file to fix LLM double-escaping issues
      const sanitizedFiles = files.map(f => ({
        ...f,
        content: sanitizeCodeContent(f.content)
      }));
      const response = await fetch(`${cloudRunUrl}/api/bulk-write-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: sanitizedFiles })
      });
      return await response.json();
    } catch (err) {
      return { error: `Failed to call Cloud Run: ${err.message}` };
    }
  },

  // Search and replace - uses POST /api/search-replace
  async mcp_search_replace({ path: filePath, old_str, new_str, replace_all }) {
    try {
      const response = await fetch(`${cloudRunUrl}/api/search-replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, old_str, new_str, replace_all })
      });
      return await response.json();
    } catch (err) {
      return { error: `Failed to call Cloud Run: ${err.message}` };
    }
  },

  // Rename/move file - uses POST /api/rename-file
  async mcp_rename({ original_path, new_path }) {
    try {
      const response = await fetch(`${cloudRunUrl}/api/rename-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ original_path, new_path })
      });
      return await response.json();
    } catch (err) {
      return { error: `Failed to call Cloud Run: ${err.message}` };
    }
  },

  // Finish tool - provides summary for context continuity
  async finish({ summary }) {
    if (!summary) {
      return { error: 'summary is required' };
    }

    console.log('[FINISH] Task Summary:', summary);

    return {
      success: true,
      summary,
      timestamp: new Date().toISOString(),
      message: 'Task completed and summary recorded'
    };
  },

  // TEMPORARILY DISABLED - execute_bash
  // async execute_bash({ command }) {
  //   try {
  //     const response = await fetch(`${cloudRunUrl}/api/execute-bash`, {
  //       method: 'POST',
  //       headers: { 'Content-Type': 'application/json' },
  //       body: JSON.stringify({ command })
  //     });
  //     return await response.json();
  //   } catch (err) {
  //     return { error: `Failed to call Cloud Run: ${err.message}` };
  //   }
  // }

  // Add npm dependency - uses POST /api/add-dependency
  async mcp_add_dependency({ packageName, isDev = false }) {
    try {
      const response = await fetch(`${cloudRunUrl}/api/add-dependency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageName, isDev })
      });
      return await response.json();
    } catch (err) {
      return { error: `Failed to call Cloud Run: ${err.message}` };
    }
  },

  // Remove npm dependency - uses POST /api/remove-dependency
  async mcp_remove_dependency({ packageName }) {
    try {
      const response = await fetch(`${cloudRunUrl}/api/remove-dependency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageName })
      });
      return await response.json();
    } catch (err) {
      return { error: `Failed to call Cloud Run: ${err.message}` };
    }
  },

  // Add Python dependency - uses POST /api/add-python-dependency
  async mcp_add_python_dependency({ packageName, version }) {
    try {
      const response = await fetch(`${cloudRunUrl}/api/add-python-dependency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageName, version })
      });
      return await response.json();
    } catch (err) {
      return { error: `Failed to call Cloud Run: ${err.message}` };
    }
  },

  // Remove Python dependency - uses POST /api/remove-python-dependency
  async mcp_remove_python_dependency({ packageName }) {
    try {
      const response = await fetch(`${cloudRunUrl}/api/remove-python-dependency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageName })
      });
      return await response.json();
    } catch (err) {
      return { error: `Failed to call Cloud Run: ${err.message}` };
    }
  },

  // Get backend logs - uses GET /api/backend-logs
  async mcp_get_backend_logs({ clear = false }) {
    try {
      const params = new URLSearchParams();
      if (clear) params.append('clear', 'true');
      params.append('limit', '50');

      const response = await fetch(`${cloudRunUrl}/api/backend-logs?${params}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();

      // Format errors nicely for the AI
      if (data.hasErrors && data.errors && data.errors.length > 0) {
        data.errorSummary = `⚠️ BACKEND ERRORS FOUND (${data.errorCount}):\n${data.errors.slice(0, 10).join('\n\n')}`;
      }

      return data;
    } catch (err) {
      return { error: `Failed to fetch backend logs: ${err.message}` };
    }
  },

  // Get Vite/frontend logs - uses GET /api/console-logs
  async mcp_get_vite_logs({ type = 'all', clear = false }) {
    try {
      const params = new URLSearchParams();
      params.append('type', type);
      if (clear) params.append('clear', 'true');

      const response = await fetch(`${cloudRunUrl}/api/console-logs?${params}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();

      // Format errors nicely for the AI
      if (data.hasErrors && data.errorCount > 0) {
        data.errorSummary = `⚠️ VITE BUILD ERRORS FOUND (${data.errorCount}):\n${data.logs.slice(0, 10).join('\n\n')}`;
      }

      return data;
    } catch (err) {
      return { error: `Failed to fetch Vite logs: ${err.message}` };
    }
  },


  // Build frontend - uses POST /api/build
  async mcp_build_frontend({ mode = 'production' }) {
    try {
      console.log(`[Build] Starting ${mode} build...`);

      const response = await fetch(`${cloudRunUrl}/api/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      const data = await response.json();

      

      if (data.success) {
        return {
          success: true,
          message: data.message,
          mode: data.mode,
          duration: data.duration,
          buildOutput: data.stdout || '',
          warnings: data.stderr || ''
        };
      } else {
        return {
          success: false,
          message: 'Build failed',
          mode: data.mode,
          duration: data.duration,
          error: data.stderr || data.stdout || 'Unknown error',
          exitCode: data.exitCode
        };
      }
    } catch (err) {
      return { error: `Failed to build frontend: ${err.message}` };
    }
  },

  // Take screenshot - uses POST /api/screenshot
  async mcp_screenshot({ path = '/', fullPage = false, width = 1280, height = 720, selector = null, waitFor = 2000 }) {
    try {
      // Build full URL with the specified path
      const cleanPath = path.startsWith('/') ? path : `/${path}`;
      const targetUrl = `http://localhost:5173${cleanPath}`;

      console.log(`[Screenshot] Capturing: ${targetUrl}`);

      const response = await fetch(`${cloudRunUrl}/api/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,  // Screenshot the specified route
          fullPage,
          width,
          height,
          selector,
          waitFor
        })
      });
      const data = await response.json();

      if (data.success) {
        // Return info for AI (base64 image is large, so summarize)
        const result = {
          success: true,
          message: `📸 Screenshot of "${cleanPath}" captured (${Math.round(data.size / 1024)}KB)`,
          path: cleanPath,
          url: targetUrl,
          dimensions: data.dimensions,
          imageBase64: data.image,  // The actual screenshot
          mimeType: data.mimeType
        };

        // Pass through console errors from browser - CRITICAL for debugging!
        if (data.consoleErrors && data.consoleErrors.length > 0) {
          result.consoleErrors = data.consoleErrors;
          result.hasErrors = true;
          result.message += ` ⚠️ ${data.consoleErrors.length} console errors detected!`;
        }

        return result;
      } else {
        return { error: data.error, hint: data.hint, path: cleanPath };
      }
    } catch (err) {
      return { error: `Failed to take screenshot: ${err.message}` };
    }
  },

  // Take multiple screenshots in one call - more efficient!
  async mcp_screenshot_bulk({ paths, width = 1280, height = 720, waitFor = 2000 }) {
    try {
      // Limit to 5 paths max to avoid overwhelming the system
      const limitedPaths = paths.slice(0, 5);

      console.log(`[Screenshot Bulk] Capturing ${limitedPaths.length} pages...`);

      const results = [];

      for (const routePath of limitedPaths) {
        const cleanPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
        const targetUrl = `http://localhost:5173${cleanPath}`;

        console.log(`[Screenshot Bulk] Capturing: ${targetUrl}`);

        try {
          const response = await fetch(`${cloudRunUrl}/api/screenshot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: targetUrl,
              fullPage: false,
              width,
              height,
              waitFor
            })
          });
          const data = await response.json();

          if (data.success) {
            const result = {
              success: true,
              path: cleanPath,
              url: targetUrl,
              size: `${Math.round(data.size / 1024)}KB`,
              dimensions: data.dimensions,
              imageBase64: data.image,
              mimeType: data.mimeType
            };

            if (data.consoleErrors && data.consoleErrors.length > 0) {
              result.consoleErrors = data.consoleErrors;
              result.hasErrors = true;
            }

            results.push(result);
          } else {
            results.push({ success: false, path: cleanPath, error: data.error });
          }
        } catch (err) {
          results.push({ success: false, path: cleanPath, error: err.message });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const errorCount = results.filter(r => r.hasErrors).length;

      return {
        success: true,
        message: `📸 Captured ${successCount}/${limitedPaths.length} screenshots${errorCount > 0 ? ` (${errorCount} with console errors!)` : ''}`,
        screenshots: results
      };
    } catch (err) {
      return { error: `Failed to take bulk screenshots: ${err.message}` };
    }
  }
});

// Extract clean error message from verbose Vite error
function cleanViteError(errorMsg) {
  if (!errorMsg) return null;

  // Extract the key error info - look for common patterns
  // Pattern 1: "Failed to resolve import X from Y"
  const importMatch = errorMsg.match(/Failed to resolve import ["']([^"']+)["'] from ["']([^"']+)["']/);
  if (importMatch) {
    return `Missing import: "${importMatch[1]}" in ${importMatch[2]}`;
  }

  // Pattern 2: "Expected X, got Y" (JSX syntax errors)
  const syntaxMatch = errorMsg.match(/Expected ['"]?([^'"]+)['"]?, got ['"]?([^'"]+)['"]?/);
  if (syntaxMatch) {
    const fileMatch = errorMsg.match(/File: ([^\n]+)/);
    const file = fileMatch ? fileMatch[1].replace('/app/project/frontend/', '') : 'unknown';
    return `Syntax error in ${file}: Expected ${syntaxMatch[1]}, got ${syntaxMatch[2]}`;
  }

  // Pattern 3: Pre-transform error
  const preTransformMatch = errorMsg.match(/\[vite\] (?:Pre-transform error|Internal server error): (.+?)(?:\n|$)/);
  if (preTransformMatch) {
    return preTransformMatch[1].slice(0, 150);
  }

  // Pattern 4: General error - just get first line
  const firstLine = errorMsg.split('\n')[0];
  if (firstLine.length > 150) {
    return firstLine.slice(0, 150) + '...';
  }
  return firstLine;
}

// Fetch Vite console logs (especially errors) from Cloud Run container
async function fetchViteLogs(cloudRunUrl) {
  try {
    const response = await fetch(`${cloudRunUrl}/api/console-logs?type=errors&clear=true`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();

    // Clean up the error messages to remove stack traces
    if (data && data.rawLogs && data.rawLogs.length > 0) {
      // Get unique clean errors (deduplicate)
      const seenErrors = new Set();
      const cleanErrors = [];

      for (const log of data.rawLogs) {
        const cleanMsg = cleanViteError(log.message);
        if (cleanMsg && !seenErrors.has(cleanMsg)) {
          seenErrors.add(cleanMsg);
          cleanErrors.push(cleanMsg);
        }
      }

      data.cleanErrors = cleanErrors;
    }

    return data;
  } catch (err) {
    console.log(`[Vite Logs] Failed to fetch: ${err.message}`);
    return null;
  }
}

// Fetch TypeScript errors (catches errors Vite HMR misses - lazy-loaded pages, unused components)
async function fetchTypeScriptErrors(cloudRunUrl) {
  try {
    const response = await fetch(`${cloudRunUrl}/api/typescript-check`);
    const data = await response.json();
    return data;
  } catch (err) {
    console.log(`[TS Check] Failed to fetch: ${err.message}`);
    return null;
  }
}

// Execute a tool call
async function executeTool(toolExecutors, name, input, cloudRunUrl) {
  const toolStartTime = Date.now();
  console.log(`[Tool Call] ${name} started...`, JSON.stringify(input).slice(0, 200));
  const executor = toolExecutors[name];
  if (!executor) return { error: `Unknown tool: ${name}` };
  const result = await executor(input);
  const toolDuration = ((Date.now() - toolStartTime) / 1000).toFixed(2);
  console.log(`[Tool Result] ${name} completed in ${toolDuration}s:`, JSON.stringify(result).slice(0, 300));

  // For file-modifying tools, check for errors
  if (FILE_MODIFYING_TOOLS.includes(name) && cloudRunUrl) {
    // Wait for Vite to process the file change
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Check Vite HMR errors (fast, catches currently loaded modules)
    const viteLogs = await fetchViteLogs(cloudRunUrl);
    if (viteLogs && viteLogs.hasErrors && viteLogs.cleanErrors && viteLogs.cleanErrors.length > 0) {
      const errors = viteLogs.cleanErrors.slice(0, 5);
      console.log(`[Vite Errors] Found ${errors.length} errors after ${name}:`, errors);
      result.vite_errors = errors;
      result.vite_error_message = `⚠️ VITE BUILD ERROR! Fix these before proceeding:\n${errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}`;
    }

    // Also run TypeScript check (catches ALL errors including lazy-loaded pages)
    const tsCheck = await fetchTypeScriptErrors(cloudRunUrl);
    if (tsCheck && tsCheck.hasErrors && tsCheck.errors && tsCheck.errors.length > 0) {
      const tsErrors = tsCheck.errors.slice(0, 5);
      console.log(`[TS Errors] Found ${tsErrors.length} TypeScript errors after ${name}:`, tsErrors);
      result.ts_errors = tsErrors;
      result.ts_error_message = `⚠️ TYPESCRIPT ERRORS! These will break other pages. Fix now:\n${tsErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}`;
    }
  }

  return result;
}

// Helper: Save message to MongoDB (supports tool_calls and tool_call_id)
async function saveMessage(db, chatId, role, content, extras = {}) {
  const doc = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    conversation_id: chatId,
    role,
    content,
    sender: role === 'user' ? 'user' : (role === 'tool' ? 'tool' : 'bot'),
    timestamp: new Date().toISOString(),
    ...extras
  };
  await db.collection('messages').insertOne(doc);
}

// Middleware
app.use(cors());
app.use(express.json());

// Connect to MongoDB on startup
connectMongo().catch(console.error);

// ============ CONVERSATION ENDPOINTS ============

// GET /api/conversations - List all conversations
app.get('/api/conversations', async (req, res) => {
  try {
    const db = await connectMongo();
    const conversations = await db.collection('conversations')
      .find({})
      .sort({ updated_at: -1 })
      .toArray();
    res.json(conversations);
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conversations/:chatId - Get single conversation
app.get('/api/conversations/:chatId', async (req, res) => {
  try {
    const db = await connectMongo();
    const convo = await db.collection('conversations').findOne({ id: req.params.chatId });
    if (!convo) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    res.json(convo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conversations - Create new conversation AND deploy Cloud Run container
app.post('/api/conversations', async (req, res) => {
  try {
    const { title, initial_prompt } = req.body;
    const chatId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const serviceName = `greta-${chatId}`;

    const db = await connectMongo();
    const convo = {
      id: chatId,
      title: title || `Project ${chatId.slice(0, 8)}`,
      status: 'creating',
      preview_url: `https://${serviceName}-671515087993.${GCP_REGION}.run.app`,
      initial_prompt: initial_prompt || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await db.collection('conversations').insertOne(convo);
    console.log(`✅ Created conversation: ${chatId}`);

    // Respond immediately so UI doesn't wait
    res.json(convo);

    // Deploy Cloud Run container in background
    deployCloudRunContainer(chatId, serviceName, db);

  } catch (err) {
    console.error('Error creating conversation:', err);
    res.status(500).json({ error: err.message });
  }
});

// Deploy Cloud Run container for a chat
async function deployCloudRunContainer(chatId, serviceName, db) {
  console.log(`🚀 Deploying Cloud Run container: ${serviceName}...`);

  const envVars = `PROJECT_ID=${chatId},GCS_BUCKET=${GCS_BUCKET},MONGO_URL=${MONGO_URL},DB_NAME=${DB_NAME}`;

  const cmd = `gcloud run deploy ${serviceName} \
    --image=${CONTAINER_IMAGE} \
    --region=${GCP_REGION} \
    --allow-unauthenticated \
    --set-env-vars="${envVars}" \
    --memory=4Gi \
    --cpu=1 \
    --timeout=3600 \
    --min-instances=0 \
    --max-instances=1 \
    --execution-environment=gen2 \
    --project=${GCP_PROJECT}`;

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 300000 }); // 5 min timeout
    console.log(`✅ Container deployed: ${serviceName}`);
    console.log(stdout);

    // Update conversation status
    await db.collection('conversations').updateOne(
      { id: chatId },
      { $set: { status: 'running', updated_at: new Date().toISOString() } }
    );
  } catch (err) {
    console.error(`❌ Failed to deploy container: ${err.message}`);
    await db.collection('conversations').updateOne(
      { id: chatId },
      { $set: { status: 'error', error: err.message, updated_at: new Date().toISOString() } }
    );
  }
}

// GET /api/latest-version - Get latest available image version
app.get('/api/latest-version', (req, res) => {
  res.json({
    version: LATEST_IMAGE_VERSION,
    image: CONTAINER_IMAGE
  });
});

// POST /api/conversations/:chatId/redeploy - Redeploy container to latest image
app.post('/api/conversations/:chatId/redeploy', async (req, res) => {
  try {
    const { chatId } = req.params;
    const db = await connectMongo();

    // Find conversation
    const convo = await db.collection('conversations').findOne({ id: chatId });
    if (!convo) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const serviceName = `greta-${chatId}`;

    // Update status to 'updating'
    await db.collection('conversations').updateOne(
      { id: chatId },
      { $set: { status: 'updating', updated_at: new Date().toISOString() } }
    );

    // Respond immediately so UI doesn't wait
    res.json({
      success: true,
      message: 'Redeployment started',
      chatId,
      newVersion: LATEST_IMAGE_VERSION
    });

    // Redeploy in background
    console.log(`🔄 Redeploying container ${serviceName} to latest image...`);
    deployCloudRunContainer(chatId, serviceName, db);

  } catch (err) {
    console.error('Error redeploying container:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conversations/:chatId/messages - Get messages
app.get('/api/conversations/:chatId/messages', async (req, res) => {
  try {
    const db = await connectMongo();
    const messages = await db.collection('messages')
      .find({ conversation_id: req.params.chatId })
      .sort({ timestamp: 1 })
      .toArray();
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat - Real AI chat endpoint with OpenRouter + Tool Calling + Agentic Loop
app.post('/api/chat', async (req, res) => {
  const {
    message,
    chat_uuid,
    image_url = '',  // Optional image URL for vision support
    model = DEFAULT_MODEL,
    max_tokens = DEFAULT_MAX_TOKENS,
    temperature = DEFAULT_TEMPERATURE,
    api_key
  } = req.body;

  if (!message && !image_url) {
    return res.status(400).json({ error: 'message or image_url is required' });
  }

  const chatId = chat_uuid || `chat-${Date.now()}`;
  console.log(`\n========== NEW CHAT REQUEST ==========`);
  console.log(`[Chat API] chatId: ${chatId}`);
  console.log(`[Chat API] model: ${model}`);
  console.log(`[Chat API] message: ${message ? message.slice(0, 100) : '(no message)'}...`);
  console.log(`[Chat API] image_url: ${image_url ? image_url.slice(0, 80) + '...' : 'NONE'}`);

  // Check if API key is available
  const effectiveApiKey = api_key || OPEN_ROUTER_API_KEY;
  if (!effectiveApiKey) {
    return res.status(400).json({
      error: 'OpenRouter API key required. Set OPEN_ROUTER_API_KEY env var or pass api_key in request body.'
    });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const db = await connectMongo();

    // Get Cloud Run URL for this chat (for tool execution)
    const cloudRunUrl = `https://greta-${chatId}-671515087993.${GCP_REGION}.run.app`;
    const toolExecutors = createToolExecutors(cloudRunUrl);
    console.log(`[Chat API] Cloud Run URL for tools: ${cloudRunUrl}`);

    // Save user message (WITHOUT image_url - images are one-time use, not stored in history)
    await saveMessage(db, chatId, 'user', message);

    // Get project file structure from Cloud Run
    let projectStructure = '';
    try {
      const structureRes = await fetch(`${cloudRunUrl}/api/list-files`);
      if (structureRes.ok) {
        const structureData = await structureRes.json();
        if (structureData.files && structureData.files.length > 0) {
          // Format as tree-like structure
          const fileList = structureData.files.join('\n');
          projectStructure = `\n\n<CURRENT_PROJECT_FILES>\nThese files currently exist in the project. DO NOT waste loops viewing files you've already seen - use this list to know what exists:\n\n${fileList}\n</CURRENT_PROJECT_FILES>\n`;
          console.log(`[Chat API] Project has ${structureData.files.length} files`);
        }
      }
    } catch (err) {
      console.log('[Chat API] Could not fetch project structure:', err.message);
    }

    // Load chat history (tool calls + results stored in same document)
    const dbMessages = await db.collection('messages')
      .find({ conversation_id: chatId })
      .sort({ timestamp: 1 })
      .toArray();

    console.log('\n' + '='.repeat(60));
    console.log('[HISTORY] Loading chat history from MongoDB...');
    console.log(`[HISTORY] Found ${dbMessages.length} messages in DB`);

    // Convert DB format to LLM API format
    // DB stores: { role: 'assistant', tool_calls: [{ id, function, result }] }
    // LLM needs: assistant message + separate tool messages
    const history = [];
    let skippedToolMessages = 0;

    // Helper to generate summary from tool calls
    const generateToolSummary = (toolCalls) => {
      return toolCalls.map(tc => {
        const name = tc.function?.name || 'unknown';
        const args = tc.function?.arguments;
        if (name === 'finish') {
          const parsed = typeof args === 'string' ? JSON.parse(args) : args;
          return `[FINISHED: ${parsed?.summary || 'Task completed'}]`;
        } else if (name.includes('file') || name.includes('write') || name.includes('create')) {
          return `[Used ${name} to modify files]`;
        } else {
          return `[Used ${name}]`;
        }
      }).join(' ');
    };

    for (const msg of dbMessages) {
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        // Generate summary of tool calls for history context
        const content = msg.content || generateToolSummary(msg.tool_calls);

        // MERGE consecutive assistant messages instead of adding multiple
        const lastEntry = history[history.length - 1];
        if (lastEntry && lastEntry.role === 'assistant') {
          // Append to existing assistant message with newline separator
          lastEntry.content += '\n' + content;
          console.log(`[HISTORY] Merged assistant action: ${content.substring(0, 60)}...`);
        } else {
          history.push({ role: 'assistant', content });
          console.log(`[HISTORY] Including assistant action: ${content.substring(0, 60)}...`);
        }
      } else if (msg.role === 'tool') {
        // Skip old-format tool messages too
        skippedToolMessages++;
      } else {
        // Regular user/assistant message - keep these (images not stored in history)
        // Also merge consecutive assistant messages here
        const lastEntry = history[history.length - 1];
        if (msg.role === 'assistant' && lastEntry && lastEntry.role === 'assistant') {
          lastEntry.content += '\n' + msg.content;
          console.log(`[HISTORY] Merged text assistant message`);
        } else {
          history.push({ role: msg.role, content: msg.content });
        }
      }
    }

    console.log(`[HISTORY] Skipped ${skippedToolMessages} old-format tool messages`);
    console.log(`[HISTORY] Final history entries for LLM: ${history.length}`);
    console.log('='.repeat(60) + '\n');

    // ============ EXTRACT RECENTLY MODIFIED FILES ============
    console.log('\n' + '='.repeat(60));
    console.log('[FILE CONTEXT] Extracting recently modified files...');
    console.log(`[FILE CONTEXT] Total messages in DB: ${dbMessages.length}`);

    const recentFilePaths = new Set();
    const fileModifyingTools = ['mcp_create_file', 'mcp_bulk_file_writer', 'mcp_search_replace'];

    // Helper to normalize paths for deduplication (handle /app/project/ prefix and variations)
    const normalizePath = (p) => {
      if (!p) return null;
      // Remove leading /app/project/ if present
      let normalized = p.replace(/^\/app\/project\//, '');
      // Also handle paths that start with just the directory
      normalized = normalized.replace(/^(frontend|backend)\//, '$1/');
      return normalized;
    };

    // Track normalized paths to prevent duplicates
    const normalizedPathSet = new Set();

    // Iterate from newest to oldest
    for (let i = dbMessages.length - 1; i >= 0 && recentFilePaths.size < 10; i--) {
      const msg = dbMessages[i];
      if (msg.role === 'assistant' && msg.tool_calls) {
        console.log(`[FILE CONTEXT] Checking msg[${i}]: assistant with ${msg.tool_calls.length} tool_calls`);
        for (const tc of msg.tool_calls) {
          if (recentFilePaths.size >= 10) break;
          const toolName = tc.function?.name;
          console.log(`[FILE CONTEXT]   - Tool: ${toolName}, has result: ${!!tc.result}`);

          if (fileModifyingTools.includes(toolName)) {
            try {
              const args = JSON.parse(tc.function.arguments);
              // mcp_create_file and mcp_search_replace have 'path'
              if (args.path) {
                const normalized = normalizePath(args.path);
                if (normalized && !normalizedPathSet.has(normalized)) {
                  console.log(`[FILE CONTEXT]     → Found path: ${args.path} (normalized: ${normalized})`);
                  normalizedPathSet.add(normalized);
                  recentFilePaths.add(args.path);
                } else if (normalized) {
                  console.log(`[FILE CONTEXT]     → Skipping duplicate: ${args.path}`);
                }
              }
              // mcp_bulk_file_writer has 'files' array with 'path' in each
              if (args.files && Array.isArray(args.files)) {
                for (const f of args.files) {
                  if (f.path && recentFilePaths.size < 10) {
                    const normalized = normalizePath(f.path);
                    if (normalized && !normalizedPathSet.has(normalized)) {
                      console.log(`[FILE CONTEXT]     → Found bulk path: ${f.path} (normalized: ${normalized})`);
                      normalizedPathSet.add(normalized);
                      recentFilePaths.add(f.path);
                    } else if (normalized) {
                      console.log(`[FILE CONTEXT]     → Skipping duplicate bulk path: ${f.path}`);
                    }
                  }
                }
              }
            } catch (e) {
              console.log(`[FILE CONTEXT]     ✗ Could not parse arguments: ${e.message}`);
            }
          }
        }
      }
    }

    console.log(`[FILE CONTEXT] Found ${recentFilePaths.size} unique file paths: ${[...recentFilePaths].join(', ')}`);

    // Helper to ensure consistent display path (always start with /app/project/)
    const toDisplayPath = (p) => {
      if (!p) return p;
      // Remove /app/project/ if present, then add it back for consistency
      const stripped = p.replace(/^\/app\/project\//, '');
      return `/app/project/${stripped}`;
    };

    // Fetch LATEST content of these files from Cloud Run container
    const recentFilesContext = [];
    if (recentFilePaths.size > 0) {
      console.log(`[FILE CONTEXT] Fetching file contents from Cloud Run...`);
      for (const filePath of recentFilePaths) {
        try {
          console.log(`[FILE CONTEXT]   Fetching: ${filePath}`);
          const result = await toolExecutors.mcp_view_file({ path: filePath });
          if (result.success && result.content) {
            recentFilesContext.push({
              path: toDisplayPath(filePath),  // Use consistent display path
              content: result.content
            });
            console.log(`[FILE CONTEXT]   ✓ Got: ${filePath} (${result.content.length} chars)`);
          } else {
            console.log(`[FILE CONTEXT]   ✗ Failed: ${filePath} - ${JSON.stringify(result)}`);
          }
        } catch (err) {
          console.log(`[FILE CONTEXT]   ✗ Error fetching ${filePath}: ${err.message}`);
        }
      }
      console.log(`[FILE CONTEXT] Successfully fetched ${recentFilesContext.length}/${recentFilePaths.size} files`);
    } else {
      console.log(`[FILE CONTEXT] No recent files to fetch`);
    }
    console.log('='.repeat(60) + '\n');

    // Create OpenRouter client
    const client = createOpenRouterClient(effectiveApiKey);

    // Build messages array for LLM - include project structure in system prompt
    const enhancedSystemPrompt = SYSTEM_PROMPT + projectStructure;
    const messages = [
      { role: 'system', content: enhancedSystemPrompt },
      ...history
    ];

    // Combine file context + current user message into ONE user message
    // Format: content: [{ type: 'text', text: 'file context' }, { type: 'text', text: 'user message' }]
    // This prevents AI confusion about what user actually asked
    if (recentFilesContext.length > 0) {
      const fileContextText = recentFilesContext.map(f =>
        `File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
      ).join('\n\n');

      // Find the last user message (current request) and modify it
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const userMessage = messages[i].content;
          const contentParts = [
            { type: 'text', text: `Here are the ${recentFilesContext.length} most recently modified files (current state):\n\n${fileContextText}` }
          ];

          // Add user's actual message
          if (typeof userMessage === 'string' && userMessage) {
            contentParts.push({ type: 'text', text: userMessage });
          } else if (Array.isArray(userMessage)) {
            contentParts.push(...userMessage);
          }

          // If image_url provided, add it too
          // if (image_url) {
            contentParts.push({ type: 'image_url', image_url: { url: image_url } });
            console.log(`[Chat API] Added image to current request (one-time, not stored in history)`);
          // }

          messages[i].content = contentParts;
          console.log(`[Chat API] Combined ${recentFilesContext.length} files + user message into single message`);
          break;
        }
      }
    } else if (image_url) {
      // No file context, but has image - just add image to last user message
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const currentContent = messages[i].content;
          const contentParts = [];
          if (typeof currentContent === 'string') {
            if (currentContent) {
              contentParts.push({ type: 'text', text: currentContent });
            }
          } else if (Array.isArray(currentContent)) {
            contentParts.push(...currentContent);
          }
          contentParts.pusnh({ type: 'image_url', image_url: { url: image_url } });
          messages[i].content = contentParts;
          console.log(`[Chat API] Added image to current request (one-time, not stored in history)`);
          break;
        }
      }
    }

    
    // ============ DEBUG: LOG FULL CONTEXT BEING SENT TO AI ============
    console.log('\n' + '='.repeat(80));
    console.log('[AI CONTEXT] Full payload being sent to OpenRouter:');
    console.log('='.repeat(80));
    console.log(`[AI CONTEXT] Model: ${model}`);
    console.log(`[AI CONTEXT] Max Tokens: ${max_tokens}`);
    console.log(`[AI CONTEXT] Temperature: ${temperature}`);
    console.log(`[AI CONTEXT] Tools: ${TOOLS.map(t => t.function.name).join(', ')}`);
    console.log('-'.repeat(80));
    console.log(`[AI CONTEXT] System Prompt Length: ${enhancedSystemPrompt.length} chars (base: ${SYSTEM_PROMPT.length} + project structure)`);
    console.log(`[AI CONTEXT] Project Structure Included: ${projectStructure ? 'YES' : 'NO'}`);
    console.log('-'.repeat(80));
    console.log(`[AI CONTEXT] Conversation History: ${history.length} messages`);
    history.forEach((msg, i) => {
      const contentPreview = typeof msg.content === 'string'
        ? msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : '')
        : JSON.stringify(msg.content).substring(0, 200);
      console.log(`  [${i}] ${msg.role}: ${contentPreview}`);
    });
    console.log('-'.repeat(80));
    console.log(`[AI CONTEXT] Total Messages: ${messages.length} (1 system + ${history.length} history)`);
    console.log('='.repeat(80) + '\n');

    console.log(`[Chat API] Starting with ${messages.length} messages`);

    // ============ AGENTIC LOOP ============
    const maxLoops = MAX_AGENTIC_LOOPS;
    let loopCount = 0;

    console.log(JSON.stringify(messages, null, 2));

    // return;

    while (loopCount < maxLoops) {
      loopCount++;
      const loopStartTime = Date.now();
      console.log(`\n[Chat API] ═══════════════ Loop ${loopCount}/${maxLoops} START ═══════════════`);

      // Send loop_start event so frontend knows agent is thinking
      sendSSE({ type: 'loop_start', loop: loopCount, maxLoops });

      // Create streaming chat completion WITH TOOLS
      const llmStartTime = Date.now();
      console.log(`[TIMING] LLM request started...`);
      const stream = await client.chat.completions.create({
        model,
        max_tokens,
        messages,
        tools: TOOLS,
        temperature,
        stream: true,
        reasoning: {
          max_tokens: 1000
        }
      });

      // Process stream
      let currentText = '';
      const toolCalls = new Map();

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Handle text content
        if (delta.content) {
          currentText += delta.content;
          sendSSE({ type: 'chunk', content: delta.content });
        }

        // Handle tool calls
        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const index = toolCall.index;
            if (!toolCalls.has(index)) {
              toolCalls.set(index, {
                id: toolCall.id || `tool_${index}`,
                name: toolCall.function?.name || '',
                arguments: ''
              });
            }
            const current = toolCalls.get(index);
            if (toolCall.function?.name) current.name = toolCall.function.name;
            if (toolCall.function?.arguments) current.arguments += toolCall.function.arguments;
          }
        }
      }

      const llmEndTime = Date.now();
      console.log(`[TIMING] LLM streaming completed in ${((llmEndTime - llmStartTime) / 1000).toFixed(2)}s`);

      // Process tool calls if any
      if (toolCalls.size > 0) {
        const toolCallsArray = [];
        for (const [, tc] of toolCalls) {
          let parsedArgs = {};
          try {
            parsedArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
          } catch (e) {
            console.error('Failed to parse tool args for', tc.name);
            console.error('Args length:', tc.arguments?.length);
            console.error('Args start:', tc.arguments?.slice(0, 200));
            console.error('Args end:', tc.arguments?.slice(-200));
            // Try to salvage partial JSON for debugging
          }
          toolCallsArray.push({ id: tc.id, name: tc.name, input: parsedArgs });
        }

        console.log(`[Chat API] Got ${toolCallsArray.length} tool calls`);

        // Execute tools FIRST, collect results, then save ONE combined document
        let hasFileChanges = false;
        let finishCalled = false;
        const toolCallsWithResults = [];

        for (const tc of toolCallsArray) {
          const toolStartTime = Date.now();
          sendSSE({ type: 'tool_call', name: tc.name, input: tc.input, status: 'executing' });

          // Send file_change events BEFORE executing for real-time display
          if (tc.name === 'mcp_bulk_file_writer' && tc.input.files) {
            for (const file of tc.input.files) {
              sendSSE({
                type: 'file_change',
                path: file.path.replace('/app/project/', ''),
                content: file.content,
                operation: 'create',
                tool: tc.name
              });
            }
          } else if (tc.name === 'mcp_create_file' && tc.input.path) {
            sendSSE({
              type: 'file_change',
              path: tc.input.path.replace('/app/project/', ''),
              content: tc.input.content,
              operation: 'create',
              tool: tc.name
            });
          } else if (tc.name === 'mcp_search_replace' && tc.input.path) {
            sendSSE({
              type: 'file_change',
              path: tc.input.path.replace('/app/project/', ''),
              oldStr: tc.input.old_str,
              newStr: tc.input.new_str,
              operation: 'replace',
              tool: tc.name
            });
          }

          const result = await executeTool(toolExecutors, tc.name, tc.input, cloudRunUrl);
          const toolDuration = ((Date.now() - toolStartTime) / 1000).toFixed(2);
          sendSSE({ type: 'tool_result', name: tc.name, result, duration: toolDuration, status: 'completed' });

          // Track if any file-modifying tools were called
          if (['mcp_create_file', 'mcp_bulk_file_writer', 'mcp_search_replace'].includes(tc.name)) {
            hasFileChanges = true;
          }

          // Track if finish tool was called - agent is done with task
          if (tc.name === 'finish') {
            finishCalled = true;
            console.log(`[Chat API] 🏁 Agent called finish tool - will exit loop after saving`);
          }

          // Store tool call with its result
          const toolCallWithResult = {
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            result: typeof result === 'string' ? result : JSON.stringify(result)
          };

          // Handle screenshot specially - don't store base64 in DB
          if (tc.name === 'mcp_screenshot' && result.success && result.imageBase64) {
            // Save screenshot locally for debugging
            const screenshotDir = path.join(__dirname, 'screenshots');
            if (!fs.existsSync(screenshotDir)) {
              fs.mkdirSync(screenshotDir, { recursive: true });
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const screenshotPath = path.join(screenshotDir, `screenshot-${timestamp}.png`);
            fs.writeFileSync(screenshotPath, Buffer.from(result.imageBase64, 'base64'));
            console.log(`[Chat API] 📸 Screenshot saved to: ${screenshotPath}`);

            // Build result with console errors if present
            const screenshotResult = {
              success: true,
              message: result.message,
              dimensions: result.dimensions,
              savedTo: screenshotPath
            };

            // Include console errors so agent can debug!
            if (result.consoleErrors && result.consoleErrors.length > 0) {
              screenshotResult.consoleErrors = result.consoleErrors;
              screenshotResult.hasErrors = true;
              console.log(`[Chat API] ⚠️ Screenshot captured ${result.consoleErrors.length} console errors`);
            }

            toolCallWithResult.result = JSON.stringify(screenshotResult);

            // Build text context for the agent
            let screenshotContext = `Here is the screenshot (${result.dimensions?.width}x${result.dimensions?.height}).`;

            // If there are console errors, include them prominently!
            if (result.consoleErrors && result.consoleErrors.length > 0) {
              screenshotContext += `\n\n🚨 BROWSER CONSOLE ERRORS DETECTED:\n`;
              result.consoleErrors.forEach((err, i) => {
                screenshotContext += `${i + 1}. ${err}\n`;
              });
              screenshotContext += `\nFIX THESE ERRORS - they explain why the page may be blank or broken.`;
            } else {
              screenshotContext += ` Analyze what you see.`;
            }

            // Add image as user message so LLM can see it (in memory only)
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${result.imageBase64}` }
                },
                {
                  type: 'text',
                  text: screenshotContext
                }
              ]
            });
            console.log(`[Chat API] 📸 Screenshot added as vision content`);
          }

          // Handle bulk screenshots - add multiple images for the agent to see
          if (tc.name === 'mcp_screenshot_bulk' && result.success && result.screenshots) {
            const screenshotDir = path.join(__dirname, 'screenshots');
            if (!fs.existsSync(screenshotDir)) {
              fs.mkdirSync(screenshotDir, { recursive: true });
            }

            // Build multimodal content with all screenshots
            const contentParts = [];
            let contextText = `📸 Bulk screenshots captured (${result.screenshots.length} pages):\n\n`;

            for (const screenshot of result.screenshots) {
              if (screenshot.success && screenshot.imageBase64) {
                // Save locally
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const screenshotPath = path.join(screenshotDir, `screenshot-bulk-${screenshot.path.replace(/\//g, '-')}-${timestamp}.png`);
                fs.writeFileSync(screenshotPath, Buffer.from(screenshot.imageBase64, 'base64'));
                console.log(`[Chat API] 📸 Bulk screenshot saved: ${screenshotPath}`);

                // Add to vision content
                contentParts.push({
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${screenshot.imageBase64}` }
                });

                // Build context text
                contextText += `📄 ${screenshot.path}:\n`;
                if (screenshot.hasErrors && screenshot.consoleErrors) {
                  contextText += `  🚨 ERRORS:\n`;
                  screenshot.consoleErrors.forEach((err, i) => {
                    contextText += `    ${i + 1}. ${err}\n`;
                  });
                } else {
                  contextText += `  ✅ No console errors\n`;
                }
                contextText += `\n`;
              }
            }

            // Add text context
            contentParts.push({
              type: 'text',
              text: contextText + '\nAnalyze these screenshots and fix any issues.'
            });

            // Add all images as single user message
            messages.push({
              role: 'user',
              content: contentParts
            });

            // Clear imageBase64 from stored result (too large for DB)
            const cleanResult = {
              ...result,
              screenshots: result.screenshots.map(s => ({
                success: s.success,
                path: s.path,
                hasErrors: s.hasErrors,
                consoleErrors: s.consoleErrors,
                error: s.error
              }))
            };
            toolCallWithResult.result = JSON.stringify(cleanResult);

            console.log(`[Chat API] 📸 Bulk screenshots (${result.screenshots.length}) added as vision content`);
          }

          toolCallsWithResults.push(toolCallWithResult);

          // Add tool result to messages array for LLM (required by API)
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: toolCallWithResult.result
          });
        }

        // Build tool_calls for OpenAI API format (without results - API doesn't accept them)
        const toolCallsForMessage = toolCallsWithResults.map(tc => ({
          id: tc.id,
          type: 'function',
          function: tc.function
        }));

        // Insert assistant message BEFORE tool results in messages array
        const insertIndex = messages.length - toolCallsWithResults.length;
        messages.splice(insertIndex, 0, {
          role: 'assistant',
          content: currentText || null,
          tool_calls: toolCallsForMessage
        });

        // Save ONE document to MongoDB with tool_calls AND results together
        console.log('\n' + '-'.repeat(60));
        console.log('[STORAGE] Saving assistant message with tool_calls + results:');
        console.log(`[STORAGE] Content: ${currentText ? currentText.substring(0, 100) + '...' : 'null'}`);
        console.log(`[STORAGE] Tool calls count: ${toolCallsWithResults.length}`);
        toolCallsWithResults.forEach((tc, i) => {
          const argsPreview = tc.function.arguments.substring(0, 100);
          const resultPreview = tc.result.substring(0, 100);
          console.log(`[STORAGE]   [${i}] ${tc.function.name}`);
          console.log(`[STORAGE]       args: ${argsPreview}...`);
          console.log(`[STORAGE]       result: ${resultPreview}...`);
        });

        await saveMessage(db, chatId, 'assistant', currentText || null, {
          tool_calls: toolCallsWithResults  // Contains: id, function (name + arguments), result
        });
        console.log(`[STORAGE] ✓ Saved to MongoDB: ${toolCallsWithResults.length} tool calls with results`);
        console.log('-'.repeat(60) + '\n');

        // Signal frontend to refresh preview if files were changed
        if (hasFileChanges) {
          sendSSE({ type: 'refresh_preview' });
        }

        const loopDuration = ((Date.now() - loopStartTime) / 1000).toFixed(2);
        console.log(`[Chat API] ═══════════════ Loop ${loopCount}/${maxLoops} END (${loopDuration}s) ═══════════════\n`);

        // Send loop_end event with timing info
        sendSSE({ type: 'loop_end', loop: loopCount, duration: loopDuration });

        // If finish tool was called, break out of the loop - agent is done
        if (finishCalled) {
          console.log(`[Chat API] 🏁 Breaking out of loop - finish tool was called`);
          break;
        }

        // Continue loop for next LLM response
        continue;
      }

      // No tool calls - done, save assistant response to MongoDB
      const loopDuration = ((Date.now() - loopStartTime) / 1000).toFixed(2);
      console.log(`[Chat API] No tool calls, finishing with ${currentText.length} chars (loop took ${loopDuration}s)`);
      await saveMessage(db, chatId, 'assistant', currentText);
      break;
    }

    sendSSE({ type: 'done', chat_uuid: chatId, loops: loopCount });
    res.end();

  } catch (err) {
    console.error('[Chat API] Error:', err);
    sendSSE({ type: 'error', message: err.message });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Local backend running at http://localhost:${PORT}`);
  console.log(`📦 MongoDB: ${DB_NAME}`);
  console.log(`\nEndpoints:`);
  console.log(`  POST /api/conversations - Create conversation`);
  console.log(`  GET  /api/conversations - List conversations`);
  console.log(`  POST /api/chat - Send message\n`);
});

