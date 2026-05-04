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
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { PROJECT_DIR, FRONTEND_DIR, GCS_BUCKET, projectId } from '../../core/config.js';
import { Storage } from '@google-cloud/storage';
import { resolveSafePath, apiResponse, execAsync } from './helpers.js';
import { restartVite } from '../../services/processes/vite.js';
import { restartBackend } from '../../services/processes/backend.js';
import { syncToGCS } from '../../services/storage/gcs-sync.js';

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
 * HELPER - Retry with Delay
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Retries a function up to maxAttempts times with a delay between attempts
 *
 * @param {Function} fn - Async function to retry
 * @param {number} maxAttempts - Maximum number of attempts
 * @param {number} delayMs - Delay in milliseconds between retries
 * @param {string} operationName - Name of the operation for logging
 * @returns {Promise<any>} Result of the function
 */
async function retryWithDelay(fn, maxAttempts, delayMs, operationName) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts) {
        console.error(`❌ ${operationName} failed after ${maxAttempts} attempts`);
        throw error;
      }
      console.warn(`⚠️ ${operationName} attempt ${attempt}/${maxAttempts} failed: ${error.message}`);
      console.log(`⏳ Retrying in ${delayMs / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/* ─────────────────────────────────────────────────────────────────────────────
 * BUILD FRONTEND
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /build - Build the frontend for production
 *
 * Executes `bun run build` to create a production build in the dist/ folder.
 * Optionally supports development mode builds via `mode` parameter.
 *
 * IMPORTANT: Build runs in background to prevent blocking the event loop.
 * Returns immediately with status. Check logs for build completion.
 *
 * When minify=true, both build and GCS sync will retry up to 3 times on failure
 * with 5 second intervals between attempts.
 *
 * @body {string} [mode='production'] - Build mode: 'production' or 'development'
 * @body {boolean} [minify=false] - Whether to minify the build (enables retries)
 */

router.post('/build', (req, res) => {
  const { mode = 'production', buildId, minify = false, outDir: outDirOverride } = req.body;
  const validModes = ['production', 'development'];

  if (!validModes.includes(mode)) {
    return apiResponse(res, 400, { error: `Invalid mode. Use: ${validModes.join(', ')}` });
  }

  if (!buildId) {
    return apiResponse(res, 400, { error: 'buildId is required' });
  }

  apiResponse(res, 202, { success: true, buildId, message: 'Build started' });

  const buildScript = mode === 'development' ? 'build:dev' : 'build';
  const outDir = outDirOverride || `dist/${buildId}`;

  // Helper to execute a single build attempt
  const executeBuild = () => {
    return new Promise((resolve, reject) => {
      console.log(`🔨 Building frontend (mode: ${mode}, buildId: ${buildId})...`);
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';

      const buildProcess = spawn(
        'bash',
        ['-c', `nice -n 19 ionice -c 3 bun run ${buildScript} -- --outDir ${outDir}${minify ? '' : ' --minify false'}`],
        {
          cwd: FRONTEND_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NODE_ENV: mode }
        }
      );

      buildProcess.stdout.on('data', (data) => {
        const line = data.toString().trim();
        stdout += line + '\n';
        console.log(`[BUILD]: ${line}`);
      });

      buildProcess.stderr.on('data', (data) => {
        const line = data.toString().trim();
        stderr += line + '\n';
        console.error(`[BUILD ERROR]: ${line}`);
      });

      buildProcess.on('exit', (code) => {
        const duration = Date.now() - startTime;
        if (code !== 0) {
          console.error(`❌ Build failed with exit code ${code} after ${duration}ms`);
          reject(new Error(`Build process exited with code ${code}`));
        } else {
          console.log(`✅ Build completed in ${duration}ms`);
          resolve({ duration, stdout, stderr });
        }
      });

      buildProcess.on('error', (err) => {
        console.error(`❌ Build process error: ${err.message}`);
        reject(err);
      });
    });
  };

  // Main build execution with retry logic
  const runBuild = async () => {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 5000;

    let buildSucceeded = false;

    if (minify) {
      // With retry logic for minified builds
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await executeBuild();
          buildSucceeded = true;
          break; // Success, exit retry loop
        } catch (error) {
          const errorMsg = error?.message || String(error) || 'Unknown error';
          if (attempt === MAX_RETRIES) {
            console.error(`❌ Build failed after ${MAX_RETRIES} attempts: ${errorMsg}`);
            return; // Exit without proceeding to cleanup/sync
          }
          console.warn(`⚠️ Build attempt ${attempt}/${MAX_RETRIES} failed: ${errorMsg}`);
          console.log(`⏳ Retrying in ${RETRY_DELAY_MS / 1000} seconds...`);
          await sleep(RETRY_DELAY_MS);
        }
      }
    } else {
      // No retry for non-minified builds
      try {
        await executeBuild();
        buildSucceeded = true;
      } catch (error) {
        const errorMsg = error?.message || String(error) || 'Unknown error';
        console.error(`❌ Build failed: ${errorMsg}`);
        return; // Exit without proceeding to cleanup/sync
      }
    }

    // Safety check - should never reach here if build failed
    if (!buildSucceeded) {
      console.error(`❌ Build did not succeed, skipping cleanup and sync`);
      return;
    }

    // Clean up old build folders only after confirming new build exists
    try {
      const distDir = path.join(FRONTEND_DIR, path.dirname(outDir));
      const newBuildDir = path.join(FRONTEND_DIR, outDir);
      await fs.access(newBuildDir); // throws if new build doesn't exist

      const entries = await fs.readdir(distDir);
      const oldEntries = entries.filter(entry => entry !== buildId);

      // Delete locally
      await Promise.all(oldEntries.map(entry =>
        fs.rm(path.join(distDir, entry), { recursive: true, force: true })
      ));

      // Delete from GCS
      const bucket = new Storage().bucket(GCS_BUCKET);
      const gcsPrefix = `projects/${projectId}/files/frontend/${path.dirname(outDir)}/`;
      await Promise.all(oldEntries.map(async (entry) => {
        const [files] = await bucket.getFiles({ prefix: `${gcsPrefix}${entry}/` });
        await Promise.all(files.map(f => f.delete().catch(() => { })));
      }));
    } catch (err) {
      const errorMsg = err?.message || String(err) || 'Unknown error';
      console.error(`⚠️ Old build cleanup failed: ${errorMsg}`);
    }

    // Sync to GCS with retry logic if minify is true
    console.log('📤 Running full sync to GCS...');
    if (minify) {
      // With retry logic for minified builds
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await syncToGCS(PROJECT_DIR);
          console.log('✅ Full sync to GCS complete');
          break; // Success, exit retry loop
        } catch (err) {
          const errorMsg = err?.message || String(err) || 'Unknown error';
          if (attempt === MAX_RETRIES) {
            console.error(`❌ GCS sync failed after ${MAX_RETRIES} attempts: ${errorMsg}`);
          } else {
            console.warn(`⚠️ GCS sync attempt ${attempt}/${MAX_RETRIES} failed: ${errorMsg}`);
            console.log(`⏳ Retrying in ${RETRY_DELAY_MS / 1000} seconds...`);
            await sleep(RETRY_DELAY_MS);
          }
        }
      }
    } else {
      // No retry for non-minified builds
      try {
        await syncToGCS(PROJECT_DIR);
        console.log('✅ Full sync to GCS complete');
      } catch (err) {
        const errorMsg = err?.message || String(err) || 'Unknown error';
        console.error(`⚠️ GCS sync failed: ${errorMsg}`);
      }
    }
  };

  // Run build asynchronously
  runBuild().catch(err => {
    const errorMsg = err?.message || String(err) || 'Unknown error';
    console.error(`❌ Unexpected error in build process: ${errorMsg}`);
  });
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


/* ─────────────────────────────────────────────────────────────────────────────
 * UPDATE ENVIRONMENT VARIABLES & RESTART SERVERS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /update-env-and-restart - Update environment variables and restart servers
 *
 * First deletes specified env vars using `unset`, then sets new ones using `export`,
 * and finally restarts both Vite (client) and Python backend servers.
 *
 * @body {Object} envToAdd - Key-value pairs of environment variables to add/update
 * @body {string[]} envToDelete - Array of environment variable names to delete
 * @body {boolean} [restartClient=true] - Whether to restart Vite client server
 * @body {boolean} [restartServer=true] - Whether to restart Python backend server
 */
router.post('/update-env-and-restart', async (req, res) => {
  try {
    const {
      envToAdd = {},
      envToDelete = [],
      restartClient = true,
      restartServer = true
    } = req.body;

    const results = {
      deleted: [],
      added: [],
      clientRestarted: false,
      serverRestarted: false,
      errors: []
    };

    console.log('🔄 Updating environment variables...');

    // Step 1: Delete environment variables
    if (Array.isArray(envToDelete) && envToDelete.length > 0) {
      console.log(`🗑️ Deleting ${envToDelete.length} environment variable(s)...`);
      for (const key of envToDelete) {
        if (typeof key === 'string' && key.trim()) {
          const sanitizedKey = key.trim().replace(/[^a-zA-Z0-9_]/g, '');
          if (sanitizedKey) {
            delete process.env[sanitizedKey];
            results.deleted.push(sanitizedKey);
            console.log(`  ✓ Unset: ${sanitizedKey}`);
          }
        }
      }
    }

    // Step 2: Add/update environment variables
    if (envToAdd && typeof envToAdd === 'object') {
      const keys = Object.keys(envToAdd);
      if (keys.length > 0) {
        console.log(`📝 Setting ${keys.length} environment variable(s)...`);
        for (const [key, value] of Object.entries(envToAdd)) {
          if (typeof key === 'string' && key.trim()) {
            const sanitizedKey = key.trim().replace(/[^a-zA-Z0-9_]/g, '');
            if (sanitizedKey) {
              process.env[sanitizedKey] = String(value);
              results.added.push(sanitizedKey);
              console.log(`  ✓ Set: ${sanitizedKey}=${String(value).substring(0, 20)}${String(value).length > 20 ? '...' : ''}`);
            }
          }
        }
      }
    }

    // Step 3: Restart servers
    const restartPromises = [];

    if (restartClient) {
      console.log('🔄 Restarting Vite client server...');
      restartPromises.push(
        restartVite()
          .then(() => {
            results.clientRestarted = true;
            console.log('✅ Vite client restarted');
          })
          .catch((err) => {
            results.errors.push(`Vite restart failed: ${err.message}`);
            console.error('❌ Vite restart failed:', err.message);
          })
      );
    }

    if (restartServer) {
      console.log('🔄 Restarting Python backend server...');
      restartPromises.push(
        restartBackend()
          .then(() => {
            results.serverRestarted = true;
            console.log('✅ Python backend restarted');
          })
          .catch((err) => {
            results.errors.push(`Backend restart failed: ${err.message}`);
            console.error('❌ Backend restart failed:', err.message);
          })
      );
    }

    // Wait for all restarts to complete
    if (restartPromises.length > 0) {
      await Promise.all(restartPromises);
    }

    const success = results.errors.length === 0;
    console.log(success
      ? '✅ Environment update and restart completed successfully'
      : `⚠️ Environment update completed with errors: ${results.errors.join(', ')}`
    );

    return apiResponse(res, success ? 200 : 207, {
      success,
      message: success
        ? 'Environment variables updated and servers restarted'
        : 'Completed with some errors',
      ...results
    });
  } catch (error) {
    console.error('Update env and restart error:', error);
    return apiResponse(res, 500, { error: error.message });
  }
});


export default router;

