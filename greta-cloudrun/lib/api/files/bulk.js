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
} from './helpers.js';
import { MAX_VIEW_FILE_LINES, MAX_OUTPUT_CHARS } from '../../core/config.js';

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
    const { files, status = false } = req.body;

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

    results.filter(r => r.success).forEach(r => scheduleSyncToGCS(r.path));

    // Build response
    const response = {
      results,
      totalFiles: files.length,
      successCount,
      failedCount: files.length - successCount,
    };

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

        const raw = await fs.readFile(fullPath, 'utf8');
        const lines = raw.split('\n');
        const totalLines = lines.length;
        // Per-file line cap so one large file can't dominate the bulk payload.
        let content = totalLines > MAX_VIEW_FILE_LINES
          ? lines.slice(0, MAX_VIEW_FILE_LINES).join('\n')
          : raw;
        const truncated = totalLines > MAX_VIEW_FILE_LINES;
        return {
          path: filePath,
          success: true,
          content,
          total_lines: totalLines,
          ...(truncated ? {
            truncated: true,
            note: `Showing lines 1-${MAX_VIEW_FILE_LINES} of ${totalLines}. Use read-file with view_range to read more.`
          } : {})
        };
      } catch (err) {
        return { path: filePath, success: false, error: err.message };
      }
    });

    const results = await Promise.all(readPromises);

    // Global output ceiling: stop including file bodies once the combined size
    // would exceed MAX_OUTPUT_CHARS, so a bulk read of many files stays bounded.
    let runningChars = 0;
    let omittedForBudget = 0;
    for (const r of results) {
      if (!r.success || typeof r.content !== 'string') continue;
      if (runningChars >= MAX_OUTPUT_CHARS) {
        r.content = '';
        r.truncated = true;
        r.note = `Omitted — bulk read exceeded ${MAX_OUTPUT_CHARS} char budget. Read this file individually with read-file.`;
        omittedForBudget += 1;
        continue;
      }
      runningChars += r.content.length;
    }

    const successCount = results.filter(r => r.success).length;

    return apiResponse(res, 200, {
      results,
      totalFiles: paths.length,
      successCount,
      failedCount: paths.length - successCount,
      ...(omittedForBudget > 0 ? { omittedForBudget } : {})
    });
  } catch (error) {
    return apiResponse(res, 500, { error: error.message });
  }
});


export default router;

