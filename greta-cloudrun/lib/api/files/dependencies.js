/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FILE API - DEPENDENCY MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Handles NPM (bun) and Python (pip) package management.
 * Auto-syncs changes to GCS for persistence across container restarts.
 * 
 * @module api/files/dependencies
 */

import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { PROJECT_DIR, FRONTEND_DIR, BACKEND_DIR, projectId } from '../../core/config.js';
import { syncToGCS } from '../../services/storage/gcs-sync.js';
import { ensureNodeModules, execAsync } from './helpers.js';
import { restartVite } from '../../services/processes/vite.js';
import { restartBackend } from '../../services/processes/backend.js';

const router = express.Router();


/* ─────────────────────────────────────────────────────────────────────────────
 * NPM DEPENDENCIES (via Bun)
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * POST /add-dependency - Install an NPM package in the frontend
 *
 * Runs `bun add` in FRONTEND_DIR. Package is saved to package.json.
 * Vite will auto-detect the new dependency via HMR (no restart needed).
 */
router.post('/add-dependency', async (req, res) => {
  try {
    const { packageName, isDev = false } = req.body;
    const flag = isDev ? '--dev' : '';

    console.log(`📦 Installing package with bun: ${packageName}...`);

    await ensureNodeModules();

    await execAsync(`bun add ${flag} ${packageName}`, {
      cwd: FRONTEND_DIR,
      timeout: 120000
    });

    console.log(`✅ Installed package: ${packageName}`);

    // Sync package.json to GCS for persistence
    console.log('💾 Syncing package.json to GCS for persistence...');
    await syncToGCS(PROJECT_DIR);

    // Vite MUST restart after new packages — HMR alone won't re-resolve new modules
    console.log('🔄 Restarting Vite after package install...');
    await restartVite().catch(err => console.error('⚠️ Vite restart failed:', err.message));
    await new Promise(r => setTimeout(r, 6000));

    res.json({
      success: true,
      package: packageName,
      message: `Installed ${packageName} via bun and restarted Vite.`
    });
  } catch (error) {
    console.error(`❌ Failed to install package:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /remove-dependency - Uninstall an NPM package from the frontend
 */
router.post('/remove-dependency', async (req, res) => {
  try {
    const { packageName } = req.body;

    if (!packageName) {
      return res.status(400).json({ error: 'packageName is required' });
    }

    console.log(`📦 Uninstalling package with bun: ${packageName}...`);

    await ensureNodeModules();

    await execAsync(`bun remove ${packageName}`, {
      cwd: FRONTEND_DIR,
      timeout: 60000
    });

    console.log(`✅ Uninstalled package: ${packageName}`);

    // Sync to GCS for persistence
    console.log('💾 Syncing package.json to GCS for persistence...');
    await syncToGCS(PROJECT_DIR);

    // Restart Vite after package removal
    console.log('🔄 Restarting Vite after package removal...');
    await restartVite().catch(err => console.error('⚠️ Vite restart failed:', err.message));
    await new Promise(r => setTimeout(r, 3000));

    res.json({
      success: true,
      package: packageName,
      message: `Successfully removed ${packageName} via bun and restarted Vite`
    });
  } catch (error) {
    console.error(`❌ Failed to uninstall package:`, error.message);
    res.status(500).json({ error: error.message });
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * PYTHON DEPENDENCIES (via pip)
 * ───────────────────────────────────────────────────────────────────────────── */

const PIP_PATH = '/opt/venv/bin/pip';

/**
 * POST /add-python-dependency - Install a Python package in the backend
 * 
 * Runs `pip install` using the virtual environment at /opt/venv.
 * Automatically updates requirements.txt with the installed version.
 */
router.post('/add-python-dependency', async (req, res) => {
  try {
    const { packageName, version } = req.body;

    if (!packageName) {
      return res.status(400).json({ error: 'packageName is required' });
    }

    const packageSpec = version ? `${packageName}==${version}` : packageName;
    console.log(`🐍 Installing Python package: ${packageSpec}...`);

    const requirementsPath = path.join(BACKEND_DIR, 'requirements.txt');

    exec(`${PIP_PATH} install ${packageSpec}`, { cwd: BACKEND_DIR }, async (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ Failed to install ${packageSpec}:`, stderr || error.message);
        return res.status(500).json({ error: stderr || error.message });
      }

      console.log(`✅ Installed Python package: ${packageSpec}`);

      // Update requirements.txt
      try {
        let requirements = '';
        if (await fs.pathExists(requirementsPath)) {
          requirements = await fs.readFile(requirementsPath, 'utf8');
        }

        const packageNameLower = packageName.toLowerCase();
        const lines = requirements.split('\n');
        const alreadyExists = lines.some(line => {
          const lineLower = line.toLowerCase().trim();
          return lineLower.startsWith(packageNameLower + '==') ||
                 lineLower.startsWith(packageNameLower + '>=') ||
                 lineLower.startsWith(packageNameLower + '<=') ||
                 lineLower === packageNameLower;
        });

        if (!alreadyExists) {
          exec(`${PIP_PATH} show ${packageName} | grep Version`, { cwd: BACKEND_DIR }, async (err, versionOut) => {
            let versionLine = packageName;
            if (!err && versionOut) {
              const versionMatch = versionOut.match(/Version:\s*(.+)/);
              if (versionMatch) {
                versionLine = `${packageName}>=${versionMatch[1].trim()}`;
              }
            }

            const newRequirements = requirements.trim() + '\n' + versionLine + '\n';
            await fs.writeFile(requirementsPath, newRequirements);
            console.log(`📝 Updated requirements.txt with ${versionLine}`);

            res.json({ success: true, package: packageName, addedToRequirements: versionLine });
            const t1 = setTimeout(() => { restartBackend().catch(e => console.error('⚠️ Backend restart failed:', e.message)); clearTimeout(t1); }, 3000);
          });
        } else {
          res.json({ success: true, package: packageName, addedToRequirements: false, message: 'Already in requirements.txt' });
          const t2 = setTimeout(() => { restartBackend().catch(e => console.error('⚠️ Backend restart failed:', e.message)); clearTimeout(t2); }, 3000);
        }
      } catch (reqError) {
        console.error('Warning: Could not update requirements.txt:', reqError.message);
        res.json({ success: true, package: packageName, addedToRequirements: false, warning: reqError.message });
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /remove-python-dependency - Uninstall a Python package from the backend
 *
 * Runs `pip uninstall` using the virtual environment at /opt/venv.
 * Also removes the package from requirements.txt if present.
 */
router.post('/remove-python-dependency', async (req, res) => {
  try {
    const { packageName } = req.body;

    if (!packageName) {
      return res.status(400).json({ error: 'packageName is required' });
    }

    console.log(`🐍 Uninstalling Python package: ${packageName}...`);
    const requirementsPath = path.join(BACKEND_DIR, 'requirements.txt');

    exec(`${PIP_PATH} uninstall -y ${packageName}`, { cwd: BACKEND_DIR }, async (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ Failed to uninstall ${packageName}:`, stderr || error.message);
        return res.status(500).json({ error: stderr || error.message });
      }

      console.log(`✅ Uninstalled Python package: ${packageName}`);

      // Remove from requirements.txt if present
      let removedFromRequirements = false;
      try {
        if (await fs.pathExists(requirementsPath)) {
          let requirements = await fs.readFile(requirementsPath, 'utf8');
          const packageNameLower = packageName.toLowerCase();
          const lines = requirements.split('\n');

          const filteredLines = lines.filter(line => {
            const lineLower = line.toLowerCase().trim();
            return !(lineLower.startsWith(packageNameLower + '==') ||
                     lineLower.startsWith(packageNameLower + '>=') ||
                     lineLower.startsWith(packageNameLower + '<=') ||
                     lineLower.startsWith(packageNameLower + '[') ||
                     lineLower === packageNameLower);
          });

          if (filteredLines.length !== lines.length) {
            await fs.writeFile(requirementsPath, filteredLines.join('\n'));
            console.log(`📝 Removed ${packageName} from requirements.txt`);
            removedFromRequirements = true;
          }
        }
      } catch (reqError) {
        console.error('Warning: Could not update requirements.txt:', reqError.message);
      }

      res.json({
        success: true,
        package: packageName,
        message: `Successfully removed ${packageName}`,
        removedFromRequirements
      });
      const t3 = setTimeout(() => { restartBackend().catch(e => console.error('⚠️ Backend restart failed:', e.message)); clearTimeout(t3); }, 3000);
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


export default router;

