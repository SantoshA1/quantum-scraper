
## DUP_LEG_FIX_v1 (same day, live 38696273)

FINRA + Price History both fed Dark Pool Engine input 0 directly -> DPE and the
ENTIRE downstream leg (incl. the Opus analyst) ran TWICE per signal, and leg 1
fired BEFORE Price History existed (degraded dp data: exec 420885 leg1
dp_ad_pattern=UNAVAILABLE vs leg2 HEAVY_DISTRIBUTION).

Fix: new "Merge DP Data Ready" node (merge mode=append) between the fetches and
DPE. Waits for both -> single wave -> DPE runs once with full data. DPE reads
data via $('node') refs, so only the timing matters. Append (not combine) so a
0-item fetch still lets the other through; DPE handles missing sources.
Halves analyst spend; ends duplicate audit rows; ends the degraded-data leg.
Governance: ssm_workflow_updates row #127.
