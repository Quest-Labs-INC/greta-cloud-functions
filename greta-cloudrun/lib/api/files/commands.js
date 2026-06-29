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
import http from 'http';
import { PassThrough } from 'stream';
import archiver from 'archiver';
import extractZip from 'extract-zip';
import { glob } from 'glob';
import { PROJECT_DIR, FRONTEND_DIR, BACKEND_DIR, GCS_BUCKET, projectId, VITE_PORT } from '../../core/config.js';
import { Storage } from '@google-cloud/storage';
import { resolveSafePath, apiResponse, execAsync } from './helpers.js';
import { restartVite } from '../../services/processes/vite.js';
import { restartBackend } from '../../services/processes/backend.js';
import { syncToGCS, syncFilesToGCS } from '../../services/storage/gcs-sync.js';

// Poll Vite until it responds or timeout (ms). Used after supervisorctl restarts
// so browser_check works immediately when the agent calls it next.
async function waitForVite(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise(resolve => {
      const req = http.get(`http://localhost:${VITE_PORT}/`, res => {
        res.resume();
        resolve(res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
    if (ready) return;
    await new Promise(r => setTimeout(r, 500));
  }
}

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

      // After any supervisorctl start/restart of the frontend, wait until Vite
      // is actually serving before returning — so the agent's next browser_check
      // hits a live server instead of a connection-refused.
      if (/supervisorctl\s+(start|restart)\s+frontend/.test(command)) {
        console.log('⏳ Waiting for Vite to be ready...');
        await waitForVite(15000);
        console.log('✅ Vite is ready');
      }

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

/**
 * Zip a directory into an in-memory Buffer, excluding heavy/irrelevant paths.
 *
 * Used to package the frontend SOURCE (no node_modules) for the build Lambda.
 * Source is tiny (~0.1MB gzipped for a template project), so an in-memory
 * buffer is fine. Uses fast compression (level 1) since the payload is small.
 *
 * @param {string} dir - Absolute directory to archive
 * @param {string[]} ignore - Glob patterns to exclude
 * @returns {Promise<Buffer>} Zip archive bytes
 */
function zipDirToBuffer(dir, ignore) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 1 } });
    const chunks = [];
    const collector = new PassThrough();

    collector.on('data', (c) => chunks.push(c));
    collector.on('end', () => resolve(Buffer.concat(chunks)));
    collector.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });

    archive.pipe(collector);
    archive.glob('**/*', { cwd: dir, ignore, dot: true });
    archive.finalize();
  });
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
 * BUILD FRONTEND (OFF-POD, via Lambda)
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /build-static - Build the frontend OFF the container, on a build Lambda.
 *
 * Why: running `bun run build` in-pod pins the single CPU and throttles Vite /
 * backend / mongo, making the container feel slow while the user is editing.
 * This endpoint moves the heavy build off-pod: it zips the frontend SOURCE
 * (no node_modules — ~20ms, ~4MB RAM), POSTs it to the build Lambda, gets the
 * built `dist` back, and writes it to GCS at frontend/dist-static/${buildId}.
 *
 * The Lambda is a pure compute function: source-zip in → dist-zip out. It holds
 * NO GCP credentials; the container does the GCS write (it already has them).
 *
 * IMPORTANT: Responds 202 immediately and does the work in background — check
 * logs for completion. The live preview (Vite/HMR) is unaffected; this only
 * refreshes the static GCS fallback served when the pod scales to 0.
 *
 * Lambda contract:
 *   Request : POST, body = zip archive of frontend source (no node_modules)
 *   Response: 2xx, body = zip archive whose root IS the dist contents
 *             (index.html, assets/, …). Non-2xx ⇒ build failed.
 *
 * @body {string} buildId - Required. Identifies this build; output goes to
 *                          frontend/dist-static/${buildId}.
 */
