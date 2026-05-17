# QTP GitHub Sync Package

Created: 2026-05-17 17:51 EDT

This package captures the QTP server-side parity files and the live n8n workflow exports that were deployed directly through n8n. It is intended for GitHub version control, review, and rollback traceability.

## Current production mode

- Alpaca remains paper-only.
- Live brokerage mode is not enabled.
- Broad Scanner is production paper-gated.
- Main Trading safety chain remains intact.
- The isolated `TEST_FIRST_CANDIDATE — SHADOW_ONLY_NO_ROUTING` node remains isolated.

## Files to commit

```text
qtp_server_side/
qtp_server_side_scanner_v55.py
pine-source/
n8n_workflows/current/
n8n_workflows/backups/
docs/
README_GITHUB_SYNC.md
CHANGELOG_QTP_20260517.md
ROLLBACK_QTP_20260517.md
```

## Suggested repository location

Use the existing QTP repository if one exists. If not, create a new private repository, for example:

```text
SantoshA1/qtp-server-side
```

## Suggested commit message

```text
feat(qtp): sync server-side parity and paper-gated n8n production exports

- Add QTP server-side parity package files
- Add Broad Scanner server-side payload metadata and chart URL readiness
- Add Main Trading Alpaca smoke-test hard skip defense
- Add exported n8n workflow JSONs for Broad Scanner, Main Trading, and Supabase Health Monitor
- Add rollback workflow backups and deployment notes
- Keep Alpaca paper-only and live brokerage disabled
```

## Manual Git commands

From inside the repository root:

```bash
mkdir -p qtp_server_side n8n_workflows/current n8n_workflows/backups pine-source docs
cp -R /path/to/qtp_github_sync_20260517_1751/qtp_server_side/* qtp_server_side/
cp /path/to/qtp_github_sync_20260517_1751/qtp_server_side_scanner_v55.py .
cp -R /path/to/qtp_github_sync_20260517_1751/n8n_workflows .
cp -R /path/to/qtp_github_sync_20260517_1751/pine-source .
cp -R /path/to/qtp_github_sync_20260517_1751/docs .
cp /path/to/qtp_github_sync_20260517_1751/README_GITHUB_SYNC.md .
cp /path/to/qtp_github_sync_20260517_1751/CHANGELOG_QTP_20260517.md .
cp /path/to/qtp_github_sync_20260517_1751/ROLLBACK_QTP_20260517.md .

git add .
git commit -m "feat(qtp): sync server-side parity and paper-gated n8n production exports"
git push
```

## Validation before merge

Run:

```bash
PYTHONPATH=. python - <<'PY'
from qtp_server_side.super_score_pro_v25 import compute as ssp
from qtp_server_side.ensemble_engine_v1 import compute as ens
from qtp_server_side.webhook_bridge_v8 import compute as wh
from qtp_server_side.quantum_scalp_strategy_v5 import compute as scalp
print("QTP_SERVER_SIDE_IMPORT_OK")
PY
```

Expected:

```text
QTP_SERVER_SIDE_IMPORT_OK
```

