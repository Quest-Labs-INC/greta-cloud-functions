/**
 * Constants and configuration for Greta Agentic
 */

// GCP Config
const GCP_PROJECT = 'deft-epigram-464605-d3';
const GCP_REGION = 'us-central1';
const GCS_BUCKET = 'greta-projects-prod';

// Latest image version - UPDATE THIS when pushing new features!
const LATEST_IMAGE_VERSION = 'v44';
const CONTAINER_IMAGE = `${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/greta-containers/greta-preview:${LATEST_IMAGE_VERSION}`;

// MongoDB Config
const DB_NAME = 'chat-testing';

// Tools that modify files and might cause Vite errors
const FILE_MODIFYING_TOOLS = ['mcp_create_file', 'mcp_bulk_file_writer', 'mcp_search_replace'];

// Default chat settings
const DEFAULT_MODEL = 'google/gemini-2.5-pro-preview-05-06';
const DEFAULT_MAX_TOKENS = 32000;
const DEFAULT_TEMPERATURE = 0.8;
const MAX_AGENTIC_LOOPS = 20;

export {
  GCP_PROJECT,
  GCP_REGION,
  GCS_BUCKET,
  LATEST_IMAGE_VERSION,
  CONTAINER_IMAGE,
  DB_NAME,
  FILE_MODIFYING_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  MAX_AGENTIC_LOOPS
};

