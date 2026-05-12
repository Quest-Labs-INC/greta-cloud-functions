/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FILE API HELPERS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Shared utility functions for file operations API.
 * Includes path validation, response formatting, and sync scheduling.
 * 
 * @module api/files/helpers
 */

import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import { PROJECT_DIR, FRONTEND_DIR, DEBOUNCE_DELAY } from '../../core/config.js';
import { syncToGCS, syncFilesToGCS } from '../../services/storage/gcs-sync.js';
import { logs, state } from '../../core/state.js';

export const execAsync = promisify(execCallback);


/* ─────────────────────────────────────────────────────────────────────────────
 * BINARY FILE DETECTION
 * ───────────────────────────────────────────────────────────────────────────── */

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.rar', '.7z', '.lz4',
  '.exe', '.dll', '.so', '.dylib',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov',
  '.sqlite', '.db',
]);

/**
 * Determines if a file is binary based on its extension.
 * Binary files are skipped during text operations like grep/bulk-read.
 * 
 * @param {string} filePath - The file path to check
 * @returns {boolean} True if the file extension indicates a binary file
 */
export function isBinaryFile(filePath) {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}


/* ─────────────────────────────────────────────────────────────────────────────
 * PATH SECURITY
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Validates and resolves a file path safely, preventing path traversal attacks.
 * Strips leading `../` sequences and ensures the resolved path stays within baseDir.
 * 
 * @param {string} filePath - The input file path (may be relative or contain traversal attempts)
 * @param {string} [baseDir=PROJECT_DIR] - The base directory to resolve paths against
 * @returns {string} The fully resolved, safe path
 * @throws {Error} If filePath is invalid or attempts path traversal outside baseDir
 * 
 * @example
 * resolveSafePath('frontend/src/App.tsx') // => '/app/project/frontend/src/App.tsx'
 * resolveSafePath('../../../etc/passwd') // throws Error: 'Path traversal not allowed'
 */
export function resolveSafePath(filePath, baseDir = PROJECT_DIR) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path');
  }

  const normalized = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.resolve(baseDir, normalized);

  if (!fullPath.startsWith(path.resolve(baseDir))) {
    throw new Error('Path traversal not allowed');
  }

  return fullPath;
}


/* ─────────────────────────────────────────────────────────────────────────────
 * API RESPONSE FORMATTING
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Creates a consistent API response with standard metadata.
 * All API endpoints should use this for uniform response structure.
 * 
 * @param {object} res - Express response object
 * @param {number} status - HTTP status code
 * @param {object} data - Response data to include
 * @returns {object} Express response with JSON body
 */
export function apiResponse(res, status, data) {
  return res.status(status).json({
    success: status >= 200 && status < 300,
    timestamp: new Date().toISOString(),
    ...data
  });
}


/* ─────────────────────────────────────────────────────────────────────────────
 * GCS SYNC SCHEDULING (INCREMENTAL)
 * ───────────────────────────────────────────────────────────────────────────── */

let syncTimeout = null;
let pendingFiles = new Set();
let syncRetryCount = 0;
const MAX_SYNC_RETRIES = 3;


/**
 * Schedules a debounced incremental sync to Google Cloud Storage.
 * Multiple rapid file changes will be batched into a single sync operation.
 * Only the changed files are synced, not the entire project.
 *
 * @param {string} filePath - Relative path of the changed file
 */
export function scheduleSyncToGCS(filePath) {
  if (syncTimeout) clearTimeout(syncTimeout);

  // Track the changed file (validate input)
  if (filePath && typeof filePath === 'string') {
    pendingFiles.add(filePath);
  }

  syncTimeout = setTimeout(async () => {
    if (pendingFiles.size > 0) {
      const filesToSync = Array.from(pendingFiles);
      pendingFiles.clear();

      try {
        console.log(`🔄 Incremental sync: ${filesToSync.length} file(s)...`);
        const result = await syncFilesToGCS(PROJECT_DIR, filesToSync);

        syncRetryCount = 0;
        if (result.failed === 0) {
          console.log(`✅ Incremental sync complete: ${result.success} file(s)`);
        } else {
          console.warn(`⚠️ Incremental sync partial: ${result.success} succeeded, ${result.failed} failed`);
        }
      } catch (error) {
        console.error('❌ Incremental sync failed:', error.message);
        // Retry up to MAX_SYNC_RETRIES — prevents infinite loop if GCS is down
        if (syncRetryCount < MAX_SYNC_RETRIES) {
          syncRetryCount++;
          filesToSync.forEach(f => pendingFiles.add(f));
          console.warn(`⚠️ Will retry sync (attempt ${syncRetryCount}/${MAX_SYNC_RETRIES})`);
        } else {
          syncRetryCount = 0;
          console.error(`❌ Sync failed after ${MAX_SYNC_RETRIES} retries, dropping pending files`);
        }
      }
    }
  }, DEBOUNCE_DELAY);
}

