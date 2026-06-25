# static-build-lambda

Off-pod frontend build for greta_agentic containers. Pure compute, no cloud
credentials: a **zip of the project source** comes in, a **zip of the built
`dist`** goes out. The greta-cloudrun container (`POST /_greta/build-static`)
calls this, then writes the returned dist to GCS itself.

This exists because running `bun build` inside the 1-CPU user container throttled
the live preview. Moving the build here keeps the container responsive.

## Contract

- **Request**: `POST`, body = zip of frontend source (no `node_modules`).
  Optional `x-build-id` header (logging only).
- **Response**: `200`, `Content-Type: application/zip`, body = zip whose root is
  the dist contents (`index.html`, `assets/`, …). Non-200 = build failed (JSON
  `{ error }`).

Built as a container-image Lambda so it can run `bun`. node_modules and the bun
cache live in `/tmp` (the only writable path at runtime).

Bun itself is installed under `/opt/bun`, not `/root`: Lambda runs container
images as an unprivileged user and cannot traverse `/root`.

## Deploy

```bash
# vars
ACCOUNT=<aws-account-id>
REGION=us-east-2
REPO=static-build-lambda
FN=static-build-lambda
ECR=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com

# 1. build + push image
aws ecr create-repository --repository-name $REPO --region $REGION 2>/dev/null || true
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ECR
docker build --platform linux/amd64 -t $REPO .
docker tag $REPO:latest $ECR/$REPO:latest
docker push $ECR/$REPO:latest

# 2. create the function (first time)
aws lambda create-function --function-name $FN --region $REGION \
  --package-type Image \
  --code ImageUri=$ECR/$REPO:latest \
  --role arn:aws:iam::$ACCOUNT:role/<lambda-exec-role> \
  --timeout 180 --memory-size 3008 \
  --ephemeral-storage Size=4096

# 2b. update on subsequent deploys
aws lambda update-function-code --function-name $FN --region $REGION \
  --image-uri $ECR/$REPO:latest

# 3. public-ish HTTP endpoint (the container POSTs here)
aws lambda create-function-url-config --function-name $FN --region $REGION \
  --auth-type NONE
```

Take the returned **FunctionUrl** and set it as `STATIC_BUILD_LAMBDA_URL` on the
greta-cloudrun container (in `gkeContainerService.js` env).

## Sizing notes

- **Memory 3008MB+** — Lambda CPU scales with memory; a vite build wants the
  cores. Bump higher if builds are slow.
- **Ephemeral storage 4096MB** — node_modules (200–400MB) + dist live in `/tmp`.
- **Timeout 180s** — generous; template builds finish in seconds once deps are
  cached.
- **6MB Function URL payload cap** applies to request+response. Fine for
  template-sized projects (~0.1MB source, low-MB dist). For unusually
  asset-heavy projects, switch the container side to a presigned upload instead
  of returning the dist inline.

## Optimization (later)

Cold builds re-run `bun install`. To cut that, warm the bun cache at image-build
time with the template's `package.json` + `bun.lock` (mirror the greta-cloudrun
Dockerfile's cache-baking), so runtime installs are mostly offline.
