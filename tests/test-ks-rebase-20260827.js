#!/usr/bin/env node
// gov 243 — cumulative kill-switch re-baseline: fixture pins (2026-08-27)
// The eval node is n8n-expression-embedded SQL (leading '=', {{ }} tokens), so this
// suite pins the patched bytes' load-bearing properties instead of executing them;
// the SEMANTIC verification runs live post-deploy (cum CTE replayed with new knobs).
// PO ruling: RECERT rows cannot trip the CUMULATIVE brake; daily leg untouched;
// fail-closed missing-baseline behavior untouched; brake re-baselined gov-241 epoch
// at -1250. Sabotage: dropping the exclusion or the fail-closed coalesce must bite.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OLD = fs.readFileSync(path.join(ROOT, 'docs/ks-rebase-20260827/ksmon-eval-deployed.sql'), 'utf8');
const NEW = fs.readFileSync(path.join(ROOT, 'docs/ks-rebase-20260827/ksmon-eval-patched.sql'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? ' — ' + x : '')); } };

ok(NEW.startsWith('=WITH cfg AS ('), 'KR-01 n8n expression prefix intact');
ok((NEW.match(/RECERT_QUARANTINE/g) || []).length === 2 && OLD.indexOf('RECERT_QUARANTINE') < 0,
  'KR-02 RECERT exclusion present in patched (predicate + comment), absent in deployed witness');
{ // exclusion sits inside the cum CTE only — between "cum AS (" and the trip CTE
  const a = NEW.indexOf('cum AS ('), b = NEW.indexOf('trip AS (');
  const inCum = NEW.slice(a, b);
  ok(a > 0 && b > a && inCum.indexOf("NOT LIKE 'RECERT_QUARANTINE%'") > 0, 'KR-03 exclusion scoped to the cum CTE');
  ok(NEW.indexOf("NOT LIKE 'RECERT_QUARANTINE%'") === NEW.lastIndexOf("NOT LIKE 'RECERT_QUARANTINE%'"), 'KR-04 exactly one predicate site (stops/day legs untouched)');
}
ok(NEW.includes("'epoch'::timestamptz") && NEW.includes('cohort_cum_net FROM cum) <= coalesce'),
  'KR-05 fail-closed missing-baseline + threshold compare survive byte-identical');
{ const strip = (s) => s.replace(/-- QTP_KSCUM_v5[^]*?threshold -> -1250 \(~1\.2% of equity\)\.\n/, '').replace(/ *AND coalesce\(l\.lineage_source, ''\) NOT LIKE 'RECERT_QUARANTINE%'\n/, '');
  ok(strip(NEW) === OLD, 'KR-06 no-collateral: patched minus insertion == deployed bytes'); }
ok((NEW.match(/\{\{[^}]+\}\}/g) || []).length === (OLD.match(/\{\{[^}]+\}\}/g) || []).length,
  'KR-07 all n8n {{ }} expressions preserved');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
