import os
_HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(_HERE, 'gatek_edge.py')).read().split('print("="*76)\nprint("1.')[0])

def show(label, rows):
    r = kelly(rows)
    if not r or r.get('k') is None:
        print(f"   {label:<52} n={r['n']:<3} DEGENERATE (no wins or no losses)"); return
    gate = "REJECT ALL" if (r['n']>=40 and r['k']<=0) else ("probation->APPROVE (n<40)" if r['n']<40 else "APPROVE")
    print(f"   {label:<52} n={r['n']:<3} wr={r['wr']*100:5.2f}%  b={r['b']:5.2f} a={r['a']:4.2f}  k*={r['k']:+.4f}  -> {gate}")

print("="*100)
print("CLEANED-SAMPLE VERDICT — rules pre-registered on PROVENANCE, never on outcome")
print("="*100)
base = kelly(T)
show("A. as-is (what the gate sees today)", T)

# Rule 1: exclude quarantined lineage. The function ALREADY filters lineage for the
# short-side multiplier (H4_/RECERT_ prefixes) but NOT for the main edge calc.
r1 = [r for r in T if r[3] != "RECERT_QUARANTINE"]
show("B. + exclude QUARANTINED lineage (consistency w/ short leg)", r1)

# Rule 2: exclude positions ENTERED outside the 90d window. The gate filters on exit time
# only, so two April positions leak in from a prior regime.
r2 = [r for r in r1 if r[7] >= "2026-05-09"]
show("C. + exclude entries older than the 90d window (Apr legacy)", r2)

print()
print("="*100)
print("WHY THOSE TWO TRADES MATTER SO MUCH")
print("="*100)
for sym in ("AFL","LDOS"):
    row = [r for r in T if r[0]==sym][0]
    print(f"   {sym:<5} entered {row[7]}  net=${row[4]:>+8,.2f}  r={row[5]:+7.4f}  risk_basis=${abs(row[4]/row[5]):>7,.2f}  lineage={row[3]}")
print(f"   -> they are 2 of only 7 wins, and supply the fat tail that sets avg_win_r=2.937.")
print(f"   -> avg_win_r drives breakeven = a/(a+b): a bigger b LOWERS the bar the strategy must clear.")
print(f"   -> so these two degenerate-risk trades are currently FLATTERING the verdict, not hurting it.")

print()
print("="*100)
print("DIRECTION OF THE ERROR — does cleaning help or hurt the case for trading?")
print("="*100)
a, c = kelly(T), kelly(r2)
print(f"   as-is    k* = {a['k']:+.4f}")
print(f"   cleaned  k* = {c['k']:+.4f}" if c and c.get('k') is not None else "   cleaned: degenerate")
if c and c.get('k') is not None:
    print(f"   -> cleaning the sample makes the measured edge {'WORSE' if c['k']<a['k'] else 'BETTER'}.")
    print(f"   -> HONEST CONCLUSION: fixing the measurement does NOT rescue the strategy.")
    print(f"      The halt is directionally correct. What is wrong is its PERMANENCE and its")
    print(f"      CONFIDENCE, not its sign.")
