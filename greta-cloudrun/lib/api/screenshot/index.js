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
  const {
    url = 'http://localhost:5173',
    fullPage = false,
    width = 1280,
    height = 720,
    selector = null,
    waitFor = 2000,
    actions = []
  } = req.body || {};

  const hasActions = actions && Array.isArray(actions) && actions.length > 0;
  console.log(`📸 Taking screenshot${hasActions ? ` (with ${actions.length} pre-actions)` : ''} of ${url}...`);

  const browserInstance = await getBrowser();
  const context = await browserInstance.newContext({ viewport: { width, height } });
  const page = await context.newPage();

  const consoleLogs = [];
  const consoleErrors = [];
  const actionResults = [];

  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') consoleErrors.push(text);
    else if (type === 'warning') consoleLogs.push(`[WARN] ${text}`);
    else consoleLogs.push(text);
  });
  page.on('pageerror', error => consoleErrors.push(`[PAGE ERROR] ${error.message}`));

  try {
    // 'load' not 'networkidle' — Vite HMR WebSocket prevents networkidle from ever firing
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });

    if (hasActions) {
      console.log(`🎬 Executing ${actions.length} pre-screenshot actions...`);
      for (const action of actions) {
        const result = await executeAction(page, action);
        actionResults.push(result);
        if (!result.success) {
          console.log(`⚠️ Action failed: ${action.type} - ${result.error}`);
        } else {
          console.log(`✅ Action: ${action.type}${action.selector ? ` on ${action.selector}` : ''}`);
          if (action.type === 'click') {
            await Promise.race([
              page.waitForNavigation({ waitUntil: 'load', timeout: 5000 }),
              page.waitForTimeout(2000)
            ]).catch(() => {});
          }
        }
      }
      await page.waitForTimeout(500);
    }

    if (waitFor > 0) await page.waitForTimeout(waitFor);

    let screenshotBuffer;
    if (selector) {
      const element = await page.$(selector);
      if (!element) {
        return res.status(400).json({ error: `Selector "${selector}" not found on page` });
      }
      screenshotBuffer = await element.screenshot({ type: 'png' });
    } else {
      screenshotBuffer = await page.screenshot({ type: 'png', fullPage });
    }

    if (consoleErrors.length > 0) {
      console.log(`⚠️ Screenshot captured ${consoleErrors.length} console errors`);
      consoleErrors.forEach(err => console.log(`  ❌ ${err.substring(0, 200)}`));
    }
    console.log(`✅ Screenshot taken (${Math.round(screenshotBuffer.length / 1024)}KB)${hasActions ? ` after ${actionResults.filter(r => r.success).length}/${actions.length} actions` : ''}`);

    const finalUrl = page.url();
    const requestedPath = url.replace('http://localhost:5173', '').split('?')[0];
    const landedPath = finalUrl.replace('http://localhost:5173', '').split('?')[0];
    const redirectedToLogin = landedPath.startsWith('/login') || landedPath.startsWith('/signup');
    const reachedTarget = !redirectedToLogin && (landedPath === requestedPath || landedPath.startsWith(requestedPath));

    const response = {
      success: true,
      image: screenshotBuffer.toString('base64'),
      mimeType: 'image/png',
      size: screenshotBuffer.length,
      dimensions: { width, height },
      url: finalUrl,
      intended: requestedPath,
      landedOn: landedPath,
      reachedTarget,
      redirectedToLogin,
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
    console.error('❌ Screenshot error:', error.message);
    res.status(500).json({ error: error.message, hint: 'Make sure the frontend is running on port 5173' });
  } finally {
    await context.close().catch(() => {});
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * BROWSER CHECK
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /api/browser-check - Open pages in a real browser, optionally perform actions,
 * and return console logs + errors for each page. No screenshot image — just runtime health.
 *
 * Body params:
 * - pages: Array of { path, actions?, waitFor? } to check
 * - waitFor: default ms to wait per page (default: 3000)
 */
router.post('/browser-check', async (req, res) => {
  const { pages = [{ path: '/' }], waitFor: defaultWait = 3000, baseUrl = 'http://localhost:5173' } = req.body || {};

  console.log(`🔍 Browser check: ${pages.length} page(s) on ${baseUrl}`);

  const browserInstance = await getBrowser();
  const results = [];

  for (const pageConfig of pages.slice(0, 8)) {
    const path = pageConfig.path || '/';
    const actions = pageConfig.actions || [];
    const pageWait = pageConfig.waitFor ?? defaultWait;
    const targetUrl = `${baseUrl}${path.startsWith('/') ? path : '/' + path}`;

    console.log(`🔍 Checking: ${targetUrl}${actions.length ? ` (${actions.length} actions)` : ''}`);

    const context = await browserInstance.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const consoleLogs = [];
    const consoleErrors = [];
    const networkErrors = [];

    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error') consoleErrors.push(text);
      else consoleLogs.push(`[${type.toUpperCase()}] ${text}`);
    });
    page.on('pageerror', error => consoleErrors.push(`[PAGE ERROR] ${error.message}`));
    page.on('requestfailed', request => {
      networkErrors.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText}`);
    });

    try {
      const navResponse = await page.goto(targetUrl, { waitUntil: 'load', timeout: 15000 });
      const statusCode = navResponse?.status();

      const actionResults = [];
      for (const action of actions) {
        const result = await executeAction(page, action);
        actionResults.push(result);
        if (!result.success) {
          console.log(`⚠️ Action failed: ${action.type} — ${result.error}`);
        }
        if (action.type === 'click') {
          await Promise.race([
            page.waitForNavigation({ waitUntil: 'load', timeout: 5000 }),
            page.waitForTimeout(1500)
          ]).catch(() => {});
        }
      }

      await page.waitForTimeout(pageWait);

      const finalUrl = page.url();
      const title = await page.title().catch(() => '');

      const domContent = await page.evaluate(() => {
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
          .map(el => el.innerText?.trim())
          .filter(Boolean)
          .slice(0, 6);

        const bodyText = document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 800) || '';

        const errorMessages = Array.from(document.querySelectorAll('[role="alert"], .error, .error-message, [class*="error"], [class*="Error"]'))
          .map(el => el.innerText?.trim())
          .filter(Boolean)
          .slice(0, 5);

        const hasSpinner = !!document.querySelector(
          '[class*="spinner"], [class*="loading"], [class*="skeleton"], [aria-busy="true"], .animate-spin'
        );

        const hasEmptyState = !!document.querySelector('[class*="empty"], [class*="no-data"], [class*="no-results"]')
          || bodyText.toLowerCase().includes('no data')
          || bodyText.toLowerCase().includes('nothing here')
          || bodyText.toLowerCase().includes('no results');

        return { headings, bodyText, errorMessages, hasSpinner, hasEmptyState };
      }).catch(() => ({ headings: [], bodyText: '', errorMessages: [], hasSpinner: false, hasEmptyState: false }));

      const isBlank = !domContent.bodyText.trim();
      const landedPath = finalUrl.replace(baseUrl, '').split('?')[0] || '/';
      const redirectedToLogin = landedPath.startsWith('/login') || landedPath.startsWith('/signup');
      const reachedTarget = landedPath === path || landedPath.startsWith(path === '/' ? '/' : path);
      // Filter out non-actionable noise — agent should never try to fix these
      const realErrors = consoleErrors.filter(e =>
        !e.includes('/api/') &&
        !e.includes('Failed to fetch') &&
        !e.includes('SyntaxError: Unexpected token') &&
        !e.includes('NetworkError') &&
        !e.includes('React Router Future Flag Warning') &&
        !e.includes('Download the React DevTools') &&
        !e.includes('[vite]') &&
        !e.includes('Warning:') &&
        !e.toLowerCase().includes('deprecat')
      );

      // Filter consoleLogs — only keep actual useful logs, strip debug/info/warning noise
      const usefulLogs = consoleLogs.filter(l =>
        !l.startsWith('[DEBUG]') &&
        !l.startsWith('[INFO]') &&
        !l.startsWith('[WARNING]') &&
        !l.includes('[vite]') &&
        !l.includes('React DevTools') &&
        !l.includes('React Router Future Flag')
      );

      const hasErrors = realErrors.length > 0;

      console.log(`🔍 ${path}: status=${statusCode}, reached=${reachedTarget}, errors=${realErrors.length}/${consoleErrors.length}, blank=${isBlank}`);

      results.push({
        path,
        finalPath: landedPath,
        reachedTarget,
        redirectedToLogin,
        statusCode,
        title,
        isBlank,
        hasErrors,
        domContent,
        consoleLogs: usefulLogs.slice(-20),
        consoleErrors: realErrors,
        allConsoleErrors: consoleErrors,
        networkErrors: networkErrors.slice(-5),
        actionResults: actionResults.length > 0 ? actionResults : undefined,
        status: (hasErrors || isBlank || !reachedTarget) ? 'FAIL' : 'PASS',
        summary: (!reachedTarget)
          ? `⚠️ Did not reach ${path} — landed on ${landedPath}${redirectedToLogin ? ' (redirected to login)' : ''}`
          : (hasErrors || isBlank)
            ? `⚠️ ${isBlank ? 'blank page ' : ''}${consoleErrors.length > 0 ? `${consoleErrors.length} console error(s)` : ''}`
            : `✅ OK`
      });
    } catch (error) {
      console.error(`❌ Browser check error on ${path}:`, error.message);
      results.push({ path, status: 'ERROR', error: error.message });
    } finally {
      await context.close().catch(() => {});
    }
  }

  const failCount = results.filter(r => r.status !== 'PASS').length;
  res.json({
    success: true,
    results,
    totalPages: results.length,
    passed: results.filter(r => r.status === 'PASS').length,
    failed: failCount,
    summary: failCount === 0
      ? `✅ All ${results.length} page(s) loaded cleanly`
      : `⚠️ ${failCount}/${results.length} page(s) have issues`
  });
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

