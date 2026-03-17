#!/bin/bash
# Deploy Greta Cloud Run base image to GCP

set -e

# Configuration
PROJECT_ID="${GCP_PROJECT_ID:-your-gcp-project}"
REGION="${GCP_REGION:-us-central1}"
REPOSITORY="greta-containers"
IMAGE_NAME="greta-backend"

echo "🚀 Deploying Greta Cloud Run container..."
echo "Project: $PROJECT_ID"
echo "Region: $REGION"

# 1. Create Artifact Registry repository (if not exists)
echo "📦 Ensuring Artifact Registry repository exists..."
gcloud artifacts repositories describe $REPOSITORY \
  --location=$REGION \
  --project=$PROJECT_ID 2>/dev/null || \
gcloud artifacts repositories create $REPOSITORY \
  --repository-format=docker \
  --location=$REGION \
  --project=$PROJECT_ID \
  --description="Greta preview containers"

# 2. Build and push image using Cloud Build
echo "🔨 Building and pushing Docker image..."
gcloud builds submit \
  --config=cloudbuild.yaml \
  --project=$PROJECT_ID \
  --substitutions=_REGION=$REGION,_REPOSITORY=$REPOSITORY

echo "✅ Base image deployed successfully!"
echo ""
echo "Image: ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:latest"
echo ""
echo "To create a new preview container for a project, use:"
echo "  gcloud run deploy preview-{PROJECT_UUID} \\"
echo "    --image=${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:latest \\"
echo "    --region=$REGION \\"
echo "    --allow-unauthenticated \\"
echo "    --set-env-vars=PROJECT_ID={PROJECT_UUID},GCS_BUCKET=greta-projects,MONGO_URL=mongodb+srv://tmxsmoke:aminocentesis@cluster0.zmgremb.mongodb.net/chat-testing,DB_NAME=chat-testing"

