#!/usr/bin/env bash
#
# Test the deployed static-build-lambda end-to-end.
# Zips a frontend project's source -> POSTs to the Lambda Function URL ->
# unpacks the dist that comes back.
#
# Usage:
#   bash test-lambda.sh <FUNCTION_URL> [PROJECT_DIR]
#
# Examples:
#   bash test-lambda.sh https://abc123.lambda-url.us-east-2.on.aws/
#   bash test-lambda.sh https://abc123.lambda-url.us-east-2.on.aws/ /path/to/frontend
#
set -euo pipefail

URL="${1:-${LAMBDA_URL:-}}"
PROJECT_DIR="${2:-/Users/pankaj/greta/greta-cloud-functions/greta-cloudrun/main-template/frontend}"

if [ -z "$URL" ]; then
  echo "❌ Pass the Function URL: bash test-lambda.sh <FUNCTION_URL> [PROJECT_DIR]"
  exit 1
fi
if [ ! -d "$PROJECT_DIR" ]; then
  echo "❌ Project dir not found: $PROJECT_DIR"
  exit 1
fi

WORK="$(mktemp -d)"
SRC_ZIP="$WORK/src.zip"
RESP="$WORK/resp.bin"
HEADERS="$WORK/headers.txt"
OUT_DIR="/Users/pankaj/greta/greta-cloud-functions/static-build-lambda/test-output"
trap 'rm -rf "$WORK"' EXIT

echo "→ Project : $PROJECT_DIR"
echo "→ Lambda  : $URL"

# 1. Zip the source (exclude node_modules / git / prior builds).
echo "→ Zipping source…"
( cd "$PROJECT_DIR" && zip -r -q "$SRC_ZIP" . -x 'node_modules/*' '.git/*' 'dist/*' 'dist-static/*' )
SRC_MB="$(echo "scale=2; $(stat -f%z "$SRC_ZIP") / 1048576" | bc)"
echo "  source zip: ${SRC_MB}MB"

# 2. POST to the Lambda.
echo "→ Building on Lambda (this can take ~30-60s on a cold start)…"
START=$(date +%s)
CODE="$(curl -sS -X POST "$URL" \
  -H 'Content-Type: application/zip' \
  -H "x-build-id: test-$(date +%s)" \
  --data-binary @"$SRC_ZIP" \
  -D "$HEADERS" \
  -o "$RESP" \
  -w '%{http_code}')"
ELAPSED=$(( $(date +%s) - START ))
echo "  HTTP $CODE in ${ELAPSED}s"

# 3. Handle the response.
if [ "$CODE" != "200" ]; then
  echo "❌ FAIL — Lambda returned $CODE:"
  cat "$RESP"; echo
  exit 1
fi

CTYPE="$(grep -i '^content-type:' "$HEADERS" | tail -1 | tr -d '\r')"
if ! echo "$CTYPE" | grep -qi 'zip'; then
  echo "⚠️  Expected a zip but got: $CTYPE"
  echo "Body:"; cat "$RESP"; echo
  exit 1
fi

# 4. Unpack the returned dist and show it.
rm -rf "$OUT_DIR" && mkdir -p "$OUT_DIR"
unzip -q "$RESP" -d "$OUT_DIR"
COUNT="$(find "$OUT_DIR" -type f | wc -l | tr -d ' ')"
echo ""
echo "✅ PASS — got $COUNT dist files back:"
( cd "$OUT_DIR" && find . -type f | sed 's|^\./|  |' | head -40 )
[ "$COUNT" -gt 40 ] && echo "  … ($COUNT total)"
echo ""
echo "Dist saved at: $OUT_DIR"
