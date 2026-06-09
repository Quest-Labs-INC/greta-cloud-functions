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
import path from 'path';
import { FRONTEND_DIR } from '../../core/config.js';
import { viteLogger as log } from '../../core/logger.js';

const execAsync = promisify(exec);

export function setShuttingDown() {
  // No-op: supervisord handles restart prevention via explicit stop
}

export async function startVite() {
  log.emoji('vite', 'Starting Vite dev server...');
  try {
    const { stdout } = await execAsync('supervisorctl start vite');
    log.info(stdout.trim());
    log.success('Vite dev server started');
  } catch (err) {
    log.error('Failed to start Vite via supervisorctl:', err.message);
  }
}

export function stopVite() {
  execAsync('supervisorctl stop vite').catch(err =>
    log.error('Failed to stop Vite via supervisorctl:', err.message)
  );
}

export async function restartVite() {
  log.emoji('restart', 'Restarting Vite to pick up new dependencies...');

  try { await execAsync('supervisorctl stop vite'); } catch {}

  const viteCacheDir = path.join(FRONTEND_DIR, 'node_modules', '.vite');
  await rm(viteCacheDir, { recursive: true, force: true }).catch(() => {});
  log.info('Cleared Vite dep cache');

  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    const { stdout } = await execAsync('supervisorctl start vite');
    log.info(stdout.trim());
    log.success('Vite restarted');
  } catch (err) {
    log.error('Failed to restart Vite via supervisorctl:', err.message);
  }
}
