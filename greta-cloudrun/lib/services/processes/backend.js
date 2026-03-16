/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PYTHON BACKEND MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Manages the Python FastAPI backend server lifecycle.
 * Uses uvicorn with hot reload for development.
 * 
 * Features:
 * - Auto-restart on unexpected shutdown
 * - Log capture for debugging
 * - Virtual environment support (/opt/venv)
 * - Local MongoDB connection (not Atlas)
 * 
 * @module services/processes/backend
 */

import { spawn } from 'child_process';
import fs from 'fs-extra';
import { BACKEND_PORT, BACKEND_DIR } from '../../core/config.js';
import { state, addLog } from '../../core/state.js';
import { backendLogger as log } from '../../core/logger.js';


/* ─────────────────────────────────────────────────────────────────────────────
 * STATE
 * ───────────────────────────────────────────────────────────────────────────── */

/** Flag to prevent restart during graceful shutdown */
let shuttingDown = false;


/* ─────────────────────────────────────────────────────────────────────────────
 * PUBLIC API
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Mark backend as shutting down (prevents auto-restart)
 * Call this before graceful shutdown
 */
export function setBackendShuttingDown() {
  shuttingDown = true;
}

/**
 * Start the Python backend server
 * 
 * Uses uvicorn with:
 * - Host: 0.0.0.0 (accessible from orchestrator)
 * - Port: Configured via BACKEND_PORT
 * - Hot reload enabled for development
 * 
 * @returns {Promise<void>}
 */
export async function startBackend() {
  if (state.backendProcess) {
    log.info('Backend already running');
    return;
  }

  // Check if backend directory exists
  if (!await fs.pathExists(BACKEND_DIR)) {
    log.warn('No backend directory found, skipping backend startup');
    return;
  }

  log.emoji('python', 'Starting Python backend...');

  const args = [
    'server:app',
    '--host', '0.0.0.0',
    '--port', String(BACKEND_PORT),
    '--reload',
  ];

  state.backendProcess = spawn('uvicorn', args, {
    cwd: BACKEND_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Use LOCAL MongoDB inside container (Atlas is for Greta chat data only)
      MONGO_URL: 'mongodb://localhost:27017',
      PATH: `/opt/venv/bin:${process.env.PATH}`,
      PYTHONPATH: BACKEND_DIR,
    },
  });

  // Capture stdout
  state.backendProcess.stdout.on('data', (data) => {
    const message = data.toString().trim();
    log.info(message);
    addLog('backend', message);
  });

  // Capture stderr
  state.backendProcess.stderr.on('data', (data) => {
    const message = data.toString().trim();
    log.error(message);
    addLog('backendErrors', message);
  });

  // Handle process exit
  state.backendProcess.on('close', (code) => {
    log.info(`Process exited with code ${code}`);
    state.backendProcess = null;

    // Auto-restart unless we're shutting down
    if (!shuttingDown) {
      log.warn('Backend stopped unexpectedly, auto-restarting in 2 seconds...');
      setTimeout(() => {
        if (!shuttingDown) {
          startBackend().catch(err => log.error('Failed to restart:', err.message));
        }
      }, 2000);
    }
  });

  // Wait for backend to initialize
  await new Promise(resolve => setTimeout(resolve, 3000));
  log.success('Python backend started');
}

/**
 * Stop the Python backend server
 */
export function stopBackend() {
  if (state.backendProcess) {
    state.backendProcess.kill();
    state.backendProcess = null;
    log.info('Backend stopped');
  }
}

/**
 * Restart the Python backend server
 *
 * Useful after environment variable changes or dependency updates.
 *
 * @returns {Promise<void>}
 */
export async function restartBackend() {
  log.emoji('restart', 'Restarting Python backend...');

  stopBackend();

  // Wait for process to fully terminate
  await new Promise(resolve => setTimeout(resolve, 1000));

  await startBackend();
  log.success('Python backend restarted');
}

