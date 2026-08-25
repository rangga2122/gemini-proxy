#!/bin/bash
# gen-token-capture.sh — Capture Gemini token untuk gen.azkazamdigital.com
# Runs Camoufox headless, captures token, sends to gen proxy (localhost:3100)
# NO Supabase — langsung ke local proxy pool
# stdout = report, empty stdout = silent

set -euo pipefail

CAPTURE_SCRIPT="/home/ubuntu/work/gemini-proxy/scripts/gen-token-capture.cjs"
CAPTURE_TIMEOUT=120

export NODE_PATH="/home/ubuntu/.9router/automation-runtime/node_modules:${NODE_PATH:-}"
export MOZ_DISABLE_CONTENT_SANDBOX=1

# Load .env dari gemini-proxy untuk dapat EXTENSION_KEY
ENV_FILE="/home/ubuntu/work/gemini-proxy/.env"
if [ -f "$ENV_FILE" ]; then
  source <(grep -E '^(GEN_PROXY_URL|GEN_EXTENSION_KEY|ACCOUNT_LABEL|EXTENSION_KEY|API_KEY)' "$ENV_FILE" 2>/dev/null | sed 's/^/export /')
fi

# Defaults
export GEN_PROXY_URL="${GEN_PROXY_URL:-http://localhost:3100}"
export ACCOUNT_LABEL="${ACCOUNT_LABEL:-harmitafbads}"
# EXTENSION_KEY fallback ke API_KEY
export GEN_EXTENSION_KEY="${GEN_EXTENSION_KEY:-${EXTENSION_KEY:-${API_KEY:-}}}"

echo "Running gen token capture..." >&2
START_TIME=$(date +%s)

OUTPUT=$(timeout "$CAPTURE_TIMEOUT" node "$CAPTURE_SCRIPT" 2>&1) || EXIT_CODE=$?

ELAPSED=$(($(date +%s) - START_TIME))

if [ ${EXIT_CODE:-0} -eq 137 ]; then
    echo "❌ TIMEOUT after ${CAPTURE_TIMEOUT}s" >&2
    exit 1
elif [ ${EXIT_CODE:-0} -ne 0 ]; then
    ERROR_LINE=$(echo "$OUTPUT" | tail -5 | head -3)
    echo "❌ Capture FAILED (exit $EXIT_CODE) | elapsed: ${ELAPSED}s" >&2
    echo "Error: $ERROR_LINE" >&2
    exit 1
fi

# Parse result
if echo "$OUTPUT" | grep -qi "DONE\|success\|tokensReady.*true"; then
    POOL_INFO=$(echo "$OUTPUT" | grep -oP 'pool:\s+\K\d+/\d+' | head -1 || true)
    COOKIE_COUNT=$(echo "$OUTPUT" | grep -oP 'cookies:\s+\K\d+' | head -1 || true)

    echo "✅ Gen token captured | ${POOL_INFO:-pool ok} | cookies: ${COOKIE_COUNT:-?} | elapsed: ${ELAPSED}s | $(date '+%H:%M WITA')"
else
    echo "✅ Gen token capture completed | elapsed: ${ELAPSED}s | $(date '+%H:%M WITA')"
fi

exit 0
