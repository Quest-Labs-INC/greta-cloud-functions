/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * VITE DEV SERVER MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages the Vite development server via supervisord.
 *
 * @module services/processes/vite
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { rm } from 'fs/promises';
import http from 'http';
import path from 'path';
import { FRONTEND_DIR, VITE_PORT } from '../../core/config.js';
import { viteLogger as log } from '../../core/logger.js';

const execAsync = promisify(exec);

async function waitForVite(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise(resolve => {
      const req = http.get(`http://localhost:${VITE_PORT}/`, res => {
        res.resume();
        resolve(res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
    if (ready) return;
    await new Promise(r => setTimeout(r, 500));
  }
}

export function setShuttingDown() {
  // No-op: supervisord handles restart prevention via explicit stop
}

export async function startVite() {
  log.emoji('vite', 'Starting Vite dev server...');
  try {
    const { stdout } = await execAsync('supervisorctl start frontend');
    log.info(stdout.trim());
    log.success('Vite dev server started');
  } catch (err) {
    log.error('Failed to start Vite via supervisorctl:', err.message);
  }
}

export function stopVite() {
  execAsync('supervisorctl stop frontend').catch(err =>
    log.error('Failed to stop Vite via supervisorctl:', err.message)
  );
}

export async function restartVite() {
  log.emoji('restart', 'Restarting Vite to pick up new dependencies...');

  try { await execAsync('supervisorctl stop frontend'); } catch {}

  const viteCacheDir = path.join(FRONTEND_DIR, 'node_modules', '.vite');
  await rm(viteCacheDir, { recursive: true, force: true }).catch(() => {});
  log.info('Cleared Vite dep cache');

  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    const { stdout } = await execAsync('supervisorctl start frontend');
    log.info(stdout.trim());
    log.info('Waiting for Vite to be ready...');
    await waitForVite(15000);
    log.success('Vite restarted and ready');
  } catch (err) {
    log.error('Failed to restart Vite via supervisorctl:', err.message);
  }
}
