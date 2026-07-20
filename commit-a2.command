#!/bin/bash
# Double-click (or run in Terminal) to commit + push A2 gate extractions + A3
# provenance/drift tooling. Idempotent: re-adds the tracked files; already-committed
# files won't re-commit. The sandbox can't write .git; your Mac can.
set -e
cd "$(dirname "$0")"
rm -f .git/index.lock

# A2: gate modules + their unit tests.  A3: provenance manifest, drift gate,
# bundler, their meta-suites, package.json wiring.  Plus: n8n baseline snapshot
# (c91917bb), RCF_AUDIT_EMIT_v3 delta (fe73a421), and the commit scripts themselves.
git add lib/gates/ \
        tests/test-*-gate.js tests/test-gate-*.js \
        .ci/ \
        n8n-workflows/ \
        commit-*.command \
        package.json

# Re-run the full gate (same as CI) before committing.
npm run ci

git commit -m "test(a2,a3): extract QTP gate logic + provenance drift gate + vendored-inline bundler

Workstream A2+A3 (Conclave-ratified build plan). Pure, dependency-free gate
modules extracted verbatim from the live SM baseline (versionId c91917bb), each
with a table-driven unit test wired into the CI commit gate (tests/run-all.js):

A2 — gate extractions:
- lib/gates/vc_score.js            — VC Score Parser calibrated-v2 (1.18/0.55,
  threshold>=7); boundary raw 5.4 fail / 5.5 pass, clamp, KILL/STAND-ASIDE.
- lib/gates/mtf.js                 — MTF confluence + F1-B shadow; encodes G22
  (no mtfScore>=65 && aiMtfScore>=65 double-check), 39/40/41 floor boundary,
  cohort on/off byte-equivalence, det>=65 / ai>=60 leg attribution.
- lib/gates/backtest.js            — BACKTEST_ENFORCEMENT + F2 PF shadow; tier
  select (strict/relaxed/highVol), FAIL-CLOSED UNKNOWN, cohort byte-equivalence.
- lib/gates/composite_opposition.js — entry-quality second-opinion veto (>=2 of
  7 opposing sources; paper+entry guard; aiMissing dead; FIX1 shadow isolated).
- lib/gates/ai_conflict.js         — entry-quality AI-conflict guard: hard never
  waived, soft waived only under full paper soft-allow (bias>=60), separate
  trend-allow; bias bars 55/60, secondary-confirmation strict + paper-relaxed.

A3 — provenance drift gate + bundler (live-node stamp NOT published; PO-gated):
- .ci/gate-provenance.json         — each module pins the sha256_live of the
  baseline node it was pulled from.
- .ci/check-gate-provenance.js     — npm run check:gates; recomputes source
  hashes, FAILS on drift / untracked module / missing test (fail-closed).
- .ci/bundle-gates.js              — assembles lib/gates into one namespaced
  QTPGates IIFE (vendored-inline; n8n Cloud restricts require) + stamp/extract.
- tests/test-gate-provenance.js    — meta-suite: proves the drift gate goes RED
  on a tampered source, untracked module, missing test, manifest mismatch.
- tests/test-gate-bundle.js        — proves the bundle is valid loadable JS,
  every gate callable, byte-deterministic, stamp round-trips, tamper caught.

Making the live SM call QTPGates is a publish — PO auth + E2E required (A3.5+)."

git push origin main
echo ""
echo "Pushed. A2 gate modules + A3 provenance drift gate live in the CI commit gate."
