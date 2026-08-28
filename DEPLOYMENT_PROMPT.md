# QTP Server-Side Parity — Production Deployment Brief

**Hand this entire document to Perplexity (or any deployment-capable agent with access to the Quantlys repo, GitHub, the n8n instance at `tradenextgen.app.n8n.cloud`, and the hosting VM/container platform). Also attach the files listed in `FILE_MANIFEST.md`.**

You are deploying a **shadow validator** — a side-channel that compares live TradingView Pine alert payloads against a Python re-implementation of the same scoring logic. **This deployment must not modify live trade routing.** All Alpaca/Telegram/Supabase production writes are out of scope and must remain untouched. The architecture is non-blocking by design.

---

## 0. Pre-flight — read before doing anything

### Current state on the user's local machine

A local-only working tree exists at `/Users/santoshadari/Documents/Claude/Projects/Quantlys Engine/`. **It has not been committed to git yet** — the user wants you to start from a clean review.

The following is validated end-to-end on local fixtures (AAPL 1D, 300 bars covering March 2025 → May 15 2026, skip_warmup=200):

| Module | Python-vs-Pine parity |
|---|---|
| `super_score_pro_v25` | **20/20 PASS** (exact) |
| `webhook_bridge_v8` | **3/3 PASS** (exact) |
| `quantum_swing_v83` | 22/24 PASS — residual 2 are documented gaps (`psar` warmup init, `weekly_dd_pct` strategy-equity not simulated) |
| `ensemble_engine_v1` | 1/5 PASS — **plumbing wired, awaiting one Pine paste + re-export from user before validation completes** |
| `quantum_scalp_strategy_v5` | SKIPPED — user has not yet imported the Pine source into their TradingView account |

### Files in scope (paths relative to the repo root)

```
qtp_server_side/
  __init__.py
  drift.py                       — drift tolerance constants
  indicators.py                  — shared indicator library (EMA, RSI, MACD, ADX, etc)
  payload.py                     — canonical payload field definitions
  super_score_pro_v25.py         — Python port of AI Super Score Pro v2.5 Universal
  ensemble_engine_v1.py          — Python port of AI Super Score Ensemble Engine v1
  webhook_bridge_v8.py           — Python port of AI Super Score Webhook Bridge v8
  quantum_scalp_strategy_v5.py   — Python port of Quantum Scalp Strategy v5
  quantum_swing_v83.py           — Python port of Quantum Swing v8.3 (NEW this session)
  run_drift_manifest.py          — offline drift validation runner
  split_tv_export.py             — TradingView CSV → reference fixtures
  diff_at_bar.py                 — per-bar diagnostic tool
  shadow_validator.py            — FastAPI HTTP service (NEW this session) ← DEPLOY TARGET
pine-source/
  manifest.json                  — module catalog with sha256 hashes
  *.pine                         — five Pine source files
pine-reference/
  ohlcv/   *.csv                 — OHLCV fixtures per module
  outputs/ *.csv                 — Pine-output fixtures per module
PINE_PATCHES.md                  — paste-ready patches per indicator
SHADOW_VALIDATOR.md              — FastAPI operations doc
EXPORT_GUIDE.md                  — manual TradingView export procedure
DRIFT_VERDICT.md                 — per-module verdict
```

### What is NOT in scope

- Modifying any existing n8n node that routes to Alpaca, Telegram, or Supabase
- Adding any production-write path from the FastAPI service
- Changing live alert routing logic
- Touching anything that could affect a currently-open live trade

### Items that the USER must do (not Perplexity — these need TradingView UI access)

These are open but **explicitly excluded from this deployment**. The shadow validator deploys and operates without them; their absence only affects parity quality for two of the five modules, not the validator's correctness.

