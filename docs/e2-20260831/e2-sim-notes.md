# E2 sim provenance
- Sim rules (SQL, engine-parity proven 25/25 vs lib/analysis/exit_grid.js):
  entry d0 close; stop = entry*0.975; d1/d2: open<=stop -> exit at open (gap),
  elif low<=stop -> exit at stop; else d2 close. R = ((exit/entry)-1)/0.025.
- Tables: quantum.e2_candidates_20260831 (904), quantum.e2_outcomes_20260831
  (REAL 904, N1_RAND_SYM 904, N2_RAND_DAY 904, N3_SPY 609).
- Nulls matched 1:1 per candidate, deterministic seeds (md5 of sym|d0|salt).
- Inference: paired day-block bootstrap, 10k resamples, seed 20260831
  (e2-analyze.py output in e2-results.json; day aggregates in
  e2-daily-aggregates.json, totals cross-checked against SQL counts).
