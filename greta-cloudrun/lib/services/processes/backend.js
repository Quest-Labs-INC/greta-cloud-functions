/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PYTHON BACKEND MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages the Python FastAPI backend via supervisord.
 *
 * @module services/processes/backend
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { backendLogger as log } from '../../core/logger.js';

const execAsync = promisify(exec);

export function setBackendShuttingDown() {
  // No-op: supervisord handles restart prevention via explicit stop
}

export async function startBackend() {
  log.emoji('python', 'Starting Python backend...');
  try {
    const { stdout } = await execAsync('supervisorctl start backend');
    log.info(stdout.trim());
    log.success('Python backend started');
  } catch (err) {
    log.error('Failed to start backend via supervisorctl:', err.message);
  }
}

export function stopBackend() {
  execAsync('supervisorctl stop backend').catch(err =>
    log.error('Failed to stop backend via supervisorctl:', err.message)
  );
}

export async function restartBackend() {
  log.emoji('restart', 'Restarting Python backend...');
  try {
    const { stdout } = await execAsync('supervisorctl restart backend');
    log.info(stdout.trim());
    log.success('Python backend restarted');
  } catch (err) {
    log.error('Failed to restart backend via supervisorctl:', err.message);
  }
}
