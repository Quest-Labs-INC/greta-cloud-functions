/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FILE API - CORE CRUD OPERATIONS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Handles basic file operations: read, write, delete, rename, list.
 * All operations are sandboxed to PROJECT_DIR for security.
 * 
 * @module api/files/core
 */

import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { PROJECT_DIR } from '../../core/config.js';
import { syncToGCS } from '../../services/storage/gcs-sync.js';
import {
  resolveSafePath,
  apiResponse,
  scheduleSyncToGCS,
  listFilesRecursive
} from './helpers.js';

const router = express.Router();


/* ─────────────────────────────────────────────────────────────────────────────
 * WRITE FILE
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /write-file - Write content to a file
 * 
 * Creates or overwrites a file with the given content. Parent directories
 * are created automatically if they don't exist.
 * 
 * Accepts both Emergent MCP format (path, file_text) and legacy format (filePath, content).
 */
router.post('/write-file', async (req, res) => {
  try {
    const filePath = req.body.path || req.body.filePath;
    const content = req.body.file_text !== undefined ? req.body.file_text : req.body.content;

    if (!filePath || content === undefined) {
      return apiResponse(res, 400, { error: 'path and file_text required' });
    }

    const fullPath = resolveSafePath(filePath);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content, 'utf8');

    console.log(`✅ File written: ${filePath}`);
    scheduleSyncToGCS(filePath);  // Incremental sync - only this file

    return apiResponse(res, 200, { path: filePath });
  } catch (error) {
    console.error('Write file error:', error);
    return apiResponse(res, 500, { error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * READ FILE / DIRECTORY
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * GET /read-file - Read file or directory contents
 * 
 * For files: Returns the content, optionally filtered by line range (1-indexed, inclusive).
 * For directories: Returns a listing of contained files and subdirectories.
 */
router.get('/read-file', async (req, res) => {
  try {
    const filePath = req.query.path || req.query.filePath;
    const viewRange = req.query.view_range;

    if (!filePath) {
      return apiResponse(res, 400, { error: 'path required' });
    }

    const fullPath = resolveSafePath(filePath);
    const stat = await fs.stat(fullPath).catch(() => null);

    if (!stat) {
      return apiResponse(res, 404, { error: 'File not found' });
    }

    // Directory listing
    if (stat.isDirectory()) {
      const items = await fs.readdir(fullPath, { withFileTypes: true });
      const contents = items.map(item => ({
        name: item.name,
        type: item.isDirectory() ? 'directory' : 'file',
        path: path.join(filePath, item.name).replace(/\\/g, '/')
      }));

      return apiResponse(res, 200, {
        type: 'directory',
        path: filePath,
        contents,
        totalItems: contents.length
      });
    }

    // File content
    const content = await fs.readFile(fullPath, 'utf8');
    const lines = content.split('\n');
    const totalLines = lines.length;

    // Support view_range [start, end] (1-indexed, inclusive)
    if (viewRange) {
      try {
        const range = JSON.parse(viewRange);
        const start = Math.max(1, range[0] || 1);
        const end = Math.min(totalLines, range[1] || totalLines);
        const selectedLines = lines.slice(start - 1, end);

        return apiResponse(res, 200, {
          content: selectedLines.join('\n'),
          path: filePath,
          view_range: [start, end],
          total_lines: totalLines,
          lines_returned: selectedLines.length
        });
      } catch (e) {
        return apiResponse(res, 400, { error: 'Invalid view_range format. Use [start, end]' });
      }
    }

    return apiResponse(res, 200, {
      type: 'file',
      content,
      path: filePath,
      total_lines: totalLines
    });
  } catch (error) {
    return apiResponse(res, 500, { error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * DELETE FILE
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * DELETE /delete-file - Remove a file or directory
 */
router.delete('/delete-file', async (req, res) => {
  try {
    const filePath = req.body.path || req.body.filePath;

    if (!filePath) {
      return apiResponse(res, 400, { error: 'path required' });
    }

    const fullPath = resolveSafePath(filePath);
    await fs.remove(fullPath);

    scheduleSyncToGCS(filePath);  // Incremental sync - mark file as deleted
    return apiResponse(res, 200, { path: filePath });
  } catch (error) {
    return apiResponse(res, 500, { error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * RENAME / MOVE FILE
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /rename-file - Rename or move a file/directory
 *
 * Can also be used to move files between directories.
 * Parent directories for the destination are created automatically.
 */
router.post('/rename-file', async (req, res) => {
  try {
    const originalPath = req.body.original_path || req.body.originalPath;
    const newPath = req.body.new_path || req.body.newPath;

    if (!originalPath || !newPath) {
      return apiResponse(res, 400, { error: 'original_path and new_path are required' });
    }

    const fullOriginalPath = resolveSafePath(originalPath);
    const fullNewPath = resolveSafePath(newPath);

    // Check if source exists
    if (!await fs.pathExists(fullOriginalPath)) {
      return apiResponse(res, 404, { error: `Source not found: ${originalPath}` });
    }

    // Create parent directory for destination if needed
    await fs.ensureDir(path.dirname(fullNewPath));

    // Perform the rename/move
    await fs.move(fullOriginalPath, fullNewPath, { overwrite: false });

    // Sync both old path (deleted) and new path (created)
    scheduleSyncToGCS(originalPath);
    scheduleSyncToGCS(newPath);

    return apiResponse(res, 200, {
      success: true,
      original_path: originalPath,
      new_path: newPath,
      message: 'File renamed successfully'
    });
  } catch (error) {
    if (error.message.includes('dest already exists')) {
      return apiResponse(res, 409, { error: `Destination already exists: ${req.body.new_path}` });
    }
    return apiResponse(res, 500, { error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * LIST FILES
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * GET /list-files - List all files in the project recursively
 *
 * Returns a flat array of all file paths in PROJECT_DIR, excluding
 * node_modules and .git directories.
 */
router.get('/list-files', async (req, res) => {
  try {
    const files = await listFilesRecursive(PROJECT_DIR);
    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * SYNC TO GCS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /sync-to-gcs - Manually trigger GCS sync
 *
 * Forces an immediate sync of project files to Google Cloud Storage.
 */
router.post('/sync-to-gcs', async (req, res) => {
  try {
    await syncToGCS(PROJECT_DIR);
    res.json({ success: true, message: 'Synced to GCS' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


export default router;

