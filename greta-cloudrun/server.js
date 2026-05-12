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
import { existsSync } from 'fs';
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
  IMAGE_VERSION
} from './lib/core/config.js';

import { state } from './lib/core/state.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * IMPORTS - Services
 * ───────────────────────────────────────────────────────────────────────────── */

import { syncFromGCS, syncToGCS, hasGCSData } from './lib/services/storage/gcs-sync.js';
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
import agentsApiRouter from './lib/api/agents/index.js';
import healthApiRouter from './lib/api/health/index.js';
import { apiRouter, viteRouter } from './lib/middleware/proxy.js';

const app = express();


/* ═══════════════════════════════════════════════════════════════════════════════
 * MIDDLEWARE SETUP
 * ═══════════════════════════════════════════════════════════════════════════════ */

app.use(cors());


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
    viteCompiling: existsSync('/tmp/vite-compiling'),
    backendRunning: !!state.backendProcess,
    mongoRunning: !!state.mongoProcess
  });
});

/**
 * POST /_greta/keepAlive - Called every 30s by frontend to keep container alive.
 */
app.post('/_greta/keepAlive', (req, res) => {
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

// ✅ Express internal APIs
app.use('/_greta', express.json({ limit: '50mb' }));
app.use('/_greta', fileApiRouter);
app.use('/_greta', logsApiRouter);
app.use('/_greta', screenshotApiRouter);
app.use('/_greta', agentsApiRouter);
app.use('/_greta', healthApiRouter);

// ✅ Python backend (pure proxy, no filtering)
app.use('/api', apiRouter);

// ✅ Frontend
app.use(viteRouter);

/* ═══════════════════════════════════════════════════════════════════════════════
 * PROJECT INITIALIZATION
 * ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * Copy frontend template files (excluding node_modules)
 */
async function copyFrontendTemplate(templateDir, targetDir) {
  const templateFiles = await fs.readdir(templateDir);
  for (const file of templateFiles) {
    if (file !== 'node_modules') {
      await fs.copy(path.join(templateDir, file), path.join(targetDir, file));
    }
  }
}

/**
 * Initialize the project on container startup.
 *
 * Sequence:
 * Load shared secrets from GCS (gs://{bucket}/secrets/.env)
 * 1. Check GCS for existing project data (GCS takes priority!)
 * 2. If GCS has data → restore from GCS
 * 3. If new project → copy template
 * 4. Setup dependencies
 * 5. Start Vite, MongoDB, FastAPI
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
   * STEP 1: Check GCS for existing project data
   * ───────────────────────────────────────────────────────────────────────────── */

  await fs.ensureDir(FRONTEND_DIR);

  // CRITICAL: Check GCS FIRST before using template
  console.log('🔍 Checking GCS for existing project data...');
  const hasExistingData = await hasGCSData();

  if (hasExistingData) {
    // EXISTING PROJECT: Sync from GCS (user's saved work takes priority)
    console.log('📦 Found existing project in GCS - restoring user data...');

    // Try multiple times with exponential backoff - user data is precious!
    let syncSuccess = false;
    const maxRetries = 3;
    const retryDelays = [2000, 5000, 10000]; // 2s, 5s, 10s

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        console.log(`⏳ Retry attempt ${attempt + 1}/${maxRetries} after ${retryDelays[attempt - 1]}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt - 1]));
      }

      syncSuccess = await syncFromGCS(PROJECT_DIR);
      if (syncSuccess) {
        console.log('✅ User data restored from GCS');
        break;
      } else {
        console.error(`❌ GCS sync attempt ${attempt + 1} failed`);
      }
    }

    if (!syncSuccess) {
      // GCS sync failed - fall back to template to keep container running
      console.warn('⚠️  GCS sync failed after retries - falling back to template');
      console.warn('⚠️  User may see stale data until GCS sync succeeds');

      // Copy template as fallback
      await copyFrontendTemplate(FRONTEND_TEMPLATE_DIR, FRONTEND_DIR);
      console.log('✅ Frontend template copied as fallback');
    }
  } else {
    // NEW PROJECT: Use template
    console.log('📦 New project - copying template...');
    await copyFrontendTemplate(FRONTEND_TEMPLATE_DIR, FRONTEND_DIR);
    console.log('✅ Frontend template copied');
  }

  // Always run bun install using the baked-in cache (~5-10s)
  // No symlinks - avoids stale Vite cache and duplicate React issues
  const nodeModulesPath = path.join(FRONTEND_DIR, 'node_modules');

  if (!await fs.pathExists(nodeModulesPath)) {
    console.log('📦 Installing frontend dependencies...');

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

  // Handle Python dependencies (similar to frontend node_modules logic)
  const requirementsPath = path.join(BACKEND_DIR, 'requirements.txt');
  const templateRequirementsPath = path.join(BACKEND_TEMPLATE_DIR, 'requirements.txt');
  const venvMarkerPath = path.join(BACKEND_DIR, '.venv_installed');

  if (await fs.pathExists(requirementsPath)) {
    // Check if dependencies have changed by comparing requirements.txt files
    let depsMatch = false;

    if (await fs.pathExists(templateRequirementsPath) && await fs.pathExists(venvMarkerPath)) {
      const projectReqs = await fs.readFile(requirementsPath, 'utf8');
      const templateReqs = await fs.readFile(templateRequirementsPath, 'utf8');
      depsMatch = projectReqs.trim() === templateReqs.trim();
    }

    if (depsMatch) {
      // FAST PATH: Dependencies match template - skip installation
      console.log('⚡ Python dependencies match template - skipping installation');
    } else {
      // SLOW PATH: Dependencies differ or first install - run pip install
      console.log('📦 Installing Python dependencies...');
      try {
        await execAsync('pip install -r requirements.txt', {
          cwd: BACKEND_DIR,
          timeout: 180000, // 3 minutes
          env: { ...process.env, PATH: `/opt/venv/bin:${process.env.PATH}` }
        });

        // Create marker file to track that dependencies are installed
        await fs.writeFile(venvMarkerPath, new Date().toISOString());
        console.log('✅ Python dependencies installed');
      } catch (err) {
        console.error('⚠️ pip install failed:', err.message);
        console.error('Backend may fail to start if dependencies are missing');
      }
    }
  } else {
    console.log('⏭️ No requirements.txt found, skipping Python dependency installation');
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

const server = app.listen(PORT, async () => {
  console.log(`🌐 Greta Cloud Run server listening on port ${PORT}`);
  console.log(`📁 Project ID: ${projectId}`);
  await initializeProject();
});

// Fix: Node's default keepAliveTimeout (5s) is lower than nginx's proxy_read_timeout (3600s)
// This causes nginx to reuse a dead connection → 504. Set Node's timeout higher than nginx.
server.keepAliveTimeout = 65000;   // 65s — above nginx's 60s default upstream keepalive
server.headersTimeout = 66000;     // must be > keepAliveTimeout
