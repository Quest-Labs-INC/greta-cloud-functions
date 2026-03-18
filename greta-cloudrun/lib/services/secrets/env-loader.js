/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SECRETS / ENVIRONMENT LOADER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Loads project-level environment variables from Google Cloud Storage.
 * These are secrets shared between frontend and backend within a project.
 *
 * Expected GCS path: gs://{bucket}/projects/{projectId}/secrets/env.json
 * Format: JSON object with string values, e.g. {"API_KEY": "xxx", "SECRET": "yyy"}
 *
 * @module services/secrets/env-loader
 */

import { Storage } from '@google-cloud/storage';
import { createLogger } from '../../core/logger.js';
import { GCS_BUCKET, projectId } from '../../core/config.js';

const log = createLogger('Secrets');

/* ─────────────────────────────────────────────────────────────────────────────
 * GCS CLIENT
 * ───────────────────────────────────────────────────────────────────────────── */

const storage = new Storage({
  retryOptions: {
    autoRetry: true,
    maxRetries: 3,
  },
});

/* ─────────────────────────────────────────────────────────────────────────────
 * HELPERS
 * ───────────────────────────────────────────────────────────────────────────── */

/** Get path to secrets file in GCS for current project */
const getSecretsPath = () => `projects/${projectId}/secrets/env.json`;


/* ─────────────────────────────────────────────────────────────────────────────
 * LOAD SECRETS FROM GCS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Load environment variables from GCS and merge into process.env
 *
 * Downloads gs://{bucket}/projects/{projectId}/secrets/env.json and loads into process.env.
 * Existing process.env values are NOT overwritten (local env takes precedence).
 *
 * @returns {Promise<Object>} The loaded environment variables
 */
export async function loadSecretsFromGCS() {
  const secretsPath = getSecretsPath();
  log.emoji('lock', `Loading secrets from GCS: gs://${GCS_BUCKET}/${secretsPath}`);

  try {
    const bucket = storage.bucket(GCS_BUCKET);
    const file = bucket.file(secretsPath);

    // Check if file exists
    const [exists] = await file.exists();
    if (!exists) {
      log.warn(`Secrets file not found: gs://${GCS_BUCKET}/${secretsPath}`);
      return {};
    }

    // Download and parse JSON
    const [content] = await file.download();
    const secrets = JSON.parse(content.toString());

    // Validate it's an object with string values
    if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) {
      log.error('Secrets file must be a JSON object');
      return {};
    }

    const count = Object.keys(secrets).length;
    log.success(`Loaded ${count} environment variables from GCS`);

    for (const [key, value] of Object.entries(secrets)) {
      process.env[key] = String(value);
    }

    return secrets;

  } catch (error) {
    if (error instanceof SyntaxError) {
      log.error(`Invalid JSON in secrets file: ${error.message}`);
    } else {
      log.error(`Failed to load secrets: ${error.message}`);
    }
    return {};
  }
}

