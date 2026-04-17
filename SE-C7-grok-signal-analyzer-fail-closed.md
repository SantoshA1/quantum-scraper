# SE-C7 (extended): Grok Signal Analyzer fail-CLOSED fallback

**Audit IDs:** SE-C2 (missing-key guard), SE-C7 (fail-closed fallback)
**File:** n8n Code node `Grok Signal Analyzer` inside
  - `n8n-workflows/signal-state-machine-v5.16.json`
  - `n8n-workflows/signal-state-machine-v5.21-sheets-v2.json` (currently active)
**Status after this PR:** ✅ fixed, unit-tested

## Background

The April 16 emergency commit (`cb41b9b`) hardened the **VC Agent Gatekeeper** node:
- SE-C2 — reads `xai_api_key` from `staticData._credentials`, returns fail-closed KILL if missing
- SE-C7 — on Grok API failure, returns `{pass:false, vc_score:0, final_verdict:KILL}`

But the **sibling** `Grok Signal Analyzer` node on the primary signal path was left in its original, fail-OPEN state:

```js
// BEFORE — line 18
const API_KEY = ($getWorkflowStaticData("global")._credentials || {}).xai_api_key || "";
// ...no guard — if API_KEY is "", a request with `Authorization: Bearer ` is made and returns 401.

// BEFORE — line 67 (API-failure fallback)
choicesContent = JSON.stringify({
  signal_verdict: "WEAK",
  confidence: 5,
  trade_action: "HOLD",
  error: grokError || "API unavailable"
});
```

Per the audit (SE-C7 / SE-H9), `WEAK` verdicts still pass the downstream execution gate,
and a `HOLD` / `confidence:5` fallback leaks neutral-looking values into Format Telegram
and Alpaca Paper Trade branches. This preserved the exact failure mode SE-C7 described:
**on Grok unavailability, signals auto-pass without AI validation.**

## Fix

1. **SE-C2 guard (new).** If `xai_api_key` is absent, return a KILL verdict immediately
   without attempting the HTTP call. Mirrors the VC Gatekeeper pattern.
2. **SE-C7 fallback (tightened).** On API failure, emit
   `{signal_verdict:"KILL", confidence:0, trade_action:"REJECT", red_flags:["GROK_SIGNAL_ANALYZER_UNAVAILABLE"], ...}`.
3. **Defense in depth.** If Grok returns an unexpected response shape (no `choices`),
   fail closed instead of `JSON.stringify`-ing the entire response object into
   `choicesContent` (previous behavior silently leaked garbage downstream).
4. **Shared helper** `buildKillFallback(reason)` keeps all three failure shapes consistent.

The happy path is unchanged: when Grok returns a valid `choices[0].message.content`,
it is forwarded verbatim as before.

## Test plan

A new `tests/test-grok-signal-analyzer-fail-closed.js` harness extracts the node's
`jsCode` from the workflow JSON, wraps it in an async function with the n8n runtime
surface mocked (`$input`, `$getWorkflowStaticData`, `this.helpers.httpRequest`), and
asserts:

| # | Scenario | Expected |
|---|---|---|
| 1 | `xai_api_key` missing | KILL / REJECT / confidence 0; **no HTTP call** |
| 2 | `httpRequest` throws | KILL / REJECT / confidence 0; `_grok_error` set |
| 3 | Valid Grok response | Grok content passed through verbatim (PASS/BUY allowed) |
| 4 | `execution === STAND ASIDE` | Returns `[]` (no downstream fire) — unchanged behavior |
| 5 | Unexpected Grok response shape | KILL fallback (not silent pass-through) |

Each test also runs a `passesExecutionGate(verdict)` simulator that returns `true` iff
the downstream execution gate would let the signal through. Scenarios 1, 2, 5 must
all return `false` — and do.

**Baseline proof (pre-patch code):**
Running the identical harness against the committed pre-patch version fails 3 of 5
tests (SE-C2 missing-key guard, SE-C7 fail-closed fallback, unexpected response shape),
confirming the tests exercise real behavior — not tautologies.

```
Post-patch: 5 passed, 0 failed
Pre-patch:  2 passed, 3 failed
```

## Rollout

1. Merge this PR.
2. Re-import the v5.21 workflow into n8n (the active one).
3. Verify `staticData._credentials.xai_api_key` is still set in the active workflow
   (unchanged — this PR does not touch credential storage).
4. Trigger one STAND ASIDE signal → still no-op.
5. Trigger one BUY signal → Grok should respond; verify a real PASS/BUY verdict
   flows to Alpaca. If credentials are ever removed or xAI is down, the signal
   will now be blocked instead of silently auto-passing.

## Audit items this PR closes

- **SE-C7** — fallback is fail-closed across *both* AI nodes (not just VC Gatekeeper).
- **SE-C2** — Grok Signal Analyzer no longer calls xAI with an empty Bearer token.
- Partial credit toward **SE-C3 / SE-H9** (Grok response schema validation): we now
  catch the "response shape is wrong" case, but full field-level validation
  (bounded confidence, whitelisted signal values) remains a follow-up.
