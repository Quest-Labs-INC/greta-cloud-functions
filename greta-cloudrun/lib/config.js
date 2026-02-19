/**
 * Configuration - All constants and environment variables
 */
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Server Ports
export const PORT = process.env.PORT || 8080;
export const VITE_PORT = process.env.VITE_PORT || 5173;
export const BACKEND_PORT = process.env.BACKEND_PORT || 8000;
export const MONGO_PORT = process.env.MONGO_PORT || 27017;

// Project Paths
export const PROJECT_DIR = '/app/project';
export const FRONTEND_DIR = '/app/project/frontend';
export const BACKEND_DIR = '/app/project/backend';
export const MONGO_DATA_DIR = '/data/db';

// Template Paths
export const FRONTEND_TEMPLATE_DIR = process.env.FRONTEND_TEMPLATE_DIR || '/frontend-template';
export const BACKEND_TEMPLATE_DIR = process.env.BACKEND_TEMPLATE_DIR || '/backend-template';
export const FRONTEND_NODE_MODULES = path.join(FRONTEND_TEMPLATE_DIR, 'node_modules');

// GCS Config
export const GCS_BUCKET = process.env.GCS_BUCKET || 'greta-projects';
export const projectId = process.env.PROJECT_ID || 'default';

// Logging Config
export const MAX_LOGS = 100;

// Backup Intervals (in milliseconds)
export const FILE_SYNC_INTERVAL = 2 * 60 * 1000;  // 2 minutes
export const MONGO_BACKUP_INTERVAL = 5 * 60 * 1000;  // 5 minutes
export const DEBOUNCE_DELAY = 3000;  // 3 seconds

// Express API endpoints (not proxied to Python backend)
export const EXPRESS_API_ENDPOINTS = [
  '/keepAlive', '/write-file', '/read-file', '/delete-file',
  '/list-files', '/add-dependency', '/add-python-dependency', '/console-logs', '/clear-logs', '/sync-to-gcs',
  '/bulk-write-files', '/bulk-read-files', '/search-replace', '/insert-text',
  '/grep', '/glob-files', '/execute-bash',
  '/chat', '/chat/history', '/conversations',
  '/backend-logs', '/vite-errors'
];