1. **Ensemble v1 Pine paste** — DONE. User pasted the 11-line block; ensemble now scores 2/5 PASS (adx + rel_vol exact; HTF EMAs / market refs / volume_score all flow correctly). The remaining 3/5 drift on `raw_bull_score`, `raw_bear_score`, `final_score` is a **design boundary**, not a bug: those scores include a `manual_bull_score`/`manual_bear_score` term that's derived from 10 user-configured TradingView inputs (`i_execution`, `i_signal`, `i_smart_money`, `i_fvg`, `i_order_block`, etc., Pine source lines 34-43). The Python port has no way to know what the user set those inputs to in TV. **For the Slack drift channel: filter out `module=ensemble_engine_v1` notifications on `raw_bull_score`/`raw_bear_score`/`final_score` fields** — they're expected drift, not actionable. Other ensemble fields (adx, rel_vol, mtf, market, momentum, location, regime) validate normally.

2. **Quantum Scalp Strategy v5 not imported** — User has not yet imported `pine-source/quantum_scalp_strategy_v5.pine` into their TradingView account. Until done, no Scalp v5 alerts will fire from TradingView, so the validator will see zero Scalp v5 traffic. No deployment impact.

3. **PSAR + weekly_dd_pct drifts on Swing v8.3 are documented gaps**, not bugs requiring user action:
   - PSAR (7/100 bars, mean 0.10): Pine's SAR uses internal seeding logic that's not bit-replicable without instrumenting Pine. Documented in `drift.py::KNOWN_DIFFERENCES`. Effective PASS.
   - weekly_dd_pct (20/100 bars, mean 0.03): Python emits 0 because no `strategy.equity` simulator runs server-side. Explicit `SHADOW_ONLY_DAILY` design decision. Effective PASS.

### Hard constraints

- The FastAPI service **must** be deployed bound to a non-public interface (localhost, VPC-internal, or fronted by HTTP auth + IP allowlist). It accepts arbitrary OHLCV via HTTP and runs Python compute — never expose it to the open internet.
- The n8n integration **must** be a parallel branch with explicit timeout (5s recommended). On timeout or 5xx, log + continue silently. Do not gate trade routing on this branch.
- No commit to `main` without review. Use a feature branch.

---

## 1. Step-by-step deployment plan

Execute one phase at a time. **At each phase, run the verification command and confirm output before proceeding.** If a verification fails, stop and surface the failure — do not continue.

### Phase 1 — Repository commit (no production effect)

**Action:**
```bash
cd "/Users/santoshadari/Documents/Claude/Projects/Quantlys Engine"
git status
git diff --stat
git checkout -b feat/server-side-parity-shadow-validator
git add qtp_server_side/ pine-source/ pine-reference/ \
        PINE_PATCHES.md SHADOW_VALIDATOR.md EXPORT_GUIDE.md \
        DRIFT_VERDICT.md DEPLOYMENT_PROMPT.md
git commit -m "feat(qtp): server-side parity ports + FastAPI shadow validator

- super_score_pro_v25: 20/20 exact PASS on AAPL 1D
- webhook_bridge_v8: 3/3 exact PASS
- quantum_swing_v83: 22/24 PASS (psar/weekly_dd_pct are documented gaps)
- ensemble_engine_v1: plumbing wired, awaiting Pine patch paste
- diff_at_bar.py: per-bar diagnostic tool
- shadow_validator.py: FastAPI service for parallel n8n integration
- SHADOW_ONLY_DAILY mode — no live routing, no Alpaca/Telegram/Supabase writes"
git push -u origin feat/server-side-parity-shadow-validator
```

**Verification:**
```bash
git log -1 --stat | head -40
gh pr create --draft --title "Server-side parity + shadow validator" \
   --body-file DEPLOYMENT_PROMPT.md
```

A draft PR should now exist on GitHub. Confirm the file list matches the inventory above.

### Phase 2 — Local validation re-run

Before deploying anywhere, prove the local validation still passes.

**Action:**
```bash
pip install --break-system-packages -q fastapi pydantic uvicorn pandas numpy
PYTHONPATH=. python3 -m qtp_server_side.run_drift_manifest \
  --manifest pine-source/manifest.json \
  --ohlcv-dir pine-reference/ohlcv \
  --reference-dir pine-reference/outputs \
  --out qtp_server_side/drift_report.json \
  --skip-warmup 200
```

