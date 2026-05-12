/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MONGODB MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Manages the local MongoDB server lifecycle and GCS backup/restore.
 * 
 * Features:
 * - Local MongoDB instance (not Atlas)
 * - Backup to GCS on shutdown and periodically
 * - Restore from GCS on startup
 * 
 * @module services/processes/mongodb
 */

import { spawn } from 'child_process';
import fs from 'fs-extra';
import { Storage } from '@google-cloud/storage';
import { MONGO_PORT, MONGO_DATA_DIR, GCS_BUCKET, projectId } from '../../core/config.js';
import { state } from '../../core/state.js';
import { mongoLogger as log } from '../../core/logger.js';


/* ─────────────────────────────────────────────────────────────────────────────
 * GCS CLIENT
 * ───────────────────────────────────────────────────────────────────────────── */

const storage = new Storage();


/* ─────────────────────────────────────────────────────────────────────────────
 * SERVER MANAGEMENT
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Start the MongoDB server
 * 
 * @returns {Promise<void>}
 */
export async function startMongo() {
  if (state.mongoProcess) {
    log.info('MongoDB already running');
    return;
  }

  log.emoji('mongo', 'Starting MongoDB...');

  // Ensure data directory exists
  await fs.ensureDir(MONGO_DATA_DIR);

  const args = [
    '--dbpath', MONGO_DATA_DIR,
    '--bind_ip', '127.0.0.1',
    '--port', String(MONGO_PORT),
    '--noauth',
  ];

  state.mongoProcess = spawn('mongod', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Capture output
  state.mongoProcess.stdout.on('data', (data) => {
    log.info(data.toString().trim());
  });

  state.mongoProcess.stderr.on('data', (data) => {
    const message = data.toString().trim();
    if (message.includes('ERROR') || message.includes('error')) {
      log.error(message);
    } else {
      log.info(message);
    }
  });

  state.mongoProcess.on('close', (code) => {
    log.info(`Process exited with code ${code}`);
    state.mongoProcess = null;
    // Auto-restart MongoDB — without it the backend silently fails all DB operations
    log.warn('MongoDB stopped unexpectedly, auto-restarting in 3 seconds...');
    setTimeout(async () => {
      try {
        await startMongo();
        log.success('MongoDB restarted successfully');
      } catch (err) {
        log.error(`MongoDB restart failed: ${err.message}`);
      }
    }, 3000);
  });

  // Wait for MongoDB to initialize
  await new Promise(resolve => setTimeout(resolve, 3000));
  log.success(`MongoDB started on port ${MONGO_PORT}`);
}

/**
 * Stop the MongoDB server
 */
export function stopMongo() {
  if (state.mongoProcess) {
    state.mongoProcess.kill();
    state.mongoProcess = null;
    log.info('MongoDB stopped');
  }
}


/* ─────────────────────────────────────────────────────────────────────────────
 * GCS BACKUP & RESTORE
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Restore MongoDB from GCS backup
 * Called on container startup to restore previous state
 * 
 * @returns {Promise<void>}
 */
export async function restoreMongoFromGCS() {
  const dumpPath = '/tmp/mongodb-dump.archive';
  const gcsPath = `projects/${projectId}/mongodb/dump.archive`;

  log.emoji('restart', 'Checking for MongoDB backup in GCS...');
  log.info(`Project ID: ${projectId}`);
  log.info(`GCS Path: gs://${GCS_BUCKET}/${gcsPath}`);

  try {
    const bucket = storage.bucket(GCS_BUCKET);
    const file = bucket.file(gcsPath);

    // Check if backup exists
    const [exists] = await file.exists();
    if (!exists) {
      log.info('No MongoDB backup found, starting with fresh database');
      return;
    }

    // Download from GCS
    log.emoji('download', 'Downloading MongoDB backup from GCS...');
    await file.download({ destination: dumpPath });
    log.success('Downloaded MongoDB backup');

    // Restore using mongorestore
    log.info('Restoring MongoDB from backup...');
    await runMongorestore(dumpPath);

    // Cleanup
    await fs.remove(dumpPath);
    log.success('MongoDB restored from GCS backup');

  } catch (error) {
    log.error(`Failed to restore MongoDB: ${error.message}`);
  }
}

/**
 * Backup MongoDB to GCS
 * Called on shutdown and periodically for safety
 * 
 * @returns {Promise<void>}
 */
export async function backupMongoToGCS() {
  if (!state.mongoProcess) {
    log.warn('MongoDB not running, skipping backup');
    return;
  }

  const dumpPath = '/tmp/mongodb-dump.archive';
  const gcsPath = `projects/${projectId}/mongodb/dump.archive`;

  log.emoji('backup', 'Backing up MongoDB to GCS...');

  try {
    // Create dump
    await runMongodump(dumpPath);
    log.success('MongoDB dump created');

    // Upload to GCS
    log.emoji('upload', 'Uploading to GCS...');
    const bucket = storage.bucket(GCS_BUCKET);
    await bucket.upload(dumpPath, {
      destination: gcsPath,
      metadata: { contentType: 'application/octet-stream' },
    });

    // Cleanup
    await fs.remove(dumpPath);
    log.success(`MongoDB backed up to gs://${GCS_BUCKET}/${gcsPath}`);

  } catch (error) {
    log.error(`Failed to backup MongoDB: ${error.message}`);
  }
}


/* ─────────────────────────────────────────────────────────────────────────────
 * INTERNAL HELPERS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Run mongodump to create archive
 * @private
 */
function runMongodump(archivePath) {
  return new Promise((resolve, reject) => {
    const dump = spawn('mongodump', [
      `--archive=${archivePath}`,
      '--port', String(MONGO_PORT),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    dump.stdout.on('data', (data) => log.info(`[mongodump] ${data.toString().trim()}`));
    dump.stderr.on('data', (data) => log.info(`[mongodump] ${data.toString().trim()}`));

    dump.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mongodump exited with code ${code}`));
    });
    dump.on('error', reject);
  });
}

/**
 * Run mongorestore from archive
 * @private
 */
function runMongorestore(archivePath) {
  return new Promise((resolve, reject) => {
    const restore = spawn('mongorestore', [
      `--archive=${archivePath}`,
      '--port', String(MONGO_PORT),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    restore.stdout.on('data', (data) => log.info(`[mongorestore] ${data.toString().trim()}`));
    restore.stderr.on('data', (data) => log.info(`[mongorestore] ${data.toString().trim()}`));

    restore.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mongorestore exited with code ${code}`));
    });
    restore.on('error', reject);
  });
}

