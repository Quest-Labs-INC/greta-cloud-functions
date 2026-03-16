/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GOOGLE CLOUD STORAGE SYNC
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Synchronizes project files between local filesystem and Google Cloud Storage.
 *
 * Features:
 * - Fast archive-based downloads (files.zip)
 * - Parallel file uploads with batching
 * - node_modules caching for faster cold starts
 * - Fallback to individual file downloads for backwards compatibility
 * - Project existence check (hasGCSData) for smart startup
 *
 * @module services/storage/gcs-sync
 */

import { Storage } from '@google-cloud/storage';
import fs from 'fs-extra';
import path from 'path';
import archiver from 'archiver';
import extractZip from 'extract-zip';
import https from 'https';
import http from 'http';

import { GCS_BUCKET, projectId } from '../../core/config.js';
import { gcsLogger as log } from '../../core/logger.js';
import { getContentType } from './content-types.js';


/* ─────────────────────────────────────────────────────────────────────────────
 * HTTP AGENT CONFIGURATION
 * ───────────────────────────────────────────────────────────────────────────── */

// Increase connection pool for parallel downloads (Node.js default is only 5!)
https.globalAgent.maxSockets = 100;
http.globalAgent.maxSockets = 100;


/* ─────────────────────────────────────────────────────────────────────────────
 * GCS CLIENT
 * ───────────────────────────────────────────────────────────────────────────── */

const storage = new Storage({
  retryOptions: {
    autoRetry: true,
    maxRetries: 3,
  },
});


/* ─────────────────────────────────────────────────────────────────────────────
 * CONSTANTS
 * ───────────────────────────────────────────────────────────────────────────── */

/** Batch size for parallel uploads/downloads */
const BATCH_SIZE = 50;

/** Directories to exclude from sync (dist is NOT excluded - needed for production builds) */
const EXCLUDE_DIRS = ['node_modules', '.git', '__pycache__', '.venv'];


/* ─────────────────────────────────────────────────────────────────────────────
 * CHECK GCS DATA EXISTS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Check if project has data stored in GCS
 *
 * Used during container startup to decide whether to:
 * - Use GCS data (existing project)
 * - Use main-template (new project)
 *
 * @returns {Promise<boolean>} True if project has files in GCS
 */
export async function hasGCSData() {
  try {
    const bucket = storage.bucket(GCS_BUCKET);

    // Check for files.zip first (fast path)
    const zipFile = bucket.file(`projects/${projectId}/files.zip`);
    const [zipExists] = await zipFile.exists();
    if (zipExists) {
      log.info(`Found files.zip in GCS for project ${projectId}`);
      return true;
    }

    // Check for individual files (fallback)
    const prefix = `projects/${projectId}/files/`;
    const [files] = await bucket.getFiles({ prefix, maxResults: 1 });
    if (files.length > 0) {
      log.info(`Found individual files in GCS for project ${projectId}`);
      return true;
    }

    log.info(`No GCS data found for project ${projectId} - will use template`);
    return false;

  } catch (error) {
    log.error(`Error checking GCS data: ${error.message}`);
    return false; // Assume no data on error, use template
  }
}


/* ─────────────────────────────────────────────────────────────────────────────
 * DOWNLOAD FROM GCS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Download project files from GCS
 *
 * Uses optimized archive download when available, falls back to individual files.
 *
 * @param {string} targetDir - Local directory to download to
 * @returns {Promise<boolean>} True if files were downloaded
 */
export async function syncFromGCS(targetDir) {
  log.emoji('download', `Downloading from GCS: gs://${GCS_BUCKET}/projects/${projectId}/`);

  try {
    const bucket = storage.bucket(GCS_BUCKET);

    // Try archive-based download first (FAST PATH)
    const downloaded = await downloadFromArchive(bucket, targetDir);
    if (downloaded) return true;

    // Fallback to individual files
    return await downloadIndividualFiles(bucket, targetDir);

  } catch (error) {
    log.error(`Download error: ${error.message}`);
    return false;
  }
}


/* ─────────────────────────────────────────────────────────────────────────────
 * UPLOAD TO GCS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Upload project files to GCS
 * 
 * Creates both a zip archive (for fast downloads) and individual files (for browsing).
 * 
 * @param {string} sourceDir - Local directory to upload from
 * @returns {Promise<void>}
 */