/**
 * Force a full sync to GCS (used on shutdown)
 */
export async function forceFullSyncToGCS() {
  if (syncTimeout) clearTimeout(syncTimeout);
  pendingFiles.clear();

  try {
    console.log('🔄 Full sync to GCS...');
    await syncToGCS(PROJECT_DIR);
    console.log('✅ Full sync complete');
  } catch (error) {
    console.error('❌ Full sync failed:', error.message);
    throw error; // Re-throw for shutdown handler
  }
}


/* ─────────────────────────────────────────────────────────────────────────────
 * STATUS & LOGS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Gets the current running status of all managed processes.
 * Used by Greta -compatible endpoints that include status in responses.
 * 
 * @returns {{viteRunning: boolean, backendRunning: boolean, mongoRunning: boolean}}
 */
export function getAppStatus() {
  return {
    viteRunning: state.viteProcess !== null,
    backendRunning: state.backendProcess !== null,
    mongoRunning: state.mongoProcess !== null
  };
}

/**
 * Retrieves recent logs for a given service type.
 * Returns both stdout logs and error logs separately.
 * 
 * @param {('backend'|'frontend'|'vite')} type - The service type to get logs for
 * @param {number} [count=20] - Maximum number of log entries to return
 * @returns {{logs: string[], errors: string[]}} Object containing recent logs and errors
 */
export function getRecentLogs(type, count = 20) {
  if (type === 'backend') {
    return {
      logs: logs.backend.slice(-count),
      errors: logs.backendErrors.slice(-count)
    };
  } else if (type === 'frontend' || type === 'vite') {
    return {
      logs: logs.vite.slice(-count),
      errors: logs.viteErrors.slice(-count)
    };
  }
  return { logs: [], errors: [] };
}


/* ─────────────────────────────────────────────────────────────────────────────
 * FILE LISTING
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Recursively lists all files in a directory.
 * Skips node_modules and .git directories for performance.
 *
 * @param {string} dir - Directory to scan
 * @param {string} [baseDir=dir] - Base directory for computing relative paths
 * @returns {Promise<string[]>} Array of file paths relative to baseDir
 */
export async function listFilesRecursive(dir, baseDir = dir) {
  const files = [];
  const items = await fs.readdir(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    const relativePath = path.relative(baseDir, fullPath);

    // Skip heavy directories
    if (item.name === 'node_modules' || item.name === '.git') continue;

    if (item.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath, baseDir));
    } else {
      files.push(relativePath.replace(/\\/g, '/'));
    }
  }
  return files;
}


/* ─────────────────────────────────────────────────────────────────────────────
 * NODE MODULES MANAGEMENT
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Ensure node_modules exists and is NOT a symlink (for bun add/remove to work).
 * If node_modules is a symlink, convert it to real folder by running bun install.
 */
export async function ensureNodeModules() {
  const nodeModulesPath = path.join(FRONTEND_DIR, 'node_modules');

  if (await fs.pathExists(nodeModulesPath)) {
    try {
      const stats = await fs.lstat(nodeModulesPath);

      if (stats.isSymbolicLink()) {
        console.log('🔄 Converting symlinked node_modules to real folder...');
        await fs.remove(nodeModulesPath);

        // Extract bun cache if not already extracted
        const bunCacheTar = '/bun-cache.tar.lz4';
        const tmpBunCache = '/tmp/bun-cache';

        if (await fs.pathExists(bunCacheTar) && !await fs.pathExists(tmpBunCache)) {
          console.log('📦 Extracting bun cache...');
          await fs.ensureDir(tmpBunCache);
          await execAsync(
            `lz4 -dc ${bunCacheTar} | tar -xf - -C ${tmpBunCache} --strip-components=1`,
            { timeout: 60000 }
          );
          console.log('✅ Cache extracted');
        }

        // Run bun install to create real node_modules
        console.log('📦 Running bun install...');
        const env = await fs.pathExists(tmpBunCache)
          ? { ...process.env, BUN_INSTALL_CACHE_DIR: tmpBunCache }
          : process.env;

        await execAsync('bun install', { cwd: FRONTEND_DIR, timeout: 180000, env });
        console.log('✅ Converted to real node_modules');
      }
    } catch (err) {
      console.error('Error checking node_modules:', err);
    }
  } else {
    // No node_modules - run bun install
    console.log('📦 Running bun install...');
    await execAsync('bun install', { cwd: FRONTEND_DIR, timeout: 180000 });
    console.log('✅ bun install completed');
  }
}

