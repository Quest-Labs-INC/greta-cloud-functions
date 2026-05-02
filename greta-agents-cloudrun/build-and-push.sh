#!/bin/bash

# Build and Push Script for Greta Agent Container
# This script builds the Docker image and pushes it to Google Container Registry

set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Greta Agent Container - Build & Push ===${NC}\n"

# Step 1: Get project configuration
echo -e "${YELLOW}Step 1: Reading project configuration...${NC}"

GCP_PROJECT=${GOOGLE_CLOUD_PROJECT:-"your-gcp-project-id"}
GCP_REGION=${GOOGLE_CLOUD_REGION:-"us-central1"}
IMAGE_NAME="greta-agent"
IMAGE_TAG=${IMAGE_TAG:-"latest"}
IMAGE_PATH="gcr.io/${GCP_PROJECT}/${IMAGE_NAME}:${IMAGE_TAG}"

echo "  GCP Project: ${GCP_PROJECT}"
echo "  GCP Region: ${GCP_REGION}"
echo "  Image: ${IMAGE_PATH}"
echo ""

# Step 2: Verify GCP authentication
echo -e "${YELLOW}Step 2: Verifying GCP authentication...${NC}"
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q "@"; then
    echo -e "${RED}ERROR: Not authenticated with GCP${NC}"
    echo "Please run: gcloud auth login"
    exit 1
fi
echo -e "${GREEN}  ✓ Authenticated${NC}\n"

# Step 3: Configure Docker for GCR
echo -e "${YELLOW}Step 3: Configuring Docker for Google Container Registry...${NC}"
gcloud auth configure-docker --quiet
echo -e "${GREEN}  ✓ Docker configured${NC}\n"

# Step 4: Build Docker image
echo -e "${YELLOW}Step 4: Building Docker image...${NC}"
echo "  This may take 2-3 minutes..."
docker build -t ${IMAGE_PATH} .

if [ $? -eq 0 ]; then
    echo -e "${GREEN}  ✓ Image built successfully${NC}\n"
else
    echo -e "${RED}  ✗ Build failed${NC}"
    exit 1
fi

# Step 5: Test image locally
echo -e "${YELLOW}Step 5: Quick test - running container locally...${NC}"
echo "  Starting container on port 8081..."

docker stop greta-agent-test 2>/dev/null || true
docker rm greta-agent-test 2>/dev/null || true

docker run -d \
  --name greta-agent-test \
  -p 8081:8080 \
  -e AGENT_ID=test-agent \
  -e USER_ID=test-user \
  ${IMAGE_PATH}

sleep 3

echo "  Testing health endpoint..."
HEALTH_RESPONSE=$(curl -s http://localhost:8081/health || echo "FAILED")

if echo "$HEALTH_RESPONSE" | grep -q "ok"; then
    echo -e "${GREEN}  ✓ Container is healthy!${NC}"
    echo "  Response: $HEALTH_RESPONSE"
else
    echo -e "${RED}  ✗ Health check failed${NC}"
    echo "  Response: $HEALTH_RESPONSE"
    docker logs greta-agent-test
    docker stop greta-agent-test
    exit 1
fi

docker stop greta-agent-test
docker rm greta-agent-test
echo ""

# Step 6: Push to Google Container Registry
echo -e "${YELLOW}Step 6: Pushing image to Google Container Registry...${NC}"
echo "  This may take 1-2 minutes..."
docker push ${IMAGE_PATH}

if [ $? -eq 0 ]; then
    echo -e "${GREEN}  ✓ Image pushed successfully${NC}\n"
else
    echo -e "${RED}  ✗ Push failed${NC}"
    exit 1
fi

# Step 7: Success summary
echo -e "${GREEN}=== Build & Push Complete! ===${NC}\n"
echo "Image details:"
echo "  Registry: Google Container Registry (GCR)"
echo "  Path: ${IMAGE_PATH}"
echo "  Size: $(docker images ${IMAGE_PATH} --format "{{.Size}}")"
echo ""
echo "Next steps:"
echo "  1. Deploy to Cloud Run using this image"
echo "  2. Image URL: ${IMAGE_PATH}"
echo ""
echo -e "${BLUE}You can now use this image in gretaAgentContainerService.js${NC}"