**Expected exact output:**
```
super_score_pro_v25:    20/20 PASS
webhook_bridge_v8:       3/3  PASS
quantum_swing_v83:      22/24 PASS  (psar + weekly_dd_pct drift — known gaps)
ensemble_engine_v1:      1/5  PASS  (4 fields drift — awaiting Pine patch)
quantum_scalp_strategy_v5: SKIPPED  (no fixture)
```

If any module other than `ensemble_engine_v1` regresses, **stop and investigate**. Common cause: wrong working directory or stale pine-reference fixtures.

### Phase 3 — FastAPI smoke test (still local)

**Action:**
```bash
PYTHONPATH=. uvicorn qtp_server_side.shadow_validator:app \
  --host 127.0.0.1 --port 8088 --log-level info &
SERVER_PID=$!
sleep 3
curl -s http://127.0.0.1:8088/health | python3 -m json.tool
curl -s http://127.0.0.1:8088/modules | python3 -m json.tool
```

**Verification — expected JSON shape from /health:**
```json
{
  "status": "ok",
  "modules": ["super_score_pro_v25", "ensemble_engine_v1", "webhook_bridge_v8",
              "quantum_scalp_strategy_v5", "quantum_swing_v83"],
  "log_size": 0
}
```

**Stop the local server:**
```bash
kill $SERVER_PID
```

### Phase 4 — VM/container provisioning

Provision a small instance — recommended specs:

- 1 vCPU, 1 GB RAM, 5 GB disk minimum
- Python 3.10 or newer
- Network: place on the same VPC as the n8n host, or run on the same VM as n8n (simplest)
- Inbound: port 8088 reachable from the n8n host only; **do not open to public internet**

**Provisioning commands** (adapt to your platform — Hetzner/DigitalOcean/Linode/Fly.io/Render are all fine; avoid serverless platforms because the service holds OHLCV in memory):
```bash
ssh deploy@<vm-host>
sudo apt update && sudo apt install -y python3.11 python3.11-venv python3-pip git
git clone git@github.com:<your-org>/<quantlys-repo>.git /opt/qtp
cd /opt/qtp
git checkout feat/server-side-parity-shadow-validator
python3.11 -m venv .venv
source .venv/bin/activate
pip install fastapi pydantic uvicorn pandas numpy
```

**Systemd service** (`/etc/systemd/system/qtp-shadow.service`):
```ini
[Unit]
Description=QTP Shadow Validator (FastAPI)
After=network.target

[Service]
User=deploy
WorkingDirectory=/opt/qtp
Environment=PYTHONPATH=/opt/qtp
ExecStart=/opt/qtp/.venv/bin/uvicorn qtp_server_side.shadow_validator:app \
          --host 127.0.0.1 --port 8088 --workers 2
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qtp-shadow
sudo systemctl status qtp-shadow
```

**Verification:**
```bash
curl http://127.0.0.1:8088/health
# Should return the same JSON as Phase 3
```

### Phase 5 — n8n parallel branch (most sensitive step — do carefully)

In the n8n instance at `tradenextgen.app.n8n.cloud`, find the workflow that consumes TradingView alerts. There should be a Webhook node receiving the Pine payload, then nodes that route to Alpaca / Telegram / Supabase.

**The goal: add a new parallel branch that calls the validator. The existing routing branch must remain unchanged.**

**Action steps inside n8n:**

1. **Open the workflow in edit mode but DO NOT save yet.** Take a backup first: workflow menu → Download (saves a JSON export).

2. After the TradingView Webhook node, add an **HTTP Request** node:
   - **Name**: `Shadow Validate`
   - **URL**: `http://<vm-internal-ip>:8088/shadow-validate`
   - **Method**: `POST`
   - **Body Content Type**: `JSON`
   - **JSON Body**: (use n8n expression syntax)
     ```json
     {
       "module": "{{ $json.signal_source }}",
       "ohlcv": {{ $json.ohlcv_recent_bars }},
       "cross_asset": {{ $json.cross_asset || {} }},
       "pine_payload": {{ $json }},
       "alert_bar_time": "{{ $json.timestamp }}"
     }
     ```
   - **Options → Timeout**: `5000` (5s — kill the request if the validator is slow)
   - **Options → Response → Continue On Fail**: `true` ← critical, this is what makes the branch non-blocking

