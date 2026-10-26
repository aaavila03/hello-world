#!/usr/bin/env bash
# The AI task definitions must be identical in the browser and the server function.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
if ! cmp -s "$root/cyber-risk/ai-tasks.js" "$root/supabase/functions/_shared/ai-tasks.js"; then
  echo "supabase/functions/_shared/ai-tasks.js is out of date. Run:"
  echo "  cp cyber-risk/ai-tasks.js supabase/functions/_shared/ai-tasks.js"
  exit 1
fi
echo "ai-tasks.js in sync"
