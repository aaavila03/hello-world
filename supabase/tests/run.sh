#!/usr/bin/env bash
# Runs the schema security tests against a throwaway database.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres supabase/tests/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
db="posture_test_$$"
createdb "$db"
trap 'dropdb --if-exists "$db"' EXIT
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$here/auth_stub.sql" >/dev/null
for f in "$here"/../migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$f" >/dev/null; done
out="$(psql -v ON_ERROR_STOP=1 -d "$db" -f "$here/rls_test.sql")"
echo "$out"
echo "$out" | grep -q ' 0$' || { echo "SECURITY TESTS FAILED"; exit 1; }
