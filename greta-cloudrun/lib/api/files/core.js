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
import {
  syncToGCS,
  syncFilesToGCS,
  listProjectVersions,
  restoreProjectVersion,
  listFileVersions,
  restoreFileVersion
} from '../../services/storage/gcs-sync.js';
import {
  resolveSafePath,
  apiResponse,
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
    // NOTE: No auto-sync here - backend will call /api/sync-to-gcs after conversation completes

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

    // NOTE: No auto-sync here - backend will call /api/sync-to-gcs after conversation completes
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

    // NOTE: No auto-sync here - backend will call /api/sync-to-gcs after conversation completes

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
 * POST /sync-to-gcs - Trigger GCS sync (conversation-based or full)
 *
 * Supports three modes:
 * 1. Incremental sync: { files: ['App.tsx', 'Button.tsx'], conversationId, messageId }
 * 2. Full sync: { fullSync: true, conversationId, messageId }
 * 3. Auto-detect: { conversationId, messageId } (syncs all modified files)
 *
 * This endpoint is called by the backend after agent conversations complete,
 * ensuring all file changes are synced as a single atomic version.
 *
 * @body {string[]} [files] - Array of file paths to sync (incremental mode)
 * @body {boolean} [fullSync] - If true, sync all files (full mode)
 * @body {string} [conversationId] - Conversation ID for metadata
 * @body {string} [messageId] - Message ID for metadata
 */
router.post('/sync-to-gcs', async (req, res) => {
  try {
    const { files, fullSync = false, conversationId, messageId } = req.body;

    const metadata = {
      conversationId,
      messageId,
      timestamp: new Date().toISOString()
    };

    let result;

    if (fullSync) {
      // Full sync - everything in PROJECT_DIR
      console.log('🔄 Full sync to GCS requested');
      await syncToGCS(PROJECT_DIR, metadata);
      result = {
        mode: 'full',
        message: 'All files synced to GCS'
      };

    } else if (files && Array.isArray(files) && files.length > 0) {
      // Incremental sync - only specified files
      console.log(`🔄 Incremental sync: ${files.length} file(s)`);
      const syncResult = await syncFilesToGCS(PROJECT_DIR, files, metadata);
      result = {
        mode: 'incremental',
        filesSynced: syncResult.success,
        filesFailed: syncResult.failed,
        files: files
      };

    } else {
      // No files specified and not full sync - nothing to do
      console.log('⏭️ No files to sync');
      result = {
        mode: 'none',
        message: 'No files to sync'
      };
    }

    return apiResponse(res, 200, {
      ...result,
      conversationId,
      messageId
    });

  } catch (error) {
    console.error('❌ Sync to GCS failed:', error);
    return apiResponse(res, 500, { error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * VERSION MANAGEMENT
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * GET /list-versions - List all project snapshots (files.zip versions)
 *
 * Returns all versions of the project with metadata showing when each
 * snapshot was created and which conversation/message triggered it.
 */
router.get('/list-versions', async (req, res) => {
  try {
    console.log('📜 Listing project versions...');
    const versions = await listProjectVersions();

    return apiResponse(res, 200, {
      success: true,
      versions,
      count: versions.length
    });

  } catch (error) {
    console.error('❌ Failed to list versions:', error);
    return apiResponse(res, 500, { error: error.message });
  }
});

/**
 * POST /restore-version - Restore project from a specific snapshot
 *
 * Body: { generation: string }
 *
 * Restores the entire project to a previous state by downloading
 * and extracting a specific version of files.zip.
 */
router.post('/restore-version', async (req, res) => {
  try {
    const { generation } = req.body;

    if (!generation) {
      return apiResponse(res, 400, { error: 'generation required' });
    }

    console.log(`🔄 Restoring project to version: ${generation}`);
    const success = await restoreProjectVersion(generation, PROJECT_DIR);

    if (success) {
      return apiResponse(res, 200, {
        success: true,
        message: 'Project restored successfully',
        generation
      });
    } else {
      return apiResponse(res, 500, {
        success: false,
        error: 'Failed to restore project'
      });
    }

  } catch (error) {
    console.error('❌ Restore failed:', error);
    return apiResponse(res, 500, { error: error.message });
  }
});

/**
 * GET /list-file-versions - List all versions of a specific file
 *
 * Query: ?path=frontend/src/App.tsx
 */
router.get('/list-file-versions', async (req, res) => {
  try {
    const filePath = req.query.path;

    if (!filePath) {
      return apiResponse(res, 400, { error: 'path query parameter required' });
    }

    console.log(`📜 Listing versions for: ${filePath}`);
    const versions = await listFileVersions(filePath);

    return apiResponse(res, 200, {
      success: true,
      file: filePath,
      versions,
      count: versions.length
    });

  } catch (error) {
    console.error('❌ Failed to list file versions:', error);
    return apiResponse(res, 500, { error: error.message });
  }
});

/**
 * POST /restore-file-version - Restore a specific file to a previous version
 *
 * Body: { path: string, generation: string }
 */
router.post('/restore-file-version', async (req, res) => {
  try {
    const { path: filePath, generation } = req.body;

    if (!filePath || !generation) {
      return apiResponse(res, 400, { error: 'path and generation required' });
    }

    console.log(`🔄 Restoring ${filePath} to version: ${generation}`);
    const success = await restoreFileVersion(filePath, generation, PROJECT_DIR);

    if (success) {
      return apiResponse(res, 200, {
        success: true,
        message: 'File restored successfully',
        file: filePath,
        generation
      });
    } else {
      return apiResponse(res, 500, {
        success: false,
        error: 'Failed to restore file'
      });
    }

  } catch (error) {
    console.error('❌ File restore failed:', error);
    return apiResponse(res, 500, { error: error.message });
  }
});


export default router;

