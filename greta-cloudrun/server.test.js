/**
 * Tests for Greta Cloud Run Server
 * 
 * To run tests:
 * 1. npm install --save-dev vitest supertest
 * 2. npm test (or npx vitest run)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock the external modules before importing server components
vi.mock('./lib/gcs-sync.js', () => ({
  syncFromGCS: vi.fn().mockResolvedValue(undefined),
  syncToGCS: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./lib/mongodb.js', () => ({
  startMongo: vi.fn().mockResolvedValue(undefined),
  restoreMongoFromGCS: vi.fn().mockResolvedValue(undefined),
  backupMongoToGCS: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./lib/vite.js', () => ({
  startVite: vi.fn().mockResolvedValue(undefined),
  setShuttingDown: vi.fn()
}));

vi.mock('./lib/backend.js', () => ({
  startBackend: vi.fn().mockResolvedValue(undefined),
  setBackendShuttingDown: vi.fn()
}));

vi.mock('./lib/file-api.js', () => ({
  default: express.Router()
}));

vi.mock('./lib/logs-api.js', () => ({
  default: express.Router()
}));

vi.mock('./lib/chat-api.js', () => ({
  default: express.Router()
}));

vi.mock('./lib/screenshot-api.js', () => ({
  default: express.Router()
}));

vi.mock('./lib/proxy.js', () => ({
  apiRouter: (req, res, next) => next(),
  viteRouter: (req, res) => res.status(404).send('Vite not running')
}));

vi.mock('./lib/config.js', () => ({
  PORT: 3000,
  PROJECT_DIR: '/tmp/test-project',
  FRONTEND_DIR: '/tmp/test-project/frontend',
  BACKEND_DIR: '/tmp/test-project/backend',
  FRONTEND_TEMPLATE_DIR: '/tmp/frontend-template',
  BACKEND_TEMPLATE_DIR: '/tmp/backend-template',
  FRONTEND_NODE_MODULES: '/tmp/frontend-template/node_modules',
  projectId: 'test-project-123',
  FILE_SYNC_INTERVAL: 120000,
  MONGO_BACKUP_INTERVAL: 300000,
  IMAGE_VERSION: '1.0.0-test'
}));

// Create a test app with the same routes
import cors from 'cors';

function createTestApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // Mock state
  const state = {
    viteProcess: { pid: 123 },
    backendProcess: { pid: 456 },
    mongoProcess: { pid: 789 },
    lastKeepAlive: Date.now()
  };

  // Health endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      projectId: 'test-project-123',
      imageVersion: '1.0.0-test',
      viteRunning: !!state.viteProcess,
      backendRunning: !!state.backendProcess,
      mongoRunning: !!state.mongoProcess
    });
  });

  // keepAlive endpoint
  app.post('/_greta/keepAlive', (req, res) => {
    state.lastKeepAlive = Date.now();
    res.json({
      status: 'alive',
      timestamp: state.lastKeepAlive,
      projectId: 'test-project-123',
      viteRunning: !!state.viteProcess,
      backendRunning: !!state.backendProcess
    });
  });

  return app;
}

describe('Greta Cloud Run Server', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
  });
  
  describe('GET /health', () => {
    it('should return healthy status with all process states', async () => {
      const response = await request(app).get('/health');
      
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'healthy',
        projectId: 'test-project-123',
        imageVersion: '1.0.0-test',
        viteRunning: true,
        backendRunning: true,
        mongoRunning: true
      });
    });
  });
  
  describe('POST /_greta/keepAlive', () => {
    it('should return alive status and update timestamp', async () => {
      const beforeTimestamp = Date.now();

      const response = await request(app).post('/_greta/keepAlive');
      
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('alive');
      expect(response.body.projectId).toBe('test-project-123');
      expect(response.body.viteRunning).toBe(true);
      expect(response.body.backendRunning).toBe(true);
      expect(response.body.timestamp).toBeGreaterThanOrEqual(beforeTimestamp);
    });
  });
});

