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
import { VITE_PORT, BACKEND_PORT, EXPRESS_API_ENDPOINTS, DEBOUNCE_DELAY } from '../core/config.js';
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

    // if (writeMethod && successStatus) {
    //   console.log(`📝 Write operation detected: ${req.method} ${req.originalUrl} - scheduling backup`);
    //   scheduleMongoBackup();
    // }
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
  ws: true, // Enable WebSocket for HMR

  logLevel: 'warn',

  onError: (err, req, res) => {
    console.error('Vite proxy error:', err.message);
    if (res.writeHead) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Vite not ready' }));
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
  console.log(`[API Route] ${req.method} ${req.path}`);
  
  // Check if this is an Express-handled endpoint
  if (EXPRESS_API_ENDPOINTS.some(ep => req.path.startsWith(ep))) {
    return next();
  }
  
  // Proxy to FastAPI backend
  return backendProxy(req, res, next);
}

/**
 * Vite router middleware.
 * Routes non-API requests to Vite frontend.
 */
export function viteRouter(req, res, next) {
  // Skip API and health endpoints
  if (req.path.startsWith('/api/') || req.path === '/health') {
    return next();
  }
  
  // Proxy to Vite
  return viteProxy(req, res, next);
}

