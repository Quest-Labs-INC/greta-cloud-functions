/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * VITE DEV SERVER MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages the Vite development server lifecycle with hot module replacement.
 * Uses Bun as the package manager for improved performance.
 *
 * @module services/processes/vite
 */

import { spawn } from 'child_process';
import { rm } from 'fs/promises';
import path from 'path';
import { VITE_PORT, FRONTEND_DIR } from '../../core/config.js';
import { state, addLog } from '../../core/state.js';
import { viteLogger as log } from '../../core/logger.js';


/** Flag to prevent restart during graceful shutdown */
let shuttingDown = false;

export function setShuttingDown() {
  shuttingDown = true;
}

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

  // Capture stderr — filter known noise
  const VITE_STDERR_NOISE = [
    'Browserslist', 'caniuse-lite', 'update-browserslist-db',
    'ExperimentalWarning', 'vite --host', 'VITE v', 'ready in',
    'Local:', 'Network:', 'press h + enter',
  ];
  state.viteProcess.stderr.on('data', (data) => {
    const message = data.toString().trim();
    const isNoise = VITE_STDERR_NOISE.some(p => message.includes(p));
    if (isNoise) {
      addLog('vite', message);
    } else {
      log.error(message);
      addLog('viteErrors', message);
    }
  });

  // Handle process exit
  state.viteProcess.on('close', (code) => {
    log.info(`Process exited with code ${code}`);
    state.viteProcess = null;

    if (!shuttingDown) {
      log.warn('Vite stopped unexpectedly, auto-restarting in 2 seconds...');
      setTimeout(() => {
        if (!shuttingDown) {
          startVite().catch(err => log.error('Failed to restart:', err.message));
        }
      }, 2000);
    }
  });

  await new Promise(resolve => setTimeout(resolve, 3000));
  log.success('Vite dev server started');
}

export function stopVite() {
  if (state.viteProcess) {
    state.viteProcess.kill();
    state.viteProcess = null;
    log.info('Vite stopped');
  }
}

export async function restartVite() {
  log.emoji('restart', 'Restarting Vite to pick up new dependencies...');
  stopVite();

  // Clear Vite dep cache so new hash is generated — prevents browser 504 on stale hash
  const viteCacheDir = path.join(FRONTEND_DIR, 'node_modules', '.vite');
  await rm(viteCacheDir, { recursive: true, force: true }).catch(() => {});
  log.info('Cleared Vite dep cache');

  await new Promise(resolve => setTimeout(resolve, 1000));
  await startVite();
  log.success('Vite restarted');
}
