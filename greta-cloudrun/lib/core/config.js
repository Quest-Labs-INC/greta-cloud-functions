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

export const IMAGE_VERSION = 'v51';


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
  '/keepAlive',

  // File operations
  '/write-file', '/read-file', '/delete-file', '/rename-file',
  '/list-files', '/bulk-write-files', '/bulk-read-files',
  '/search-replace', '/insert-text', '/grep', '/glob-files',

  // Package management
  '/add-dependency', '/remove-dependency',
  '/add-python-dependency', '/remove-python-dependency',

  // Logs & debugging
  '/console-logs', '/clear-logs', '/backend-logs', '/vite-errors', '/browser-error',
  '/typescript-check',

  // Storage & Versioning
  '/sync-to-gcs',
  '/list-versions', '/restore-version',
  '/file-history', '/restore-file-version',

  // Bash execution
  '/execute-bash',

  // Build
  '/build',

  // Environment & Server Management
  '/update-env-and-restart',

  // Chat & AI
  '/chat', '/chat/history', '/conversations',

  // Screenshot
  '/screenshot', '/screenshot/health',

  // Agents (browser automation)
  '/agents/frontend-test', '/agents/backend-test', '/agents/browser-automate', '/agents/health',
];

