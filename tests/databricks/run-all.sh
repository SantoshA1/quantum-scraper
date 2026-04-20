#!/usr/bin/env bash
# Run the full databricks-logging-migration test suite.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

status=0

echo "=============================="
echo " Node: databricks logging tests"
echo "=============================="
for f in \
  "$HERE/test-config.js" \
  "$HERE/test-sql-builders.js" \
  "$HERE/test-retry.js" \
  "$HERE/test-telegram-alert.js" \
  "$HERE/test-normalize-payload.js" \
  "$HERE/test-logger.js"
do
  echo ""
  echo "--- $(basename "$f") ---"
  node "$f" || status=$?
done

echo ""
echo "=============================="
echo " Python: migration tests"
echo "=============================="
( cd "$REPO" && python3 -m unittest tests/databricks/test_sheets_migration.py ) || status=$?

exit "$status"
