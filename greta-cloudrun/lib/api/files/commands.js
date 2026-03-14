/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FILE API - COMMAND EXECUTION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Handles bash command execution and TypeScript checking.
 * Includes security validation to prevent dangerous commands.
 * 
 * @module api/files/commands
 */

import express from 'express';
import { PROJECT_DIR, FRONTEND_DIR } from '../../core/config.js';
import { resolveSafePath, apiResponse, execAsync } from './helpers.js';
import { syncDirectoryToGCS } from '../../services/storage/gcs-sync.js';

const router = express.Router();


/* ─────────────────────────────────────────────────────────────────────────────
 * SECURITY - Blocked Command Patterns
 * ───────────────────────────────────────────────────────────────────────────── */

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/(?!app)/i,      // Block rm -rf / but allow /app paths
  /mkfs/i,                        // Block filesystem creation
  /dd\s+if=/i,                    // Block disk dump
  /:(){ :|:& };:/,                // Fork bomb
  />\s*\/dev\/sd/i,               // Block device writes
  /chmod\s+777\s+\//i,            // Block recursive chmod on root
  /wget.*\|.*sh/i,                // Block wget piped to shell
  /curl.*\|.*sh/i,                // Block curl piped to shell
  /nc\s+-[el]/i,                  // Block netcat listeners
  /python.*-c.*import\s+socket/i, // Block python socket code
  /nohup/i,                       // Block background processes
  /&\s*$/,                        // Block backgrounding
  /\|\s*bash/i,                   // Block piping to bash
  /eval\s*\(/i,                   // Block eval
];

/**
 * Validates a command against blocked security patterns.
 * 
 * @param {string} command - The command to validate
 * @returns {boolean} True if command is blocked, false if allowed
 */
function isBlockedCommand(command) {
  return BLOCKED_PATTERNS.some(pattern => pattern.test(command));
}


/* ─────────────────────────────────────────────────────────────────────────────
 * EXECUTE BASH
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /execute-bash - Execute a shell command
 * 
 * Runs a bash command in the specified working directory (defaults to PROJECT_DIR).
 * Commands are validated against a blocklist of dangerous patterns for security.
 */