3. **Connect the Shadow Validate node as a PARALLEL output** from the TradingView Webhook node — not in series with the Alpaca/Telegram/Supabase chain. In n8n the visual is: webhook node has TWO outgoing connections, one goes to the existing routing chain (untouched), one goes to Shadow Validate.

4. After Shadow Validate, add an **IF** node:
   - **Condition**: `{{ $json.overall_verdict }} === "DRIFT"`
   - On true → Slack/Discord/email notification node
   - On false → no-op (end of branch)

5. The **Slack notification** node:
   - Channel: a dedicated channel like `#qtp-shadow-drift` (do not post to high-signal channels)
   - Message: `Drift on {{ $json.module }} at {{ $json.bar_time }}: {{ $json.n_drift }}/{{ $json.bars_compared }} fields | pass_rate {{ $json.pass_rate }}`
   - Throttle: use n8n's `Wait` node OR a Redis-based dedup to limit to 1 message per ticker per 5 minutes — drift bursts can spam this otherwise.

6. **Test in n8n's "Execute Workflow" mode first** — fire a known-good Pine alert payload manually. The Shadow Validate node should return `overall_verdict: PASS`. The IF node should route to no-op. Nothing should reach the trade-routing chain because Execute mode doesn't trigger live downstream actions, but verify on screen.

7. **Save the workflow.**

**Verification on production traffic:**
- For the next 5 minutes after save, watch n8n's execution log
- Confirm every alert execution shows BOTH branches running
- Confirm trade-routing chain produces same outputs as before (compare timestamps + Alpaca order IDs to a 5-minute pre-deployment baseline)
- Confirm Shadow Validate node returns 200 OK with `overall_verdict: PASS` on the bulk of executions

If trade-routing chain breaks: **disable the Shadow Validate node immediately**, do not save further, restore the workflow JSON from the Phase 5 step 1 backup.

### Phase 6 — 24-48h shadow monitoring

Leave the system running for at least one full trading session (preferably 24-48 hours covering multiple sessions). Watch for:

- **Drift rate** — should be very low. If ensemble v1 is generating frequent drift alerts before the user has pasted its Pine patch, that's expected (1/5 PASS state).
- **Latency** — the HTTP Request node's execution time should be well under 1 second per call. If it climbs above 2s, the VM is undersized or there's a network issue.
- **OHLCV gaps** — if the alert payload's `ohlcv_recent_bars` is missing or short, the validator will return `NO_OVERLAP` or use unconverged indicators. Surface this to the user — they may need to enrich the alert payload with more bar history.
- **No false positives** — verify spot-check that `verdict: DRIFT` messages correspond to bars where Pine and Python actually computed different values; never a bar where Python's compute ran on missing inputs (in which case it's the upstream payload that needs fixing, not the Python port).

### Phase 7 — Cutover decision

After 24-48h of clean shadow validation:

- If shadow validator agrees with Pine for ≥99.9% of live alerts on the priority tickers, the parity claim is operationally validated. The Python port can be considered a faithful re-implementation.
- A separate decision — **NOT in scope for this deployment** — would be whether to actually gate live trades on `python_verdict == pine_verdict`. That's a strategy/risk-management call.

### Rollback procedures

**Quick disable (no service impact):**
- In n8n, toggle off the Shadow Validate HTTP Request node (or disable the entire shadow branch). Trade routing is unaffected.

**Full rollback:**
```bash
sudo systemctl stop qtp-shadow
sudo systemctl disable qtp-shadow
```
Then in n8n, restore the workflow JSON backup from Phase 5 step 1. Zero impact on live trades.

---

## 2. Pending user-side action (does not block deployment)

The user still needs to do **one Pine paste** for ensemble v1 to reach full parity validation:

