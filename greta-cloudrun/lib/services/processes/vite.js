/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * VITE DEV SERVER MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Manages the Vite development server lifecycle with hot module replacement.
 * Uses Bun as the package manager for improved performance.
 * 
 * Features:
 * - Auto-restart on unexpected shutdown
 * - Log capture for debugging
 * - Graceful shutdown support
 * 
 * @module services/processes/vite
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import { VITE_PORT, FRONTEND_DIR } from '../../core/config.js';
import { state, addLog } from '../../core/state.js';
import { viteLogger as log } from '../../core/logger.js';

const VITE_STATUS_FILE = '/tmp/vite-compiling';

function clearViteStatus() {
  try { fs.rmSync(VITE_STATUS_FILE, { force: true }); } catch {}
}

function killOrphanedEsbuild() {
  try {
    execSync('pkill -f "esbuild --service" 2>/dev/null || true', { timeout: 3000 });
  } catch {}
}


/* ─────────────────────────────────────────────────────────────────────────────
 * STATE
 * ───────────────────────────────────────────────────────────────────────────── */

/** Flag to prevent restart during graceful shutdown */
let shuttingDown = false;


/* ─────────────────────────────────────────────────────────────────────────────
 * PUBLIC API
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Mark Vite as shutting down (prevents auto-restart)
 * Call this before graceful shutdown
 */
export function setShuttingDown() {
  shuttingDown = true;
}

/**
 * Start the Vite development server
 * 
 * Uses Bun for faster startup. The server runs with:
 * - Host: 0.0.0.0 (accessible from outside container)
 * - Port: Configured via VITE_PORT
 * 
 * @returns {Promise<void>}
 */
export async function startVite() {
  if (state.viteProcess) {
    log.info('Vite already running');
    return;
  }

  log.emoji('vite', 'Starting Vite dev server...');

  const args = ['run', 'dev', '--', '--host', '0.0.0.0', '--port', String(VITE_PORT)];
  log.info(`Running: bun ${args.join(' ')}`);

  state.viteProcess = spawn('bun', args, {
    cwd: FRONTEND_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  // Capture stdout
  state.viteProcess.stdout.on('data', (data) => {
    const message = data.toString().trim();
    log.info(message);
    addLog('vite', message);
  });

  // Capture stderr — filter known non-error noise Vite prints to stderr
  const VITE_STDERR_NOISE = [
    'Experimental optimizeDeps',
    'Browserslist',
    'caniuse-lite',
    'update-browserslist-db',
    'vite --host',
    'VITE v',
    'ready in',
    'Local:',
    'Network:',
    'press h + enter',
  ];
  state.viteProcess.stderr.on('data', (data) => {
    const message = data.toString().trim();
    log.error(message);
    const isNoise = VITE_STDERR_NOISE.some(pattern => message.includes(pattern));
    addLog(isNoise ? 'vite' : 'viteErrors', message);
  });

  // Handle process exit
  state.viteProcess.on('close', (code) => {
    log.info(`Process exited with code ${code}`);
    state.viteProcess = null;

    // Auto-restart unless we're shutting down
    if (!shuttingDown) {
      log.warn('Vite stopped unexpectedly, auto-restarting in 2 seconds...');
      setTimeout(() => {
        if (!shuttingDown) {
          startVite().catch(err => log.error('Failed to restart:', err.message));
        }
      }, 2000);
    }
  });

  // Wait for Vite to initialize
  await new Promise(resolve => setTimeout(resolve, 3000));
  clearViteStatus();
  log.success('Vite dev server started');
}

/**
 * Stop the Vite development server
 */
export function stopVite() {
  if (state.viteProcess) {
    state.viteProcess.kill();
    state.viteProcess = null;
    killOrphanedEsbuild();
    clearViteStatus();
    log.info('Vite stopped');
  }
}

/**
 * Restart the Vite development server
 * 
 * Useful after adding dependencies to ensure clean module resolution
 * and avoid multiple React copies issue.
 * 
 * @returns {Promise<void>}
 */
export async function restartVite() {
  log.emoji('restart', 'Restarting Vite to pick up new dependencies...');
  
  stopVite();
  
  // Wait for process to fully terminate
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  await startVite();
  log.success('Vite restarted');
}

