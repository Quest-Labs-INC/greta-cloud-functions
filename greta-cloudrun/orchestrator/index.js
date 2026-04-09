/**
 * Greta Container Orchestrator API
 * 
 * This service manages Cloud Run containers for each project.
 * Your backend calls this to:
 * - Create a container when user opens preview
 * - Get the container URL for a project
 * - Write files to a container (proxied)
 */

import express from 'express';
import cors from 'cors';
import { ServicesClient } from '@google-cloud/run';
import { Storage } from '@google-cloud/storage';

const app = express();
const PORT = process.env.PORT || 8080;

// Configuration
const PROJECT_ID = process.env.GCP_PROJECT_ID;
const REGION = process.env.GCP_REGION || 'us-central1';
const REPOSITORY = process.env.GCP_REPOSITORY || 'greta-containers';
const IMAGE_NAME = 'greta-preview';
const GCS_BUCKET = process.env.GCS_BUCKET || 'greta-projects';

// Clients
const runClient = new ServicesClient();
const storage = new Storage();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============================================
// Health Check
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'greta-orchestrator' });
});

// ============================================
// Get or Create Container for Project
// ============================================
app.post('/api/container/start', async (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId required' });
    }
    
    const result = await getOrCreateContainer(projectId);
    res.json(result);
  } catch (error) {
    console.error('Start container error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Get Container URL
// ============================================
app.get('/api/container/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const url = await getContainerUrl(projectId);
    
    if (!url) {
      return res.status(404).json({ error: 'Container not found' });
    }
    
    res.json({ projectId, url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Write File to Container (proxy for backend)
// ============================================
app.post('/api/container/:projectId/write-file', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { filePath, content } = req.body;
    
    // Get container URL
    const containerUrl = await getContainerUrl(projectId);
    if (!containerUrl) {
      return res.status(404).json({ error: 'Container not running' });
    }
    
    // Forward to container
    const response = await fetch(`${containerUrl}/_greta/write-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, content })
    });
    
    const result = await response.json();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Upload Initial Files to GCS (for new project)
// ============================================
app.post('/api/project/:projectId/upload-files', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { files } = req.body; // Array of { path, content }
    
    const bucket = storage.bucket(GCS_BUCKET);
    const prefix = `projects/${projectId}/files/`;
    
    // Upload all files
    await Promise.all(files.map(async (file) => {
      const gcsFile = bucket.file(`${prefix}${file.path}`);
      await gcsFile.save(file.content, {
        contentType: getContentType(file.path)
      });
    }));
    
    res.json({ success: true, filesUploaded: files.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Helper Functions
// ============================================
async function getOrCreateContainer(projectId) {
  const serviceName = `greta-preview-${projectId.substring(0, 20)}`; // Cloud Run name limit
  const parent = `projects/${PROJECT_ID}/locations/${REGION}`;
  
  try {
    const [service] = await runClient.getService({
      name: `${parent}/services/${serviceName}`
    });
    return { url: service.uri, status: 'existing', serviceName };
  } catch (error) {
    if (error.code === 5) { // NOT_FOUND
      return await createContainer(projectId, serviceName);
    }
    throw error;
  }
}

async function createContainer(projectId, serviceName) {
  const parent = `projects/${PROJECT_ID}/locations/${REGION}`;
  const imagePath = `${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:latest`;

  console.log(`🚀 Creating container: ${serviceName}`);

  const [operation] = await runClient.createService({
    parent,
    serviceId: serviceName,
    service: {
      template: {
        containers: [{
          image: imagePath,
          ports: [{ containerPort: 8080 }],
          env: [
            { name: 'PROJECT_ID', value: projectId },
            { name: 'GCS_BUCKET', value: GCS_BUCKET }
          ],
          resources: { limits: { cpu: '1', memory: '1Gi' } }
        }],
        scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
        timeout: '3600s',
        sessionAffinity: true
      },
      ingress: 'INGRESS_TRAFFIC_ALL'
    }
  });

  const [service] = await operation.promise();
  console.log(`✅ Container ready: ${service.uri}`);
  return { url: service.uri, status: 'created', serviceName };
}

async function getContainerUrl(projectId) {
  const serviceName = `greta-preview-${projectId.substring(0, 20)}`;
  const name = `projects/${PROJECT_ID}/locations/${REGION}/services/${serviceName}`;
  try {
    const [service] = await runClient.getService({ name });
    return service.uri;
  } catch { return null; }
}

function getContentType(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  const types = { js: 'application/javascript', jsx: 'application/javascript', json: 'application/json', html: 'text/html', css: 'text/css' };
  return types[ext] || 'text/plain';
}

app.listen(PORT, () => console.log(`🎯 Orchestrator running on port ${PORT}`));

