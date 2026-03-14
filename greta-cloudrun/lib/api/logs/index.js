/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LOGS API ROUTER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles log retrieval endpoints for Vite/frontend and Python backend.
 * Provides access to in-memory log buffers maintained in state.js
 *
 * Endpoints:
 * - GET /console-logs - Get Vite/frontend logs
 * - GET /backend-logs - Get Python backend logs
 * - GET /vite-errors - Get Vite compilation errors
 * - POST /clear-logs - Clear log buffers
 *
 * @module api/logs
 */

import express from 'express';
import { logs, clearLogs } from '../../core/state.js';

const router = express.Router();


/* ─────────────────────────────────────────────────────────────────────────────
 * GET /console-logs - Vite/Frontend Logs
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Get Vite/frontend console logs
 * @query {string} type - 'all' | 'errors' | 'logs' (default: 'all')
 * @query {boolean} clear - Clear logs after reading (default: false)
 * @query {number} limit - Max entries to return (default: 50)
 */
router.get('/console-logs', (req, res) => {
  const { type = 'all', clear = false, limit = 50 } = req.query;
  const maxEntries = Math.min(parseInt(limit) || 50, 200);

  let result = {
    logs: [],
    errors: [],
    hasErrors: false,
    errorCount: 0,
  };

  if (type === 'all' || type === 'logs') {
    result.logs = logs.vite.slice(-maxEntries).map(l => l.message);
  }

  if (type === 'all' || type === 'errors') {
    result.errors = logs.viteErrors.slice(-maxEntries).map(l => l.message);
    result.hasErrors = result.errors.length > 0;
    result.errorCount = result.errors.length;
  }

  if (clear === 'true' || clear === true) {
    clearLogs('vite');
  }

  res.json(result);
});


/* ─────────────────────────────────────────────────────────────────────────────
 * GET /backend-logs - Python Backend Logs
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Get Python/FastAPI backend logs
 * @query {boolean} clear - Clear logs after reading (default: false)
 * @query {number} limit - Max entries to return (default: 50)
 */
router.get('/backend-logs', (req, res) => {
  const { clear = false, limit = 50 } = req.query;
  const maxEntries = Math.min(parseInt(limit) || 50, 200);

  const result = {
    logs: logs.backend.slice(-maxEntries).map(l => l.message),
    errors: logs.backendErrors.slice(-maxEntries).map(l => l.message),
    hasErrors: logs.backendErrors.length > 0,
    errorCount: logs.backendErrors.length,
  };

  if (clear === 'true' || clear === true) {
    clearLogs('backend');
  }

  res.json(result);
});


/* ─────────────────────────────────────────────────────────────────────────────
 * GET /vite-errors - Vite Compilation Errors Only
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Get only Vite compilation/build errors
 * Useful for quick error checking without full logs
 */
router.get('/vite-errors', (req, res) => {
  const { limit = 20 } = req.query;
  const maxEntries = Math.min(parseInt(limit) || 20, 100);

  const errors = logs.viteErrors.slice(-maxEntries).map(l => l.message);

  res.json({
    errors,
    hasErrors: errors.length > 0,
    errorCount: errors.length,
  });
});


/* ─────────────────────────────────────────────────────────────────────────────
 * POST /clear-logs - Clear Log Buffers
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Clear log buffers
 * @body {string} type - 'all' | 'vite' | 'backend' (default: 'all')
 */
router.post('/clear-logs', (req, res) => {
  const { type = 'all' } = req.body || {};

  clearLogs(type);

  res.json({
    success: true,
    cleared: type,
  });
});


export default router;