router.post('/build-static', async (req, res) => {
  const { buildId } = req.body;

  if (!buildId) {
    return apiResponse(res, 400, { error: 'buildId is required' });
  }

  const lambdaUrl = 'https://j73665t43unnoq6qihivoimm4a0wlwby.lambda-url.us-east-2.on.aws/';

  const outDir = `dist-static/${buildId}`;
  const distStaticRoot = path.join(FRONTEND_DIR, 'dist-static');
  const distDir = path.join(FRONTEND_DIR, outDir);
  const tmpZip = path.join('/tmp', `dist-${buildId}.zip`);

  const runBuild = async () => {
    const startTime = Date.now();

    // 1. Zip the frontend source (exclude node_modules / git / prior builds).
    console.log(`📦 Zipping frontend source for build ${buildId}...`);
    const sourceZip = await zipDirToBuffer(FRONTEND_DIR, [
      'node_modules/**',
      '**/node_modules/**',
      '.git/**',
      'dist/**',
      'dist-static/**',
    ]);
    console.log(`📦 Source zip: ${(sourceZip.length / 1048576).toFixed(2)}MB`);

    // 2. Ship it to the build Lambda and get the dist zip back.
    console.log(`🚀 Sending to build Lambda...`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000); // 3 min ceiling
    let lambdaRes;
    try {
      lambdaRes = await fetch(lambdaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip', 'x-build-id': buildId },
        body: sourceZip,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!lambdaRes.ok) {
      const errText = await lambdaRes.text().catch(() => '');
      throw new Error(`Lambda build failed (${lambdaRes.status}): ${errText.slice(0, 500)}`);
    }

    const distBuffer = Buffer.from(await lambdaRes.arrayBuffer());
    console.log(`📥 Received dist zip: ${(distBuffer.length / 1048576).toFixed(2)}MB`);

    // 3. Extract the returned dist into frontend/dist-static/${buildId}.
    await fs.rm(distDir, { recursive: true, force: true });
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(tmpZip, distBuffer);
    await extractZip(tmpZip, { dir: distDir });
    await fs.rm(tmpZip, { force: true });

    // 4. Write the dist files to GCS (incremental — CLAUDE.md: not syncDirectoryToGCS).
    const distFiles = await glob('**/*', { cwd: distDir, nodir: true, dot: true });
    if (distFiles.length === 0) {
      throw new Error('Lambda returned an empty dist (no files extracted)');
    }
    const relPaths = distFiles.map((f) => path.relative(PROJECT_DIR, path.join(distDir, f)));
    console.log(`📤 Syncing ${relPaths.length} dist file(s) to GCS...`);
    await syncFilesToGCS(PROJECT_DIR, relPaths);

    // 5. Clean up older build folders (local + GCS), keep only the current one.
    try {
      const entries = await fs.readdir(distStaticRoot).catch(() => []);
      const oldEntries = entries.filter((e) => e !== buildId);

      await Promise.all(oldEntries.map((e) =>
        fs.rm(path.join(distStaticRoot, e), { recursive: true, force: true })
      ));

      const bucket = new Storage().bucket(GCS_BUCKET);
      await Promise.all(oldEntries.map(async (e) => {
        const prefix = `projects/${projectId}/files/frontend/dist-static/${e}/`;
        const [files] = await bucket.getFiles({ prefix });
        await Promise.all(files.map((f) => f.delete().catch(() => { })));
      }));
    } catch (err) {
      const errorMsg = err?.message || String(err) || 'Unknown error';
      console.error(`⚠️ Old build cleanup failed: ${errorMsg}`);
    }

    console.log(`✅ Off-pod build ${buildId} complete in ${Date.now() - startTime}ms`);
  };

  try {
    await runBuild();
    apiResponse(res, 200, { success: true, buildId, message: 'Build complete' });
  } catch (err) {
    const errorMsg = err?.message || String(err) || 'Unknown error';
    console.error(`❌ Off-pod build ${buildId} failed: ${errorMsg}`);
    await fs.rm(tmpZip, { force: true }).catch(() => { });
    apiResponse(res, 500, { success: false, buildId, error: errorMsg });
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


/* ─────────────────────────────────────────────────────────────────────────────
 * PYTHON LINT CHECK
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * GET /python-lint - Run flake8 on the backend directory.
 * Returns errors, warnings, and a hasErrors flag.
 */
router.get('/python-lint', async (req, res) => {
  try {
    const startTime = Date.now();
    console.log('🐍 Running Python lint (flake8)...');

    try {
      await execAsync('python -m flake8 . --max-line-length=120 --exclude=__pycache__,.venv,venv 2>&1', {
        cwd: BACKEND_DIR,
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 2
      });

      const duration = Date.now() - startTime;
      console.log(`✅ Python lint passed in ${duration}ms`);
      return apiResponse(res, 200, { hasErrors: false, errorCount: 0, errors: [], duration });
    } catch (execError) {
      const duration = Date.now() - startTime;
      const output = execError.stdout || execError.stderr || execError.message || '';

      const lines = output.split('\n').filter(Boolean);

      // Separate errors (E/F) from warnings (W)
      const errors = lines
        .filter(l => /\s[EF]\d{3}/.test(l))
        .map(l => l.replace(BACKEND_DIR, '').trim())
        .slice(0, 20);

      const warnings = lines
        .filter(l => /\sW\d{3}/.test(l))
        .map(l => l.replace(BACKEND_DIR, '').trim())
        .slice(0, 10);

      console.log(`❌ Python lint: ${errors.length} error(s), ${warnings.length} warning(s) in ${duration}ms`);

      return apiResponse(res, 200, {
        hasErrors: errors.length > 0,
        errorCount: errors.length,
        warningCount: warnings.length,
        errors,
        warnings,
        rawOutput: output.slice(0, 2000),
        duration
      });
    }
  } catch (error) {
    console.error('Python lint error:', error);
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

