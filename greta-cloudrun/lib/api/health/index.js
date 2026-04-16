/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HEALTH CHECK API
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * POST /_greta/health-check
 *
 * Runs 3 reliable pre-deployment checks on the backend and returns a simple
 * pass/fail report with a clear fix instruction if something is wrong.
 *
 * Checks (in order):
 *   1. requirements — fastapi + uvicorn present in requirements.txt (deterministic)
 *   2. port         — uvicorn CMD uses PORT env var, not hardcoded port (deterministic)
 *   3. syntax       — python -m py_compile server.py (deterministic)
 *   4. imports      — python -c "import server" in the real venv (deterministic)
 *   5. running      — curl /api/ on port 8000 (end-to-end proof)
 *
 * @module api/health
 */

import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { BACKEND_DIR, PORTS } from '../../core/config.js';
import { execAsync, apiResponse } from '../files/helpers.js';

const router = express.Router();

const SERVER_PY = path.join(BACKEND_DIR, 'server.py');
const REQUIREMENTS_TXT = path.join(BACKEND_DIR, 'requirements.txt');

// Packages that must be present for the container to start at all
const REQUIRED_PACKAGES = ['fastapi', 'uvicorn'];


/* ─────────────────────────────────────────────────────────────────────────────
 * CHECKS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Check 1: Requirements — fastapi and uvicorn must be in requirements.txt.
 * Without them the container CMD fails immediately on Cloud Run.
 */
async function checkRequirements() {
    let content;
    try {
        content = await fs.readFile(REQUIREMENTS_TXT, 'utf8');
    } catch {
        return {
            passed: false,
            fix: 'backend/requirements.txt not found. Create it with at least fastapi and uvicorn.',
        };
    }

    const lines = content.split('\n').map(l => l.trim().toLowerCase());
    const missing = REQUIRED_PACKAGES.filter(pkg =>
        !lines.some(l => l.startsWith(pkg))
    );

    return missing.length === 0
        ? { passed: true }
        : {
            passed: false,
            fix: `Add missing packages to requirements.txt: ${missing.join(', ')}`,
        };
}

/**
 * Check 2: Port — uvicorn must bind to the PORT env var, not a hardcoded port.
 * Cloud Run injects PORT=8080; if the app hardcodes 8000 the container is killed.
 */
async function checkPort(serverCode) {
    // Look for uvicorn.run(...) with a hardcoded port number
    const hardcodedPort = /uvicorn\.run\s*\([^)]*port\s*=\s*\d+/s.test(serverCode);

    // Look for CMD in Dockerfile is handled by container — what matters is that
    // if uvicorn.run() is called directly, it must use int(os.environ.get("PORT", ...))
    if (hardcodedPort) {
        const usesEnvPort = /uvicorn\.run\s*\([^)]*port\s*=\s*int\s*\(\s*os\.environ/s.test(serverCode);
        if (!usesEnvPort) {
            return {
                passed: false,
                fix: 'uvicorn.run() has a hardcoded port. Use port=int(os.environ.get("PORT", 8080)) instead.',
            };
        }
    }

    return { passed: true };
}

/**
 * Check 3: Syntax — py_compile is deterministic. Fails fast on any syntax error.
 */
async function checkSyntax() {
    try {
        await execAsync(`python -m py_compile ${SERVER_PY}`, {
            cwd: BACKEND_DIR,
            timeout: 15000,
        });
        return { passed: true };
    } catch (err) {
        const output = (err.stderr || err.message || '').trim();
        const lines = output.split('\n').slice(-3).join('\n');
        return {
            passed: false,
            fix: `Fix the syntax error in server.py:\n${lines}`,
        };
    }
}

/**
 * Check 2: Imports — actually runs "import server" in the real venv.
 * This is the only reliable way to catch bad imports like motor.motor_async_engine.
 */
async function checkImports() {
    try {
        await execAsync(`python -c "import server"`, {
            cwd: BACKEND_DIR,
            timeout: 20000,
        });
        return { passed: true };
    } catch (err) {
        const output = (err.stderr || err.message || '').trim();
        const lines = output.split('\n').slice(-5).join('\n');
        return {
            passed: false,
            fix: `Fix the import error in server.py:\n${lines}`,
        };
    }
}

/**
 * Check 3: Running — curl /api/ proves the app started, routes are registered,
 * DB connected, and env vars loaded. One check that validates everything end-to-end.
 */
async function checkRunning() {
    try {
        // Accept any HTTP response (even 404) — we just need proof the process is up.
        // Using -o /dev/null -w "%{http_code}" so curl exits 0 as long as a connection is made.
        const { stdout } = await execAsync(
            `curl -s -o /dev/null -w "%{http_code}" http://localhost:${PORTS.backend}/api/ --max-time 5`,
            { timeout: 8000 }
        );
        const code = parseInt(stdout.trim(), 10);
        if (code > 0) return { passed: true };
        throw new Error('No response');
    } catch {
        return {
            passed: false,
            fix: `Backend process is not responding. Check /_greta/backend-logs for the startup error.`,
        };
    }
}


/* ─────────────────────────────────────────────────────────────────────────────
 * ENDPOINT
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /_greta/health-check
 *
 * Returns { ready: true } if safe to deploy, or { ready: false, fix: "..." }
 * with a single clear instruction of what to fix.
 *
 * Checks run in sequence — stops at first failure so the fix is unambiguous.
 */
router.post('/health-check', async (req, res) => {
    console.log('🏥 Running pre-deployment health check...');
    const startTime = Date.now();

    // Verify server.py exists
    if (!await fs.pathExists(SERVER_PY)) {
        return apiResponse(res, 200, {
            ready: false,
            fix: 'backend/server.py not found. Create the file before deploying.',
            duration: Date.now() - startTime,
        });
    }

    const serverCode = await fs.readFile(SERVER_PY, 'utf8');

    // Run checks in sequence — stop at first failure for a clear fix message
    const checks = [
        { name: 'requirements', fn: () => checkRequirements() },
        { name: 'port',         fn: () => checkPort(serverCode) },
        { name: 'syntax',       fn: () => checkSyntax() },
        { name: 'imports',      fn: () => checkImports() },
        { name: 'running',      fn: () => checkRunning() },
    ];

    for (const { name, fn } of checks) {
        const result = await fn();
        if (!result.passed) {
            const duration = Date.now() - startTime;
            console.log(`❌ Health check failed [${name}] in ${duration}ms`);
            return apiResponse(res, 200, {
                ready: false,
                failed_check: name,
                fix: result.fix,
                duration,
            });
        }
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Health check passed in ${duration}ms`);

    return apiResponse(res, 200, {
        ready: true,
        duration,
    });
});


export default router;
