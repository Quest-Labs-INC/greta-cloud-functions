/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SCREENSHOT API MODULE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Take screenshots of the frontend preview using Playwright.
 * Supports pre-screenshot actions (login, fill forms, navigate) for authenticated pages.
 * Reuses a browser instance for performance.
 *
 * @module api/screenshot
 */

import express from 'express';
import { chromium } from 'playwright';

const router = express.Router();


/* ─────────────────────────────────────────────────────────────────────────────
 * BROWSER MANAGEMENT
 * ───────────────────────────────────────────────────────────────────────────── */

/** Singleton browser instance (reused for performance) */
let browser = null;

/**
 * Get or create the Playwright browser instance.
 * @returns {Promise<Browser>} Playwright browser
 */
async function getBrowser() {
  if (!browser) {
    console.log('🎭 Launching Playwright browser...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    console.log('✅ Playwright browser ready');
  }
  return browser;
}

/** Cleanup browser on process exit */
process.on('SIGTERM', async () => {
  if (browser) {
    await browser.close();
    browser = null;
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * ACTION EXECUTOR - Run actions before screenshot
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Execute a single browser action.
 * @param {Page} page - Playwright page
 * @param {Object} action - Action to execute
 * @returns {Object} Result of the action
 */
async function executeAction(page, action) {
  const startTime = Date.now();

  try {
    switch (action.type) {
      case 'goto':
        // 'load' not 'networkidle' — Vite keeps a HMR WebSocket open permanently
        // which means networkidle NEVER fires on dev servers, causing 30s hangs
        await page.goto(action.url, { waitUntil: 'load', timeout: 15000 });
        return { success: true, type: 'goto', url: action.url };

      case 'fill':
        await page.fill(action.selector, action.value);
        return { success: true, type: 'fill', selector: action.selector };

      case 'click':
        await page.click(action.selector);
        return { success: true, type: 'click', selector: action.selector };

      case 'wait':
        await page.waitForTimeout(action.ms || 1000);
        return { success: true, type: 'wait', ms: action.ms };

      case 'waitForSelector':
        await page.waitForSelector(action.selector, { timeout: action.timeout || 10000 });
        return { success: true, type: 'waitForSelector', selector: action.selector };

      case 'waitForNavigation':
        await page.waitForNavigation({ waitUntil: 'load', timeout: 15000 });
        return { success: true, type: 'waitForNavigation' };

      case 'type':
        await page.type(action.selector, action.value, { delay: action.delay || 50 });
        return { success: true, type: 'type', selector: action.selector };

      case 'select':
        await page.selectOption(action.selector, action.value);
        return { success: true, type: 'select', selector: action.selector };

      case 'check':
        await page.check(action.selector);
        return { success: true, type: 'check', selector: action.selector };

      case 'uncheck':
        await page.uncheck(action.selector);
        return { success: true, type: 'uncheck', selector: action.selector };

      case 'hover':
        await page.hover(action.selector);
        return { success: true, type: 'hover', selector: action.selector };

      case 'press':
        await page.press(action.selector || 'body', action.key);
        return { success: true, type: 'press', key: action.key };

      default:
        return { success: false, type: action.type, error: `Unknown action: ${action.type}` };
    }
  } catch (error) {
    return {
      success: false,
      type: action.type,
      selector: action.selector,
      error: error.message,
      duration: Date.now() - startTime
    };
  }
}


/* ─────────────────────────────────────────────────────────────────────────────
 * SCREENSHOT ENDPOINT
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /api/screenshot - Take a screenshot of a page.
 *
 * Body params:
 * - url: Target URL (default: http://localhost:5173)
 * - fullPage: Capture full page (default: false)
 * - width: Viewport width (default: 1280)
 * - height: Viewport height (default: 720)
 * - selector: CSS selector for specific element
 * - waitFor: Time to wait for rendering in ms (default: 2000)
 * - actions: Array of actions to perform BEFORE screenshot (login, fill forms, navigate, etc.)
 *   Each action: { type: 'goto'|'fill'|'click'|'wait'|'type'|'select'|'press', selector?, value?, url?, ms? }
 */
router.post('/screenshot', async (req, res) => {
  try {
    const {
      url = 'http://localhost:5173',
      fullPage = false,
      width = 1280,
      height = 720,
      selector = null,
      waitFor = 2000,
      actions = []  // NEW: Pre-screenshot actions
    } = req.body || {};

    const hasActions = actions && Array.isArray(actions) && actions.length > 0;
    console.log(`📸 Taking screenshot${hasActions ? ` (with ${actions.length} pre-actions)` : ''} of ${url}...`);

    const browserInstance = await getBrowser();
    const context = await browserInstance.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    let contextClosed = false;
    const closeContext = async () => { if (!contextClosed) { contextClosed = true; await context.close().catch(() => {}); } };

    // Capture console logs and errors
    const consoleLogs = [];
    const consoleErrors = [];
    const actionResults = [];

    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error') {
        consoleErrors.push(text);
      } else if (type === 'warning') {
        consoleLogs.push(`[WARN] ${text}`);
      } else {
        consoleLogs.push(text);
      }
    });

    page.on('pageerror', error => {
      consoleErrors.push(`[PAGE ERROR] ${error.message}`);
    });

    // 'load' not 'networkidle' — Vite HMR WebSocket prevents networkidle from ever firing
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });

    // Execute pre-screenshot actions if provided
    if (hasActions) {
      console.log(`🎬 Executing ${actions.length} pre-screenshot actions...`);

      for (const action of actions) {
        const result = await executeAction(page, action);
        actionResults.push(result);

        if (!result.success) {
          console.log(`⚠️ Action failed: ${action.type} - ${result.error}`);
          // Continue anyway, don't break - let screenshot show the state
        } else {
          console.log(`✅ Action: ${action.type}${action.selector ? ` on ${action.selector}` : ''}`);

          // After a click, wait for any navigation to settle
          if (action.type === 'click') {
            try {
              // Wait for either navigation or network settle after click
              await Promise.race([
                page.waitForNavigation({ waitUntil: 'load', timeout: 5000 }),
                page.waitForTimeout(2000)
              ]).catch(() => {});
            } catch {
              // No navigation happened, that's fine
            }
          }
        }
      }

      // Wait a bit after actions for any dynamic content
      await page.waitForTimeout(500);
    }

    // Additional wait if specified
    if (waitFor > 0) {
      await page.waitForTimeout(waitFor);
    }

    // Take screenshot
    let screenshotBuffer;
    if (selector) {
      const element = await page.$(selector);
      if (!element) {
        await context.close();
        return res.status(400).json({ error: `Selector "${selector}" not found on page` });
      }
      screenshotBuffer = await element.screenshot({ type: 'png' });
    } else {
      screenshotBuffer = await page.screenshot({ type: 'png', fullPage });
    }

    await closeContext();

    // Log captured errors
    if (consoleErrors.length > 0) {
      console.log(`⚠️ Screenshot captured ${consoleErrors.length} console errors`);
      consoleErrors.forEach(err => console.log(`  ❌ ${err.substring(0, 200)}`));
    }

    console.log(`✅ Screenshot taken (${Math.round(screenshotBuffer.length / 1024)}KB)${hasActions ? ` after ${actionResults.filter(r => r.success).length}/${actions.length} actions` : ''}`);

    const finalUrl = page.url();
    const requestedPath = url.replace('http://localhost:5173', '').split('?')[0];
    const landedPath = finalUrl.replace('http://localhost:5173', '').split('?')[0];
    const redirectedToLogin = landedPath.startsWith('/login') || landedPath.startsWith('/signup');
    const onExpectedPage = landedPath === requestedPath || landedPath.startsWith(requestedPath);
    const reachedTarget = !redirectedToLogin && onExpectedPage;

    const response = {
      success: true,
      image: screenshotBuffer.toString('base64'),
      mimeType: 'image/png',
      size: screenshotBuffer.length,
      dimensions: { width, height },
      url: finalUrl,
      intended: requestedPath,      // what page you asked for
      landedOn: landedPath,         // what page Playwright actually captured
      reachedTarget,                // true = you are on the right page. false = wrong page, do NOT analyze screenshot
      redirectedToLogin,            // true = not logged in, login actions failed
      consoleLogs: consoleLogs.slice(-20),
      consoleErrors,
      hasErrors: consoleErrors.length > 0
    };

    if (hasActions) {
      response.actionsExecuted = actionResults.length;
      response.actionsSucceeded = actionResults.filter(r => r.success).length;
      response.actionResults = actionResults;
    }

    res.json(response);
  } catch (error) {
    await closeContext().catch(() => {});
    console.error('❌ Screenshot error:', error.message);
    res.status(500).json({
      error: error.message,
      hint: 'Make sure the frontend is running on port 5173'
    });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * BROWSER CHECK - Visit pages and collect real console errors
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /browser-check - Visit multiple pages and return real browser console errors.
 * Much more useful than screenshots for debugging — captures actual JS errors per page.
 *
 * Body: { paths: ['/', '/login', '/dashboard'], actions?: [...] }
 */
router.post('/browser-check', async (req, res) => {
  const { paths = ['/'], waitMs = 2000 } = req.body || {};
  const BASE_URL = 'http://localhost:5173';

  try {
    const browserInstance = await getBrowser();
    const results = [];

    for (const pagePath of paths.slice(0, 5)) { // max 5 pages
      const context = await browserInstance.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await context.newPage();
      let contextClosed = false;
      const closeCtx = async () => { if (!contextClosed) { contextClosed = true; await context.close().catch(() => {}); } };

      const consoleErrors = [];
      const consoleWarnings = [];
      const networkErrors = [];

      page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
        if (msg.type() === 'warning') consoleWarnings.push(msg.text());
      });
      page.on('pageerror', err => consoleErrors.push(`[JS Error] ${err.message}`));
      page.on('requestfailed', req => {
        const url = req.url();
        // Only report API/asset failures, not HMR websocket
        if (!url.includes('/@vite') && !url.includes('ws://')) {
          networkErrors.push(`${req.method()} ${url} — ${req.failure()?.errorText || 'failed'}`);
        }
      });

      try {
        await page.goto(`${BASE_URL}${pagePath}`, { waitUntil: 'load', timeout: 15000 });
        await page.waitForTimeout(waitMs);
      } catch (err) {
        consoleErrors.push(`[Navigation Error] ${err.message}`);
      }

      results.push({
        path: pagePath,
        hasErrors: consoleErrors.length > 0,
        consoleErrors: consoleErrors.slice(0, 10),
        consoleWarnings: consoleWarnings.slice(0, 5),
        networkErrors: networkErrors.slice(0, 5),
      });

      await closeCtx();
    }

    const totalErrors = results.reduce((sum, r) => sum + r.consoleErrors.length, 0);
    console.log(`🔍 Browser check: ${paths.length} page(s), ${totalErrors} total errors`);

    const hasErrors = totalErrors > 0;
    res.json({
      success: true,          // tool ran successfully
      appHealthy: !hasErrors, // TRUE = no errors found, FALSE = errors exist — use this to decide if fixes needed
      totalErrors,
      hasErrors,
      pages: results,
      errorSummary: hasErrors
        ? results.filter(r => r.hasErrors).map(r => `${r.path}: ${r.consoleErrors.join(' | ')}`).join('\n')
        : 'No errors found — app is healthy'
    });
  } catch (error) {
    console.error('❌ Browser check error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * HEALTH CHECK
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/screenshot/health - Health check for screenshot service.
 */
router.get('/screenshot/health', async (req, res) => {
  try {
    const browserInstance = await getBrowser();
    res.json({ success: true, browserReady: !!browserInstance, message: 'Screenshot service ready' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


export default router;

