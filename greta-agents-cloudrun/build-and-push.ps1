# Build and Push Script for Greta Agent Container (PowerShell)
# This script builds the Docker image and pushes it to Google Container Registry

$ErrorActionPreference = "Stop"

Write-Host "=== Greta Agent Container - Build & Push ===" -ForegroundColor Blue
Write-Host ""

# Step 1: Get project configuration
Write-Host "Step 1: Reading project configuration..." -ForegroundColor Yellow

$GCP_PROJECT = if ($env:GOOGLE_CLOUD_PROJECT) { $env:GOOGLE_CLOUD_PROJECT } else { "your-gcp-project-id" }
$GCP_REGION = if ($env:GOOGLE_CLOUD_REGION) { $env:GOOGLE_CLOUD_REGION } else { "us-central1" }
$IMAGE_NAME = "greta-agent"
$IMAGE_TAG = if ($env:IMAGE_TAG) { $env:IMAGE_TAG } else { "latest" }

$IMAGE_PATH = "gcr.io/$GCP_PROJECT/$IMAGE_NAME`:$IMAGE_TAG"

Write-Host "  GCP Project: $GCP_PROJECT"
Write-Host "  GCP Region: $GCP_REGION"
Write-Host "  Image: $IMAGE_PATH"
Write-Host ""

# Step 2: Verify GCP authentication
Write-Host "Step 2: Verifying GCP authentication..." -ForegroundColor Yellow
$authList = gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>$null
if (-not $authList) {
    Write-Host "ERROR: Not authenticated with GCP" -ForegroundColor Red
    Write-Host "Please run: gcloud auth login"
    exit 1
}
Write-Host "  ✓ Authenticated" -ForegroundColor Green
Write-Host ""

# Step 3: Configure Docker for GCR
Write-Host "Step 3: Configuring Docker for Google Container Registry..." -ForegroundColor Yellow
gcloud auth configure-docker --quiet
Write-Host "  ✓ Docker configured" -ForegroundColor Green
Write-Host ""

# Step 4: Build Docker image
Write-Host "Step 4: Building Docker image..." -ForegroundColor Yellow
Write-Host "  This may take 2-3 minutes..."
docker build -t $IMAGE_PATH .

if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ Image built successfully" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host "  ✗ Build failed" -ForegroundColor Red
    exit 1
}

# Step 5: Test image locally
Write-Host "Step 5: Quick test - running container locally..." -ForegroundColor Yellow
Write-Host "  Starting container on port 8081..."

docker stop greta-agent-test 2>$null
docker rm greta-agent-test 2>$null

docker run -d `
  --name greta-agent-test `
  -p 8081:8080 `
  -e AGENT_ID=test-agent `
  -e USER_ID=test-user `
  $IMAGE_PATH

Start-Sleep -Seconds 3

Write-Host "  Testing health endpoint..."
try {
    $response = Invoke-WebRequest -Uri "http://localhost:8081/health" -UseBasicParsing
    $responseText = $response.Content
    if ($responseText -match "ok") {
        Write-Host "  ✓ Container is healthy!" -ForegroundColor Green
        Write-Host "  Response: $responseText"
    } else {
        throw "Health check failed"
    }
} catch {
    Write-Host "  ✗ Health check failed" -ForegroundColor Red
    Write-Host "  Error: $_"
    docker logs greta-agent-test
    docker stop greta-agent-test
    exit 1
}

docker stop greta-agent-test
docker rm greta-agent-test
Write-Host ""

# Step 6: Push to Google Container Registry
Write-Host "Step 6: Pushing image to Google Container Registry..." -ForegroundColor Yellow
Write-Host "  This may take 1-2 minutes..."
docker push $IMAGE_PATH

if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ Image pushed successfully" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host "  ✗ Push failed" -ForegroundColor Red
    exit 1
}

# Step 7: Success summary
Write-Host "=== Build & Push Complete! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Image details:"
$imageSize = docker images $IMAGE_PATH --format "{{.Size}}"
Write-Host "  Registry: Google Container Registry (GCR)"
Write-Host "  Path: $IMAGE_PATH"
Write-Host "  Size: $imageSize"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Deploy to Cloud Run using this image"
Write-Host "  2. Image URL: $IMAGE_PATH"
Write-Host ""
Write-Host "You can now use this image in gretaAgentContainerService.js" -ForegroundColor Blue
