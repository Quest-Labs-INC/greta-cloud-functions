/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FILE API - BULK OPERATIONS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Handles concurrent bulk read/write operations for improved performance.
 * Compatible with Emergent's mcp_bulk_file_writer format.
 * 
 * @module api/files/bulk
 */

import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import {
  resolveSafePath,
  apiResponse,
  scheduleSyncToGCS,
  isBinaryFile,
  getAppStatus,
  getRecentLogs
} from './helpers.js';

const router = express.Router();


/* ─────────────────────────────────────────────────────────────────────────────
 * BULK WRITE FILES
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /bulk-write-files - Write multiple files concurrently
 * 
 * Processes all file writes in parallel for better performance.
 * Compatible with Emergent's mcp_bulk_file_writer tool.
 * 
 * @param {object[]} req.body.files - Array of {path, content} objects
 * @param {boolean} [req.body.capture_logs_backend=false] - Include backend logs in response
 * @param {boolean} [req.body.capture_logs_frontend=false] - Include frontend logs in response
 * @param {boolean} [req.body.status=false] - Include app status in response
 */
router.post('/bulk-write-files', async (req, res) => {
  try {
    const {
      files,
      capture_logs_backend = false,
      capture_logs_frontend = false,
      status = false
    } = req.body;

    if (!files || !Array.isArray(files)) {
      return apiResponse(res, 400, { error: 'files array required' });
    }

    if (files.length > 100) {
      return apiResponse(res, 400, { error: 'Maximum 100 files per request' });
    }

    // Process files concurrently
    const writePromises = files.map(async (file) => {
      const { path: filePath, content } = file;

      if (!filePath || content === undefined) {
        return { path: filePath || 'unknown', success: false, error: 'path and content required' };
      }

      try {
        const fullPath = resolveSafePath(filePath);
        await fs.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, content, 'utf8');
        return { path: filePath, success: true };
      } catch (err) {
        return { path: filePath, success: false, error: err.message };
      }
    });

    const results = await Promise.all(writePromises);
    const successCount = results.filter(r => r.success).length;

    console.log(`✅ Bulk write: ${successCount}/${files.length} files written`);

    // Incremental sync - only the files that were written
    results.filter(r => r.success).forEach(r => scheduleSyncToGCS(r.path));

    // Build response
    const response = {
      results,
      totalFiles: files.length,
      successCount,
      failedCount: files.length - successCount
    };

    if (capture_logs_backend) {
      response.backendLogs = getRecentLogs('backend', 50);
    }

    if (capture_logs_frontend) {
      response.frontendLogs = getRecentLogs('frontend', 50);
    }

    if (status) {
      response.status = getAppStatus();
    }

    return apiResponse(res, 200, response);
  } catch (error) {
    console.error('Bulk write error:', error);
    return apiResponse(res, 500, { error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * BULK READ FILES
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /bulk-read-files - Read multiple files concurrently
 * 
 * Processes all file reads in parallel for better performance.
 * Binary files are skipped with an error message.
 * 
 * @param {string[]} req.body.paths - Array of file paths to read
 */
router.post('/bulk-read-files', async (req, res) => {
  try {
    const { paths } = req.body;

    if (!paths || !Array.isArray(paths)) {
      return apiResponse(res, 400, { error: 'paths array required' });
    }

    if (paths.length > 100) {
      return apiResponse(res, 400, { error: 'Maximum 100 files per request' });
    }

    // Process files concurrently
    const readPromises = paths.map(async (filePath) => {
      try {
        const fullPath = resolveSafePath(filePath);

        if (isBinaryFile(filePath)) {
          return { path: filePath, success: false, error: 'Binary file - use download endpoint' };
        }

        if (!await fs.pathExists(fullPath)) {
          return { path: filePath, success: false, error: 'File not found' };
        }

        const content = await fs.readFile(fullPath, 'utf8');
        return { path: filePath, success: true, content };
      } catch (err) {
        return { path: filePath, success: false, error: err.message };
      }
    });

    const results = await Promise.all(readPromises);
    const successCount = results.filter(r => r.success).length;

    return apiResponse(res, 200, {
      results,
      totalFiles: paths.length,
      successCount,
      failedCount: paths.length - successCount
    });
  } catch (error) {
    return apiResponse(res, 500, { error: error.message });
  }
});


export default router;

