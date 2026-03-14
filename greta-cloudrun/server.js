/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GRETA CLOUD RUN SERVER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Main entry point for Greta's container orchestration server.
 *
 * Architecture:
 * - Express server on port 8080 (Cloud Run entry point)
 * - Proxies frontend requests → Vite (port 5173)
 * - Proxies /api/* → FastAPI backend (port 8000)
 * - Express handles file ops, chat, logs, screenshots
 * - MongoDB for local data, GCS for persistence
 *
 * @module server
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';

/* ─────────────────────────────────────────────────────────────────────────────
 * IMPORTS - Core Configuration & State
 * ───────────────────────────────────────────────────────────────────────────── */

import {
  PORT,
  PROJECT_DIR,
  FRONTEND_DIR,
  BACKEND_DIR,
  FRONTEND_TEMPLATE_DIR,
  BACKEND_TEMPLATE_DIR,
  projectId,
  MONGO_BACKUP_INTERVAL,
  EXPRESS_API_ENDPOINTS,
  IMAGE_VERSION
} from './lib/core/config.js';

import { state } from './lib/core/state.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * IMPORTS - Services
 * ───────────────────────────────────────────────────────────────────────────── */

import { syncFromGCS, syncToGCS } from './lib/services/storage/gcs-sync.js';
import { startMongo, restoreMongoFromGCS, backupMongoToGCS } from './lib/services/processes/mongodb.js';
import { startVite, setShuttingDown } from './lib/services/processes/vite.js';
import { startBackend, setBackendShuttingDown } from './lib/services/processes/backend.js';
import { loadSecretsFromGCS } from './lib/services/secrets/env-loader.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * IMPORTS - API Routers & Middleware
 * ───────────────────────────────────────────────────────────────────────────── */

import fileApiRouter from './lib/api/files/index.js';
import logsApiRouter from './lib/api/logs/index.js';
import screenshotApiRouter from './lib/api/screenshot/index.js';
import { apiRouter, viteRouter } from './lib/middleware/proxy.js';

const app = express();


/* ═══════════════════════════════════════════════════════════════════════════════
 * MIDDLEWARE SETUP
 * ═══════════════════════════════════════════════════════════════════════════════ */

app.use(cors());

/**
 * Conditional JSON body parser.
 * Only parses JSON for Express-handled endpoints, not proxied requests.
 */
app.use((req, res, next) => {
  const expressApiPaths = EXPRESS_API_ENDPOINTS.map(p => `/api${p}`);
  const shouldParse = expressApiPaths.some(p => req.path.startsWith(p)) || !req.path.startsWith('/api/');

  if (shouldParse) {
    express.json({ limit: '50mb' })(req, res, next);
  } else {
    next();
  }
});


/* ═══════════════════════════════════════════════════════════════════════════════
 * HEALTH & KEEPALIVE ENDPOINTS
 * ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * GET /health - Health check endpoint for Cloud Run.
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    projectId,
    imageVersion: IMAGE_VERSION,
    viteRunning: !!state.viteProcess,
    backendRunning: !!state.backendProcess,
    mongoRunning: !!state.mongoProcess
  });
});

/**
 * POST /api/keepAlive - Called every 30s by frontend to keep container alive.
 */
app.post('/api/keepAlive', (req, res) => {
  state.lastKeepAlive = Date.now();
  res.json({
    status: 'alive',
    timestamp: state.lastKeepAlive,
    projectId,
    viteRunning: !!state.viteProcess,
    backendRunning: !!state.backendProcess
  });
});


/* ═══════════════════════════════════════════════════════════════════════════════
 * API ROUTES
 * ═══════════════════════════════════════════════════════════════════════════════ */

// Express-handled API modules
app.use('/api', fileApiRouter);        // File operations
app.use('/api', logsApiRouter);        // Console/backend logs
app.use('/api', screenshotApiRouter);  // Playwright screenshots

// Proxy remaining /api/* to FastAPI backend
app.use('/api', apiRouter);

// Proxy everything else to Vite frontend
app.use(viteRouter);

/* ═══════════════════════════════════════════════════════════════════════════════
 * PROJECT INITIALIZATION
 * ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * Initialize the project on container startup.
 *
 * Sequence:
 * 0. Load shared secrets from GCS (gs://{bucket}/secrets/.env)
 * 1. Setup frontend (copy template, sync from GCS, install deps)
 * 2. Start Vite dev server
 * 3. Setup backend (copy template)
 * 4. Start MongoDB and restore from GCS
 * 5. Start FastAPI backend
 * 6. Enable periodic backups
 */
