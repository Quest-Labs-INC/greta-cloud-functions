#!/usr/bin/env bash
#
# One-shot deploy for static-build-lambda.
# The Docker image is already built locally as `static-build-lambda:latest`.
# This pushes it to ECR, creates/updates the Lambda, and prints the URL.
#
# Usage:
#   export AWS_ACCESS_KEY_ID=<your-admin-key>
#   export AWS_SECRET_ACCESS_KEY=<your-admin-secret>
#   export AWS_REGION=us-east-2
#   bash deploy.sh
#
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
REPO="static-build-lambda"
FN="static-build-lambda"
ROLE_ARN="arn:aws:iam::178502901453:role/AWSLambdaExecutionRole"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ECR="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
IMAGE="$ECR/$REPO:latest"
echo "→ Account $ACCOUNT, region $REGION"

echo "→ Ensuring ECR repo…"
aws ecr create-repository --repository-name "$REPO" --region "$REGION" >/dev/null 2>&1 || true

echo "→ Logging in to ECR + pushing image…"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR"
docker tag static-build-lambda:latest "$IMAGE"
docker push "$IMAGE"

if aws lambda get-function --function-name "$FN" --region "$REGION" >/dev/null 2>&1; then
  echo "→ Updating existing function…"
  aws lambda update-function-code --function-name "$FN" --image-uri "$IMAGE" --region "$REGION" >/dev/null
else
  echo "→ Creating function…"
  aws lambda create-function --function-name "$FN" --region "$REGION" \
    --package-type Image --code ImageUri="$IMAGE" \
    --role "$ROLE_ARN" --timeout 180 --memory-size 3008 \
    --ephemeral-storage Size=4096 >/dev/null
fi

echo "→ Ensuring public Function URL…"
aws lambda create-function-url-config --function-name "$FN" --region "$REGION" --auth-type NONE >/dev/null 2>&1 || true
aws lambda add-permission --function-name "$FN" --region "$REGION" \
  --statement-id FunctionURLAllowPublicAccess --action lambda:InvokeFunctionUrl \
  --principal '*' --function-url-auth-type NONE >/dev/null 2>&1 || true

URL=$(aws lambda get-function-url-config --function-name "$FN" --region "$REGION" --query FunctionUrl --output text)
echo ""
echo "✅ Deployed. Function URL:"
echo "$URL"