1. In TradingView, open Pine Editor → AI Super Score Ensemble Engine v1
2. Paste the 11-line patch from `PINE_PATCHES.md` section 7 at the bottom of the script
3. Save (Cmd+S)
4. Apply only Ensemble v1 to a chart with Volume bars visible
5. Export chart data → CSV with Include hidden plots ON
6. Upload the new CSV; the user's tool (this Claude session) re-runs the splitter and drift

This is **not blocking for Phase 1-7 above** — the shadow validator will still run on Ensemble alerts, just with a lower internal pass rate until the patch lands. The drift channel will show those mismatches; the user can suppress notifications for `module=ensemble_engine_v1` until the patch is in.

---

## 3. Test cases for Perplexity to verify before declaring done

For each of these, run the test and confirm the expected output. **Do not declare deployment complete unless all pass.**

### Test 1: Drift manifest local run
```bash
cd <repo>
PYTHONPATH=. python3 -m qtp_server_side.run_drift_manifest \
  --manifest pine-source/manifest.json --ohlcv-dir pine-reference/ohlcv \
  --reference-dir pine-reference/outputs --out /tmp/drift.json --skip-warmup 200
python3 -c "import json; d=json.load(open('/tmp/drift.json')); \
  pro = next(m for m in d['modules'] if m['module']=='super_score_pro_v25'); \
  assert all(r['pass'] for r in pro['field_results'].values()), 'Pro v2.5 regressed'; \
  print('Pro v2.5 20/20 PASS confirmed')"
```

### Test 2: FastAPI loads
```bash
PYTHONPATH=. python3 -c "from qtp_server_side.shadow_validator import app; \
  assert len(app.routes) >= 7, 'Routes missing'; \
  print('FastAPI loads with', len(app.routes), 'routes')"
```

### Test 3: HTTP endpoint responds
```bash
PYTHONPATH=. uvicorn qtp_server_side.shadow_validator:app --port 18088 &
sleep 3
RESP=$(curl -s http://127.0.0.1:18088/health)
echo "$RESP" | grep -q '"status": "ok"' && echo "health OK" || (echo "health FAILED: $RESP"; exit 1)
kill %1
```

### Test 4: End-to-end shadow validation with known-good payload
Use a Pine payload captured from the live n8n logs (any recent one). Call `/shadow-validate` with it and the OHLCV window from the same period. Verify `overall_verdict: PASS` for `super_score_pro_v25` and `webhook_bridge_v8` modules.

### Test 5: n8n branch is non-blocking
Trigger a known-good alert. Confirm Alpaca order goes through (or whatever the live downstream produces) within the usual latency, regardless of validator response time. Then deliberately stop the validator service (`systemctl stop qtp-shadow`), trigger another alert, confirm Alpaca order STILL goes through (Continue On Fail must be honored).

---

## 4. If anything goes wrong

- **n8n trade-routing chain breaks after adding the shadow branch:** restore workflow from JSON backup, disable shadow branch, investigate offline. The most common cause is mis-wired connections (shadow branch accidentally placed in series instead of parallel).
- **FastAPI returns 500s:** check `journalctl -u qtp-shadow -n 100`. Common cause: missing Python dep, wrong PYTHONPATH, version mismatch on pandas.
- **All validations return DRIFT despite expected PASS:** the OHLCV window the alert is sending is wrong — wrong symbol, wrong timeframe, or too few bars (< 200, so SMA200 hasn't converged). Fix the n8n payload assembly.
- **High latency (> 2s per call):** the compute() functions iterate over the full OHLCV window each time. For production, consider caching — but only after parity is locked in. Don't optimize before validating.

---

## Mandate

This is shadow validation infrastructure for an existing live trading pipeline. It must add observability without adding risk. **If at any point during deployment you have to make a judgment call that could affect live trade routing, stop and ask the user.** The parity work itself is validated and ready; the deployment risk is entirely in how it's wired to n8n.

Tell the user when each phase completes. If you hit a verification failure, report exactly what you saw and what you tried — do not paper over it.