export async function syncToGCS(sourceDir) {
  log.emoji('upload', `Uploading to GCS: gs://${GCS_BUCKET}/projects/${projectId}/`);

  try {
    const bucket = storage.bucket(GCS_BUCKET);
    const files = await listFilesRecursive(sourceDir, EXCLUDE_DIRS);

    log.info(`Uploading ${files.length} files...`);

    // Create and upload archive
    await uploadArchive(bucket, sourceDir, files);

    // Also upload individual files for browsing
    await uploadIndividualFiles(bucket, sourceDir, files);

    log.success(`Uploaded ${files.length} files to GCS`);

  } catch (error) {
    log.error(`Upload error: ${error.message}`);
    throw error;
  }
}


/* ─────────────────────────────────────────────────────────────────────────────
 * INCREMENTAL SYNC - Individual Files
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Sync specific files to GCS (incremental sync)
 *
 * Used for quick updates when only a few files changed.
 * Much faster than full sync for small changes.
 *
 * Errors are logged but don't stop the entire sync - partial success is allowed.
 *
 * @param {string} baseDir - Base directory (e.g., PROJECT_DIR)
 * @param {string[]} filePaths - Array of relative file paths to sync
 * @returns {Promise<{success: number, failed: number}>}
 */
export async function syncFilesToGCS(baseDir, filePaths) {
  if (!filePaths || filePaths.length === 0) {
    return { success: 0, failed: 0 };
  }

  // Validate inputs
  if (!baseDir || typeof baseDir !== 'string') {
    log.error('syncFilesToGCS: Invalid baseDir');
    return { success: 0, failed: filePaths.length };
  }

  log.emoji('upload', `Syncing ${filePaths.length} file(s) to GCS...`);

  const bucket = storage.bucket(GCS_BUCKET);
  const startTime = Date.now();
  let successCount = 0;
  let failedCount = 0;

  // Process files with individual error handling
  const results = await Promise.allSettled(filePaths.map(async (relativePath) => {
    try {
      // Normalize path separators for cross-platform compatibility
      const normalizedPath = relativePath.replace(/\\/g, '/');
      const fullPath = path.join(baseDir, relativePath);

      // Check if file exists
      const exists = await fs.pathExists(fullPath);
      if (!exists) {
        // File was deleted - remove from GCS
        const gcsPath = `projects/${projectId}/files/${normalizedPath}`;
        try {
          await bucket.file(gcsPath).delete();
          log.info(`Deleted from GCS: ${normalizedPath}`);
        } catch (e) {
          // File might not exist in GCS, that's OK
          if (e.code !== 404) {
            log.warn(`Could not delete ${normalizedPath}: ${e.message}`);
          }
        }
        return { path: normalizedPath, action: 'deleted' };
      }

      // Read and upload file
      const content = await fs.readFile(fullPath);
      const gcsPath = `projects/${projectId}/files/${normalizedPath}`;
      const contentType = getContentType(relativePath);

      await bucket.file(gcsPath).save(content, {
        contentType,
        metadata: { cacheControl: 'no-cache' }
      });

      return { path: normalizedPath, action: 'uploaded' };
    } catch (error) {
      throw new Error(`${relativePath}: ${error.message}`);
    }
  }));

  // Count successes and failures
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      successCount++;
    } else {
      failedCount++;
      log.error(`Failed to sync ${filePaths[index]}: ${result.reason?.message || 'Unknown error'}`);
    }
  });

  const elapsed = Date.now() - startTime;

  if (failedCount === 0) {
    log.success(`Synced ${successCount} file(s) in ${elapsed}ms`);
  } else {
    log.warn(`Synced ${successCount}/${filePaths.length} files (${failedCount} failed) in ${elapsed}ms`);
  }

  return { success: successCount, failed: failedCount };
}


/* ─────────────────────────────────────────────────────────────────────────────
 * INCREMENTAL SYNC - Directory
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Sync a specific directory to GCS (e.g., dist/ after build)
 *
 * Uploads all files in the directory without updating the main archive.
 * Individual file failures are logged but don't stop the entire sync.
 *
 * @param {string} baseDir - Base directory (e.g., PROJECT_DIR)
 * @param {string} subDir - Subdirectory to sync (e.g., 'frontend/dist')
 * @returns {Promise<{success: number, failed: number, total: number}>}
 */