router.post('/execute-bash', async (req, res) => {
  try {
    const { command, cwd, timeout = 30000 } = req.body;

    if (!command) {
      return apiResponse(res, 400, { error: 'command required' });
    }

    if (typeof command !== 'string' || command.length > 10000) {
      return apiResponse(res, 400, { error: 'Invalid command' });
    }

    // Security check
    if (isBlockedCommand(command)) {
      console.warn(`🚫 Blocked command: ${command}`);
      return apiResponse(res, 403, { error: 'Command blocked for security reasons' });
    }

    // Resolve working directory safely
    const workDir = cwd ? resolveSafePath(cwd) : PROJECT_DIR;

    console.log(`🖥️ Executing: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`);
    const startTime = Date.now();

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workDir,
        timeout: Math.min(timeout, 120000),
        maxBuffer: 1024 * 1024 * 10,
        env: {
          ...process.env,
          PATH: process.env.PATH,
          HOME: '/app',
          NODE_ENV: 'development'
        }
      });

      const duration = Date.now() - startTime;
      console.log(`✅ Command completed in ${duration}ms`);

      return apiResponse(res, 200, {
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: 0,
        duration
      });
    } catch (execError) {
      const duration = Date.now() - startTime;

      if (execError.killed) {
        console.warn(`⏱️ Command timed out after ${timeout}ms`);
        return apiResponse(res, 408, {
          error: 'Command timed out',
          stdout: execError.stdout || '',
          stderr: execError.stderr || '',
          exitCode: 124,
          duration
        });
      }

      // Command failed but completed
      return apiResponse(res, 200, {
        stdout: execError.stdout || '',
        stderr: execError.stderr || execError.message,
        exitCode: execError.code || 1,
        duration
      });
    }
  } catch (error) {
    console.error('Execute bash error:', error);
    return apiResponse(res, 500, { error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * BUILD FRONTEND
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /build - Build the frontend for production
 *
 * Executes `bun run build` to create a production build in the dist/ folder.
 * Optionally supports development mode builds via `mode` parameter.
 *
 * @body {string} [mode='production'] - Build mode: 'production' or 'development'
 */
router.post('/build', async (req, res) => {
  try {
    const { mode = 'production' } = req.body;
    const validModes = ['production', 'development'];

    if (!validModes.includes(mode)) {
      return apiResponse(res, 400, { error: `Invalid mode. Use: ${validModes.join(', ')}` });
    }

    console.log(`🔨 Building frontend (mode: ${mode})...`);
    const startTime = Date.now();

    const buildCommand = mode === 'development'
      ? 'bun run build:dev'
      : 'bun run build';

    try {
      const { stdout, stderr } = await execAsync(buildCommand, {
        cwd: FRONTEND_DIR,
        timeout: 180000, // 3 minutes for build
        maxBuffer: 1024 * 1024 * 10,
        env: {
          ...process.env,
          NODE_ENV: mode
        }
      });

      const duration = Date.now() - startTime;
      console.log(`✅ Build completed in ${duration}ms`);

      // Sync only dist folder to GCS (incremental - much faster!)
      console.log('📤 Syncing dist folder to GCS...');
      let syncResult = { success: 0, failed: 0, total: 0 };
      let syncError = null;

      try {
        syncResult = await syncDirectoryToGCS(PROJECT_DIR, 'frontend/dist');
        if (syncResult.failed === 0) {
          console.log(`✅ Dist folder synced to GCS (${syncResult.success} files)`);
        } else {
          console.warn(`⚠️ Dist sync partial: ${syncResult.success}/${syncResult.total} files`);
        }
      } catch (syncErr) {
        syncError = syncErr.message;
        console.error('⚠️ GCS sync failed (build still succeeded):', syncErr.message);
      }

      return apiResponse(res, 200, {
        success: true,
        mode,
        duration,
        stdout: stdout || '',
        stderr: stderr || '',
        message: `Frontend built successfully in ${(duration / 1000).toFixed(1)}s`,
        gcsSync: {
          filesUploaded: syncResult.success,
          filesFailed: syncResult.failed,
          totalFiles: syncResult.total,
          error: syncError
        }
      });
    } catch (execError) {
      const duration = Date.now() - startTime;
      const output = execError.stdout || '';
      const errorOutput = execError.stderr || execError.message || '';

      console.error(`❌ Build failed in ${duration}ms`);

      return apiResponse(res, 200, {
        success: false,
        mode,
        duration,
        stdout: output,
        stderr: errorOutput,
        exitCode: execError.code || 1,
        message: 'Build failed'
      });
    }
  } catch (error) {
    console.error('Build error:', error);
    return apiResponse(res, 500, { error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * TYPESCRIPT CHECK
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * GET /typescript-check - Run TypeScript compiler check
 *
 * Executes `tsc --noEmit` to find all TypeScript errors across the frontend project.
 * This provides more complete error detection than Vite's HMR.
 */
router.get('/typescript-check', async (req, res) => {
  try {
    const startTime = Date.now();
    console.log('🔍 Running TypeScript check (tsc --noEmit)...');

    try {
      await execAsync('npx tsc --noEmit 2>&1', {
        cwd: FRONTEND_DIR,
        timeout: 60000,
        maxBuffer: 1024 * 1024 * 5
      });

      const duration = Date.now() - startTime;
      console.log(`✅ TypeScript check passed in ${duration}ms`);

      return apiResponse(res, 200, {
        hasErrors: false,
        errorCount: 0,
        errors: [],
        duration
      });
    } catch (execError) {
      const duration = Date.now() - startTime;
      const output = execError.stdout || execError.stderr || execError.message || '';

      // Parse TypeScript errors
      const errorLines = output.split('\n').filter(line =>
        line.includes('error TS') || line.includes('Error:')
      );

      // Clean and deduplicate errors
      const cleanErrors = [...new Set(errorLines.map(line => {
        return line
          .replace(/^.*?frontend\//, '')
          .replace(/\(\d+,\d+\)/, '')
          .trim();
      }))].filter(Boolean).slice(0, 10);

      console.log(`❌ TypeScript check found ${cleanErrors.length} errors in ${duration}ms`);

      return apiResponse(res, 200, {
        hasErrors: cleanErrors.length > 0,
        errorCount: cleanErrors.length,
        errors: cleanErrors,
        rawOutput: output.slice(0, 2000),
        duration
      });
    }
  } catch (error) {
    console.error('TypeScript check error:', error);
    return apiResponse(res, 500, { error: error.message });
  }
});


export default router;

