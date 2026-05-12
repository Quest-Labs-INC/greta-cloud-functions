/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FILE API - SEARCH OPERATIONS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Handles search-replace, insert-text, grep, and glob operations.
 * Compatible with Emergent's MCP tool format.
 * 
 * @module api/files/search
 */

import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { PROJECT_DIR } from '../../core/config.js';
import {
  resolveSafePath,
  apiResponse,
  scheduleSyncToGCS,
  isBinaryFile,
  getAppStatus,
  listFilesRecursive
} from './helpers.js';

const router = express.Router();


/* ─────────────────────────────────────────────────────────────────────────────
 * SEARCH & REPLACE
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /search-replace - Find and replace text in a file
 * 
 * Performs literal string replacement (not regex). By default replaces only
 * the first occurrence. Compatible with Emergent's mcp_search_replace tool.
 */
router.post('/search-replace', async (req, res) => {
  try {
    const filePath = req.body.path || req.body.filePath;
    const oldStr = req.body.old_str !== undefined ? req.body.old_str : req.body.oldStr;
    const newStr = req.body.new_str !== undefined ? req.body.new_str : req.body.newStr;
    const replaceAll = req.body.replace_all !== undefined ? req.body.replace_all : (req.body.replaceAll || false);
    const status = req.body.status || false;

    if (!filePath || oldStr === undefined || newStr === undefined) {
      return apiResponse(res, 400, { error: 'path, old_str, and new_str required' });
    }

    if (oldStr === '') {
      return apiResponse(res, 400, { error: 'old_str cannot be empty' });
    }

    const fullPath = resolveSafePath(filePath);

    if (!await fs.pathExists(fullPath)) {
      return apiResponse(res, 404, { error: 'File not found' });
    }

    let content = await fs.readFile(fullPath, 'utf8');
    // Normalize CRLF → LF so searches always work regardless of file line endings
    content = content.replace(/\r\n/g, '\n');
    const originalContent = content;

    // Count occurrences before replacing
    const occurrences = content.split(oldStr).length - 1;

    if (replaceAll) {
      content = content.split(oldStr).join(newStr);
    } else {
      content = content.replace(oldStr, newStr);
    }

    if (content === originalContent) {
      const response = { changed: false, message: 'No matches found', occurrences: 0 };
      if (status) response.status = getAppStatus();
      return apiResponse(res, 200, response);
    }

    await fs.writeFile(fullPath, content, 'utf8');
    console.log(`✅ Search-replace in: ${filePath} (${replaceAll ? occurrences : 1} replacements)`);
    scheduleSyncToGCS(filePath);

    const response = {
      changed: true,
      path: filePath,
      replacements: replaceAll ? occurrences : 1,
      total_occurrences: occurrences,
      previousContent: originalContent  // Store original content for rollback
    };

    if (status) response.status = getAppStatus();

    return apiResponse(res, 200, response);
  } catch (error) {
    return apiResponse(res, 500, { error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * INSERT TEXT
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /insert-text - Insert text at a specific line number
 * 
 * Inserts new content at the specified line position (0-indexed).
 * Line 0 inserts at the beginning of the file. Multi-line insertions supported.
 */
router.post('/insert-text', async (req, res) => {
  try {
    const filePath = req.body.path || req.body.filePath;
    const newStr = req.body.new_str !== undefined ? req.body.new_str : req.body.newStr;
    const insertLine = req.body.insert_line !== undefined ? req.body.insert_line : req.body.insertLine;

    if (!filePath || newStr === undefined || insertLine === undefined) {
      return apiResponse(res, 400, { error: 'path, new_str, and insert_line required' });
    }

    if (typeof insertLine !== 'number' || insertLine < 0) {
      return apiResponse(res, 400, { error: 'insert_line must be a non-negative number' });
    }

    const fullPath = resolveSafePath(filePath);

    if (!await fs.pathExists(fullPath)) {
      return apiResponse(res, 404, { error: 'File not found' });
    }

    const content = await fs.readFile(fullPath, 'utf8');
    const lines = content.split('\n');
    const totalLinesBefore = lines.length;

    const lineIndex = Math.max(0, Math.min(insertLine, lines.length));
    const newLines = newStr.split('\n');
    lines.splice(lineIndex, 0, ...newLines);

    await fs.writeFile(fullPath, lines.join('\n'), 'utf8');
    console.log(`✅ Inserted ${newLines.length} line(s) at line ${lineIndex} in: ${filePath}`);
    scheduleSyncToGCS(filePath);  // Incremental sync

    return apiResponse(res, 200, {
      path: filePath,
      inserted_at: lineIndex,
      lines_inserted: newLines.length,
      total_lines_before: totalLinesBefore,
      total_lines_after: lines.length
    });
  } catch (error) {
    return apiResponse(res, 500, { error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * GREP - Regex Search
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /grep - Search file contents using regex
 *
 * Recursively searches files for regex pattern matches. Skips binary files,
 * node_modules, .git, and dist directories. Compatible with Emergent's grep_tool.
 */
router.post('/grep', async (req, res) => {
  try {
    const pattern = req.body.pattern;
    const filePath = req.body.path || req.body.filePath;
    const caseSensitive = req.body.case_sensitive !== undefined
      ? req.body.case_sensitive : (req.body.caseSensitive || false);
    const contextLines = req.body.context_lines !== undefined
      ? req.body.context_lines : (req.body.contextLines || 0);
    const include = req.body.include;
    const maxResults = req.body.max_results || req.body.maxResults || 1000;

    if (!pattern) {
      return apiResponse(res, 400, { error: 'pattern required' });
    }

    // Validate regex pattern
    let regex;
    try {
      const flags = caseSensitive ? 'g' : 'gi';
      regex = new RegExp(pattern, flags);
    } catch (e) {
      return apiResponse(res, 400, { error: `Invalid regex pattern: ${e.message}` });
    }

    const searchDir = filePath ? resolveSafePath(filePath) : PROJECT_DIR;
    const results = [];
    let totalMatches = 0;
    let filesSearched = 0;

    // Include pattern for filtering files
    let includeRegex = null;
    if (include) {
      const includePattern = include.replace(/\./g, '\\.').replace(/\*/g, '.*');
      includeRegex = new RegExp(includePattern + '$', 'i');
    }

    async function searchInFile(file) {
      if (totalMatches >= maxResults) return;

      try {
        if (isBinaryFile(file)) return;
        if (includeRegex && !includeRegex.test(file)) return;

        const content = await fs.readFile(file, 'utf8');
        const lines = content.split('\n');
        filesSearched++;

        const matches = [];
        lines.forEach((line, index) => {
          if (totalMatches >= maxResults) return;

          regex.lastIndex = 0;
          if (regex.test(line)) {
            const match = { line: index + 1, content: line, context: [] };

            if (contextLines > 0) {
              for (let i = Math.max(0, index - contextLines); i < index; i++) {
                match.context.push({ line: i + 1, content: lines[i], type: 'before' });
              }
              for (let i = index + 1; i <= Math.min(lines.length - 1, index + contextLines); i++) {
                match.context.push({ line: i + 1, content: lines[i], type: 'after' });
              }
            }
            matches.push(match);
            totalMatches++;
          }
        });

        if (matches.length > 0) {
          results.push({
            file: path.relative(PROJECT_DIR, file).replace(/\\/g, '/'),
            matches,
            matchCount: matches.length
          });
        }
      } catch (err) {
        // Skip unreadable files silently
      }
    }

    async function searchRecursive(dir) {
      if (totalMatches >= maxResults) return;

      const stat = await fs.stat(dir);
      if (stat.isFile()) {
        await searchInFile(dir);
        return;
      }

      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (totalMatches >= maxResults) break;
        if (item.name === 'node_modules' || item.name === '.git' || item.name === 'dist') continue;

        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          await searchRecursive(fullPath);
        } else {
          await searchInFile(fullPath);
        }
      }
    }

    await searchRecursive(searchDir);

    return apiResponse(res, 200, {
      pattern,
      results,
      totalMatches,
      filesSearched,
      truncated: totalMatches >= maxResults
    });
  } catch (error) {
    return apiResponse(res, 500, { error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * GLOB FILES - Pattern Matching
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /glob-files - Find files matching a glob pattern
 *
 * Supports standard glob syntax: *, **, ?, [abc], {a,b,c}.
 * Skips node_modules and .git directories. Compatible with Emergent's mcp_glob_files.
 */
router.post('/glob-files', async (req, res) => {
  try {
    const pattern = req.body.pattern;
    const filePath = req.body.path || req.body.filePath;
    const maxResults = req.body.max_results || req.body.maxResults || 1000;

    if (!pattern) {
      return apiResponse(res, 400, { error: 'pattern required' });
    }

    const searchDir = filePath ? resolveSafePath(filePath) : PROJECT_DIR;
    const allFiles = await listFilesRecursive(searchDir, searchDir);

    // Robust glob matching (supports *, **, ?, [abc], {a,b,c})
    const regexPattern = pattern
      .replace(/\\/g, '/')
      .replace(/\./g, '\\.')
      .replace(/\?/g, '[^/]')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/{{GLOBSTAR}}/g, '.*')
      .replace(/\{([^}]+)\}/g, (_, group) => `(${group.split(',').join('|')})`);

    let regex;
    try {
      regex = new RegExp(`^${regexPattern}$`, 'i');
    } catch (e) {
      return apiResponse(res, 400, { error: `Invalid glob pattern: ${e.message}` });
    }

    const matchedFiles = allFiles.filter(f => regex.test(f)).slice(0, maxResults);

    return apiResponse(res, 200, {
      pattern,
      files: matchedFiles,
      total_matches: matchedFiles.length,
      total_files: allFiles.length,
      truncated: matchedFiles.length >= maxResults
    });
  } catch (error) {
    return apiResponse(res, 500, { error: error.message });
  }
});


export default router;