export async function syncDirectoryToGCS(baseDir, subDir) {
  // Validate inputs
  if (!baseDir || typeof baseDir !== 'string') {
    log.error('syncDirectoryToGCS: Invalid baseDir');
    return { success: 0, failed: 0, total: 0 };
  }
  if (!subDir || typeof subDir !== 'string') {
    log.error('syncDirectoryToGCS: Invalid subDir');
    return { success: 0, failed: 0, total: 0 };
  }

  const fullDir = path.join(baseDir, subDir);

  if (!await fs.pathExists(fullDir)) {
    log.warn(`Directory does not exist: ${subDir}`);
    return { success: 0, failed: 0, total: 0 };
  }

  log.emoji('upload', `Syncing directory ${subDir} to GCS...`);

  const bucket = storage.bucket(GCS_BUCKET);
  const startTime = Date.now();
  let successCount = 0;
  let failedCount = 0;

  try {
    const files = await listFilesRecursive(fullDir, []);

    if (files.length === 0) {
      log.info(`No files to sync in ${subDir}`);
      return { success: 0, failed: 0, total: 0 };
    }

    log.info(`Uploading ${files.length} files from ${subDir}...`);

    // Upload in batches with individual error handling
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(batch.map(async (fullPath) => {
        // Normalize path separators for cross-platform compatibility
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const gcsPath = `projects/${projectId}/files/${relativePath}`;
        const content = await fs.readFile(fullPath);
        const contentType = getContentType(fullPath);

        await bucket.file(gcsPath).save(content, {
          contentType,
          metadata: { cacheControl: 'no-cache' }
        });

        return relativePath;
      }));

      // Count successes and failures
      results.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          successCount++;
        } else {
          failedCount++;
          const failedPath = path.relative(baseDir, batch[idx]);
          log.error(`Failed to upload ${failedPath}: ${result.reason?.message || 'Unknown error'}`);
        }
      });
    }

    const elapsed = Date.now() - startTime;

    if (failedCount === 0) {
      log.success(`Synced ${successCount} files from ${subDir} in ${elapsed}ms`);
    } else {
      log.warn(`Synced ${successCount}/${files.length} files from ${subDir} (${failedCount} failed) in ${elapsed}ms`);
    }

    return { success: successCount, failed: failedCount, total: files.length };

  } catch (error) {
    log.error(`Directory sync error: ${error.message}`);
    // Return partial results if we have any
    return { success: successCount, failed: failedCount, total: successCount + failedCount };
  }
}


/* ─────────────────────────────────────────────────────────────────────────────
 * NODE_MODULES CACHING
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Upload node_modules to GCS for caching
 * 
 * Called after npm/bun install to cache project-specific dependencies.
 * Skips if node_modules is a symlink (using template).
 * 
 * @param {string} localDir - Directory containing node_modules
 * @returns {Promise<void>}
 */
export async function syncNodeModulesToGCS(localDir) {
  const nodeModulesPath = path.join(localDir, 'node_modules');

  // Check if node_modules exists and is not a symlink
  const stats = await fs.lstat(nodeModulesPath).catch(() => null);
  if (!stats) {
    log.info('node_modules does not exist, skipping cache');
    return;
  }

  if (stats.isSymbolicLink()) {
    log.info('node_modules is a symlink, skipping cache');
    return;
  }

  log.emoji('package', 'Caching node_modules to GCS...');

  try {
    await createAndUploadNodeModulesCache(localDir, nodeModulesPath);
    log.success('node_modules cached to GCS');
  } catch (error) {
    log.error(`Failed to cache node_modules: ${error.message}`);
  }
}


/* ─────────────────────────────────────────────────────────────────────────────
 * INTERNAL HELPERS - DOWNLOAD
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Download from zip archive (fast path)
 * @private
 */
