/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LOGS API MODULE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Console and backend log retrieval and management.
 * Provides endpoints to get Vite (frontend) and FastAPI (backend) logs.
 *
 * @module api/logs
 */

import express from 'express';
import { logs, clearLogs } from '../../core/state.js';

const router = express.Router();

/* ─────────────────────────────────────────────────────────────────────────────
 * FRONTEND (VITE) LOGS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/console-logs - Get Vite console logs.
 *
 * Query params:
 * - type: 'all' | 'errors' | 'stdout' (default: 'all')
 * - clear: 'true' to clear logs after reading
 */
router.get('/console-logs', (req, res) => {
  const { type = 'all', clear = false } = req.query;

  // Select logs based on type
  let logList;
  if (type === 'errors') {
    logList = logs.viteErrors;
  } else if (type === 'stdout') {
    logList = logs.vite;
  } else {
    // Combine and sort by timestamp
    logList = [...logs.vite, ...logs.viteErrors].sort((a, b) => a.timestamp - b.timestamp);
  }

  const hasErrors = logs.viteErrors.length > 0;

  // Optionally clear logs after reading
  if (clear === 'true') {
    if (type === 'errors' || type === 'all') clearLogs('vite');
    if (type === 'stdout' || type === 'all') clearLogs('vite');
  }

  res.json({
    success: true,
    hasErrors,
    errorCount: logs.viteErrors.length,
    logs: logList.map(l => l.message),
    rawLogs: logList
  });
});

/**
 * POST /api/browser-error - Receive runtime errors captured from the iframe app
 */
router.post('/browser-error', (_req, res) => {
  const { message } = _req.body;
  if (message) {
    logs.viteErrors.push({ message: `[BROWSER] ${message}`, timestamp: Date.now() });
  }
  res.json({ success: true });
});

/**
 * POST /api/clear-logs - Clear all console logs.
 */
router.post('/clear-logs', (req, res) => {
  clearLogs('all');
  res.json({ success: true, message: 'Logs cleared' });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * BACKEND (FASTAPI) LOGS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/backend-logs - Get Python/FastAPI backend logs.
 *
 * Query params:
 * - clear: 'true' to clear logs after reading
 * - limit: number of logs to return (default: 50)
 */
router.get('/backend-logs', (req, res) => {
  const { clear = false, limit = 50 } = req.query;
  const limitNum = parseInt(limit) || 50;

  // Get backend logs and errors
  const allLogs = logs.backend.slice(-limitNum);
  const errorLogs = logs.backendErrors.slice(-limitNum);

  // Combine and sort by timestamp
  const combined = [...allLogs, ...errorLogs].sort((a, b) => a.timestamp - b.timestamp);

  const hasErrors = errorLogs.length > 0;

  // Optionally clear logs after reading
  if (clear === 'true') {
    clearLogs('backend');
  }

  res.json({
    success: true,
    hasErrors,
    errorCount: errorLogs.length,
    logs: combined.map(l => l.message),
    errors: errorLogs.map(l => l.message),
    rawLogs: combined
  });
});

export default router;