async function initializeProject() {
  console.log(`🔧 Initializing project: ${projectId}`);

  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  /* ─────────────────────────────────────────────────────────────────────────────
   * STEP 0: Load Shared Secrets from GCS
   * ───────────────────────────────────────────────────────────────────────────── */

  console.log('🔐 Loading shared secrets from GCS...');
  await loadSecretsFromGCS();
  console.log('✅ Secrets loaded into environment');

  /* ─────────────────────────────────────────────────────────────────────────────
   * STEP 1: Frontend Setup
   * ───────────────────────────────────────────────────────────────────────────── */

  await fs.ensureDir(FRONTEND_DIR);

  // Copy template if no package.json
  const frontendPkgPath = path.join(FRONTEND_DIR, 'package.json');
  const templatePkgPath = path.join(FRONTEND_TEMPLATE_DIR, 'package.json');

  if (!await fs.pathExists(frontendPkgPath)) {
    console.log('📋 Copying frontend template...');
    const templateFiles = await fs.readdir(FRONTEND_TEMPLATE_DIR);
    for (const file of templateFiles) {
      if (file !== 'node_modules') {
        await fs.copy(path.join(FRONTEND_TEMPLATE_DIR, file), path.join(FRONTEND_DIR, file));
      }
    }
    console.log('✅ Frontend template copied');
  }

  // Sync from GCS to get real package.json before checking deps
  console.log('📥 Syncing from GCS...');
  await syncFromGCS(PROJECT_DIR);
  console.log('✅ GCS sync complete');

  // Decide: symlink (fast) vs full install (slow)
  const nodeModulesPath = path.join(FRONTEND_DIR, 'node_modules');
  const templateNodeModules = path.join(FRONTEND_TEMPLATE_DIR, 'node_modules');

  const projectPkg = await fs.readJson(frontendPkgPath);
  const templatePkg = await fs.readJson(templatePkgPath);
  const depsMatch =
    JSON.stringify(projectPkg.dependencies || {}) === JSON.stringify(templatePkg.dependencies || {}) &&
    JSON.stringify(projectPkg.devDependencies || {}) === JSON.stringify(templatePkg.devDependencies || {});

  if (depsMatch && !await fs.pathExists(nodeModulesPath)) {
    // FAST PATH: Dependencies match template - symlink (~2-3s)
    console.log('⚡ Dependencies match template - using symlink');
    await fs.symlink(templateNodeModules, nodeModulesPath);
    console.log('✅ node_modules symlinked');
  } else if (!await fs.pathExists(nodeModulesPath)) {
    // SLOW PATH: Dependencies differ - full install (~25-30s)
    console.log('📦 Dependencies differ - running bun install...');

    const bunCacheTar = '/bun-cache.tar.lz4';
    const tmpBunCache = '/tmp/bun-cache';

    if (await fs.pathExists(bunCacheTar) && !await fs.pathExists(tmpBunCache)) {
      console.log('📦 Extracting bun cache...');
      await fs.ensureDir(tmpBunCache);
      await execAsync(`lz4 -dc ${bunCacheTar} | tar -xf - -C ${tmpBunCache} --strip-components=1`, { timeout: 60000 });
    }

    try {
      await execAsync('bun install', {
        cwd: FRONTEND_DIR,
        timeout: 180000,
        env: { ...process.env, BUN_INSTALL_CACHE_DIR: tmpBunCache }
      });
      console.log('✅ bun install completed');
    } catch (err) {
      console.error('⚠️ bun install failed:', err.message);
    }
  } else {
    console.log('✅ node_modules already exists');
  }

  /* ─────────────────────────────────────────────────────────────────────────────
   * STEP 2: Start Services
   * ───────────────────────────────────────────────────────────────────────────── */

  await fs.ensureDir(PROJECT_DIR);
  await fs.ensureDir(BACKEND_DIR);

  // Start Vite frontend
  await startVite();

  // Copy backend template if needed
  const backendServerPath = path.join(BACKEND_DIR, 'server.py');
  if (!await fs.pathExists(backendServerPath)) {
    console.log('📋 Copying backend template...');
    await fs.copy(BACKEND_TEMPLATE_DIR, BACKEND_DIR);
    console.log('✅ Backend template copied');
  }

  // Start MongoDB and restore data
  await startMongo();
  await restoreMongoFromGCS();

  // Start FastAPI backend
  await startBackend();

  // Enable periodic backups
  startPeriodicBackups();
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * PERIODIC BACKUPS
 * ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * Start periodic MongoDB backups.
 *
 * NOTE: File sync is tool-triggered only (not periodic) to prevent race
 * conditions where template files could be uploaded before GCS download.
 */
function startPeriodicBackups() {
  setInterval(async () => {
    try {
      console.log('⏰ Periodic MongoDB backup...');
      await backupMongoToGCS();
      console.log('✅ Periodic MongoDB backup complete');
    } catch (error) {
      console.error('❌ Periodic MongoDB backup failed:', error.message);
    }
  }, MONGO_BACKUP_INTERVAL);

  console.log('🔒 Periodic MongoDB backup enabled. File sync is tool-triggered only.');
}


/* ═══════════════════════════════════════════════════════════════════════════════
 * GRACEFUL SHUTDOWN
 * ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * Graceful shutdown handler.
 * Backs up data and stops all processes cleanly.
 */
async function shutdown() {
  console.log('🛑 Shutting down...');

  // Prevent auto-restart of processes
  setShuttingDown();
  setBackendShuttingDown();

  // Backup MongoDB
  try {
    await backupMongoToGCS();
  } catch (error) {
    console.error('Failed to backup MongoDB:', error.message);
  }

  // Sync files to GCS
  try {
    await syncToGCS(PROJECT_DIR);
    console.log('✅ Files saved to GCS');
  } catch (error) {
    console.error('Failed to save files to GCS:', error.message);
  }

  // Stop all processes
  if (state.mongoProcess) {
    state.mongoProcess.kill();
    console.log('MongoDB stopped');
  }
  if (state.viteProcess) {
    state.viteProcess.kill();
    console.log('Vite stopped');
  }
  if (state.backendProcess) {
    state.backendProcess.kill();
    console.log('Backend stopped');
  }

  console.log('✅ Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);


/* ═══════════════════════════════════════════════════════════════════════════════
 * START SERVER
 * ═══════════════════════════════════════════════════════════════════════════════ */

app.listen(PORT, async () => {
  console.log(`🌐 Greta Cloud Run server listening on port ${PORT}`);
  console.log(`📁 Project ID: ${projectId}`);
  await initializeProject();
});