async function downloadFromArchive(bucket, targetDir) {
  const zipFile = bucket.file(`projects/${projectId}/files.zip`);
  const [exists] = await zipFile.exists();

  if (!exists) return false;

  log.emoji('package', 'Found files.zip - using fast download...');

  const localZip = path.join(targetDir, 'files.zip');
  const startTime = Date.now();

  await zipFile.download({ destination: localZip });
  log.success(`Downloaded archive in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  const extractStart = Date.now();
  await extractZip(localZip, { dir: targetDir });
  await fs.remove(localZip);
  log.success(`Extracted files in ${((Date.now() - extractStart) / 1000).toFixed(1)}s`);

  return true;
}

/**
 * Download individual files (fallback)
 * @private
 */
async function downloadIndividualFiles(bucket, targetDir) {
  log.warn('No archive found, falling back to individual file download...');

  const prefix = `projects/${projectId}/files/`;
  const [files] = await bucket.getFiles({ prefix });

  if (files.length === 0) {
    log.info('No files found in GCS, starting with empty project');
    return false;
  }

  log.info(`Found ${files.length} files in GCS`);
  const startTime = Date.now();

  // Download in parallel batches
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (file) => {
      const relativePath = file.name.replace(prefix, '');
      if (!relativePath) return;

      const localPath = path.join(targetDir, relativePath);
      await fs.ensureDir(path.dirname(localPath));
      await file.download({ destination: localPath });
    }));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.success(`Downloaded ${files.length} files in ${elapsed}s`);

  // Also check for cached node_modules
  await downloadNodeModulesCache(bucket, targetDir);

  return true;
}

/**
 * Download cached node_modules (if exists)
 * @private
 */
async function downloadNodeModulesCache(bucket, targetDir) {
  try {
    const file = bucket.file(`projects/${projectId}/node_modules.zip`);
    const [exists] = await file.exists();

    if (!exists) {
      log.info('No cached node_modules found');
      return;
    }

    log.emoji('download', 'Downloading cached node_modules...');
    const localZip = path.join(targetDir, 'node_modules.zip');

    await file.download({ destination: localZip });
    await extractZip(localZip, { dir: targetDir });
    await fs.remove(localZip);

    log.success('Restored cached node_modules');
  } catch (error) {
    log.warn(`Could not restore node_modules cache: ${error.message}`);
  }
}


/* ─────────────────────────────────────────────────────────────────────────────
 * INTERNAL HELPERS - UPLOAD
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Create and upload zip archive
 * @private
 */
async function uploadArchive(bucket, sourceDir, files) {
  const zipPath = path.join(sourceDir, 'files.zip');

  // Create archive
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 5 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    for (const file of files) {
      const relativePath = path.relative(sourceDir, file).replace(/\\/g, '/');
      archive.file(file, { name: relativePath });
    }

    archive.finalize();
  });

  // Upload archive
  await bucket.upload(zipPath, {
    destination: `projects/${projectId}/files.zip`,
    metadata: { contentType: 'application/zip' },
  });

  await fs.remove(zipPath);
}

/**
 * Upload individual files for browsing
 * @private
 */
async function uploadIndividualFiles(bucket, sourceDir, files) {
  const prefix = `projects/${projectId}/files/`;

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (file) => {
      const relativePath = path.relative(sourceDir, file).replace(/\\/g, '/');
      await bucket.upload(file, {
        destination: `${prefix}${relativePath}`,
        metadata: { contentType: getContentType(file) },
      });
    }));
  }
}

/**
 * Create and upload node_modules cache
 * @private
 */
async function createAndUploadNodeModulesCache(localDir, nodeModulesPath) {
  const bucket = storage.bucket(GCS_BUCKET);
  const zipPath = path.join(localDir, 'node_modules.zip');

  // Create archive
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 5 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(nodeModulesPath, 'node_modules');
    archive.finalize();
  });

  // Upload to GCS
  await bucket.upload(zipPath, {
    destination: `projects/${projectId}/node_modules.zip`,
  });

  await fs.remove(zipPath);
}


/* ─────────────────────────────────────────────────────────────────────────────
 * INTERNAL HELPERS - FILESYSTEM
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * List files recursively, excluding specified directories
 * @private
 */
async function listFilesRecursive(dir, exclude = []) {
  const files = [];
  const items = await fs.readdir(dir, { withFileTypes: true });

  for (const item of items) {
    if (exclude.includes(item.name)) continue;

    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath, exclude));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

