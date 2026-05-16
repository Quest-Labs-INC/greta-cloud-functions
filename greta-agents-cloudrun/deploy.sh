#!/bin/bash
set -e

PROJECT_ID="${GCP_PROJECT_ID:-your-gcp-project}"
REGION="${GCP_REGION:-us-east1}"
REPOSITORY="greta-agents"
IMAGE_NAME="greta-agent"

echo "🚀 Deploying Greta Agent Container..."
echo "Project: $PROJECT_ID"
echo "Region: $REGION"

echo "📦 Ensuring Artifact Registry repository exists..."
gcloud artifacts repositories describe $REPOSITORY \
  --location=$REGION \
  --project=$PROJECT_ID 2>/dev/null || \
gcloud artifacts repositories create $REPOSITORY \
  --repository-format=docker \
  --location=$REGION \
  --project=$PROJECT_ID \
  --description="Greta AI Agent containers"

echo "🔨 Building and pushing Docker image..."
gcloud builds submit \
  --config=cloudbuild.yaml \
  --project=$PROJECT_ID \
  --substitutions=_REGION=$REGION,_REPOSITORY=$REPOSITORY

echo "✅ Agent container image deployed successfully!"
echo ""
echo "Image: ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:latest"
