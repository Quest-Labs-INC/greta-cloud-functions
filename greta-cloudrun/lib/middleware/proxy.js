/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROXY MIDDLEWARE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * HTTP proxy middleware for routing requests to Vite (frontend) and 
 * FastAPI (backend) services. Includes automatic MongoDB backup on write ops.
 * 
 * @module middleware/proxy
 */

import { createProxyMiddleware } from 'http-proxy-middleware';
import { VITE_PORT, BACKEND_PORT, DEBOUNCE_DELAY } from '../core/config.js';
import { backupMongoToGCS } from '../services/processes/mongodb.js';


/* ─────────────────────────────────────────────────────────────────────────────
 * MONGODB BACKUP SCHEDULING
 * ───────────────────────────────────────────────────────────────────────────── */

let backupTimeout = null;
let backupPending = false;

/**
 * Schedule a debounced MongoDB backup.
 * Prevents backup spam on rapid write operations.
 */
function scheduleMongoBackup() {
  if (backupTimeout) {
    clearTimeout(backupTimeout);
  }
  backupPending = true;
  backupTimeout = setTimeout(async () => {
    if (backupPending) {
      console.log('💾 Triggering MongoDB backup after write operation...');
      try {
        await backupMongoToGCS();
        console.log('✅ MongoDB backup completed after write');
      } catch (error) {
        console.error('❌ MongoDB backup failed after write:', error.message);
      }
      backupPending = false;
    }
  }, DEBOUNCE_DELAY);
}


/* ─────────────────────────────────────────────────────────────────────────────
 * BACKEND PROXY (FASTAPI)
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Backend proxy middleware.
 * Routes /api/* requests to FastAPI and triggers backup on writes.
 */
export const backendProxy = createProxyMiddleware({
  target: `http://localhost:${BACKEND_PORT}`,
  changeOrigin: true,
  logLevel: 'debug',

  onProxyReq: (proxyReq, req, res) => {
    console.log(`[Proxy] ${req.method} ${req.originalUrl} -> ${proxyReq.path}`);
  },

  onProxyRes: (proxyRes, req, res) => {
    console.log(`[Proxy Response] ${req.method} ${req.originalUrl} -> ${proxyRes.statusCode}`);

    // Trigger backup after successful write operations
    const writeMethod = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
    const successStatus = proxyRes.statusCode >= 200 && proxyRes.statusCode < 300;

    if (writeMethod && successStatus) {
      console.log(`📝 Write operation detected: ${req.method} ${req.originalUrl} - scheduling backup`);
      scheduleMongoBackup();
    }
  },

  onError: (err, req, res) => {
    console.error('Backend proxy error:', err.message);
    if (res.writeHead) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Backend not ready' }));
    }
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * VITE PROXY (FRONTEND)
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Vite proxy middleware.
 * Routes frontend requests and WebSocket connections for HMR.
 */
export const viteProxy = createProxyMiddleware({
  target: `http://localhost:${VITE_PORT}`,
  changeOrigin: true,
  ws: true,
  proxyTimeout: 60000,
  timeout: 60000,

  logLevel: 'warn',

  onProxyReq: (proxyReq, req) => {
    req._viteProxyStart = Date.now();
    if (req.url?.includes('node_modules/.vite') || req.url?.includes('.tsx') || req.url?.includes('.ts')) {
      console.log(`[Vite] → ${req.method} ${req.url}`);
    }
  },

  onProxyRes: (proxyRes, req) => {
    if (req._viteProxyStart) {
      const duration = Date.now() - req._viteProxyStart;
      if (duration > 3000) {
        console.warn(`[Vite] ⚠️ SLOW response: ${req.url} took ${duration}ms (status ${proxyRes.statusCode})`);
      }
    }
  },

  onError: (err, req, res) => {
    const duration = req._viteProxyStart ? Date.now() - req._viteProxyStart : 0;
    console.error(`[Vite] ❌ PROXY ERROR after ${duration}ms: ${req.url} — ${err.message}`);
    if (res.writeHead) {
      res.writeHead(503, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="refresh" content="3">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #09090b; font-family: sans-serif; color: #666; gap: 16px; }
      .spinner { width: 36px; height: 36px; border: 3px solid #2a2a2a; border-top-color: #888; border-radius: 50%; animation: spin 0.8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      p { font-size: 13px; letter-spacing: 0.02em; }
    </style>
  </head>
  <body>
    <div class="spinner"></div>
    <p>Starting dev server...</p>
  </body>
</html>`);
    }
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * ROUTING MIDDLEWARE
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * API router middleware.
 * Routes /api/* to backend proxy, except Express-handled endpoints.
 */
export function apiRouter(req, res, next) {
  console.log(`[API Route -> FastAPI proxy] ${req.method} ${req.originalUrl}`);
  return backendProxy(req, res, next);
}

/**
 * Vite router middleware.
 * Routes non-API requests to Vite frontend.
 */
export function viteRouter(req, res, next) {
  // Use originalUrl (un-stripped) to reliably detect /api/* regardless of mount point
  if (req.originalUrl.startsWith('/api') || req.originalUrl === '/health') {
    console.warn(`[Vite Router] Unexpected /api path: ${req.method} ${req.originalUrl}`);
    return next();
  }

  console.log(`[Vite Route] ${req.method} ${req.originalUrl}`);
  return viteProxy(req, res, next);
}

