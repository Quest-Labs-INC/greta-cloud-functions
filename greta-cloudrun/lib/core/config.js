/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Central configuration module for the Greta Cloud Run environment.
 * All constants, environment variables, and configuration values are defined here.
 * 
 * @module core/config
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));


/* ─────────────────────────────────────────────────────────────────────────────
 * VERSION
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Image version - INCREMENT when pushing new features
 * Used for tracking deployed container versions
 */

export const IMAGE_VERSION = 'v71';


/* ─────────────────────────────────────────────────────────────────────────────
 * SERVER PORTS
 * ───────────────────────────────────────────────────────────────────────────── */

export const PORTS = {
  /** Main orchestrator server (Cloud Run entry point) */
  main: Number(process.env.PORT) || 8080,

  /** Vite dev server for frontend HMR */
  vite: Number(process.env.VITE_PORT) || 5173,

  /** Python FastAPI backend */
  backend: Number(process.env.BACKEND_PORT) || 8000,

  /** Local MongoDB instance */
  mongo: Number(process.env.MONGO_PORT) || 27017,
};

// Legacy exports for backwards compatibility
export const PORT = PORTS.main;
export const VITE_PORT = PORTS.vite;
export const BACKEND_PORT = PORTS.backend;
export const MONGO_PORT = PORTS.mongo;


/* ─────────────────────────────────────────────────────────────────────────────
 * FILE PATHS
 * ───────────────────────────────────────────────────────────────────────────── */

export const PATHS = {
  /** Root project directory (container workspace) */
  project: '/app/project',

  /** Frontend source directory */
  frontend: '/app/project/frontend',

  /** Backend source directory */
  backend: '/app/project/backend',

  /** MongoDB data directory */
  mongoData: '/data/db',

  /** Frontend template for new projects */
  frontendTemplate: process.env.FRONTEND_TEMPLATE_DIR || '/frontend-template',

  /** Backend template for new projects */
  backendTemplate: process.env.BACKEND_TEMPLATE_DIR || '/backend-template',

  /** Pre-installed node_modules in template */
  get frontendNodeModules() {
    return path.join(this.frontendTemplate, 'node_modules');
  },

  /** Lib directory (for prompts, etc.) */
  lib: path.resolve(__dirname, '..'),
};

// Legacy exports for backwards compatibility
export const PROJECT_DIR = PATHS.project;
export const FRONTEND_DIR = PATHS.frontend;
export const BACKEND_DIR = PATHS.backend;
export const MONGO_DATA_DIR = PATHS.mongoData;
export const FRONTEND_TEMPLATE_DIR = PATHS.frontendTemplate;
export const BACKEND_TEMPLATE_DIR = PATHS.backendTemplate;
export const FRONTEND_NODE_MODULES = PATHS.frontendNodeModules;


/* ─────────────────────────────────────────────────────────────────────────────
 * GOOGLE CLOUD STORAGE
 * ───────────────────────────────────────────────────────────────────────────── */

export const GCS = {
  /** GCS bucket for project files */
  bucket: process.env.GCS_BUCKET || 'greta-projects',

  /** Current project identifier */
  projectId: process.env.PROJECT_ID || 'default',
};

// Legacy exports
export const GCS_BUCKET = GCS.bucket;
export const projectId = GCS.projectId;


/* ─────────────────────────────────────────────────────────────────────────────
 * TIMING & INTERVALS
 * ───────────────────────────────────────────────────────────────────────────── */

export const TIMING = {
  /** Debounce delay for GCS sync (ms) */
  debounceDelay: 3000,

  /** MongoDB backup interval (ms) */
  mongoBackup: 5 * 60 * 1000,

  /** File sync interval - DISABLED to prevent race conditions */
  fileSync: 2 * 60 * 1000,
};

// Legacy exports
export const DEBOUNCE_DELAY = TIMING.debounceDelay;
export const MONGO_BACKUP_INTERVAL = TIMING.mongoBackup;
export const FILE_SYNC_INTERVAL = TIMING.fileSync;


/* ─────────────────────────────────────────────────────────────────────────────
 * LOGGING
 * ───────────────────────────────────────────────────────────────────────────── */

/** Maximum log entries to retain in memory */
export const MAX_LOGS = 100;


/* ─────────────────────────────────────────────────────────────────────────────
 * EXPRESS API ENDPOINTS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * API endpoints handled by Express (not proxied to Python backend)
 * These are file operations, logs, chat, and other orchestrator-specific routes
 */
export const EXPRESS_API_ENDPOINTS = [
  // Core operations
  '/_greta/keepAlive',

  // File operations
  '/_greta/write-file', '/_greta/read-file', '/_greta/delete-file', '/_greta/rename-file',
  '/_greta/list-files', '/_greta/bulk-write-files', '/_greta/bulk-read-files',
  '/_greta/search-replace', '/_greta/insert-text', '/_greta/grep', '/_greta/glob-files',

  // Package management
  '/_greta/add-dependency', '/_greta/remove-dependency',
  '/_greta/add-python-dependency', '/_greta/remove-python-dependency',

  // Logs & debugging
  '/_greta/console-logs', '/_greta/clear-logs', '/_greta/backend-logs', '/_greta/vite-errors', '/_greta/browser-error',
  '/_greta/typescript-check',

  // Storage & Versioning
  '/_greta/sync-to-gcs',
  '/_greta/list-versions', '/_greta/restore-version',
  '/_greta/file-history', '/_greta/restore-file-version',

  // Bash execution
  '/_greta/execute-bash',

  // Build
  '/_greta/build',

  // Environment & Server Management
  '/_greta/update-env-and-restart',

  // Chat & AI
  '/chat', '/chat/history', '/conversations',

  // Screenshot
  '/_greta/screenshot', '/_greta/screenshot/health',

  // Agents (browser automation)
  '/_greta/agents/frontend-test', '/_greta/agents/backend-test', '/_greta/agents/browser-automate', '/_greta/agents/health',

  // Health check
  '/_greta/health-check',
];

