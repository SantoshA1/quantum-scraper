import os
_HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(_HERE, 'gatek_edge.py')).read().split('print("="*76)\nprint("1.')[0])
import random
random.seed(20260807)
L=[r for r in T if r[1]=="buy"]; S=[r for r in T if r[1]=="sell"]
def pf(rows):
    w=sum(r[4] for r in rows if r[4]>0); l=abs(sum(r[4] for r in rows if r[4]<=0))
    return w/l if l>0 else float('inf')

print("="*96)
print("ROBUSTNESS OF THE LONG/SHORT SPLIT")
print("="*96)
print(f"   longs  PF={pf(L):.3f}  n={len(L)}      shorts PF={pf(S):.3f}  n={len(S)}")

# jackknife: drop each single trade, does the conclusion hold?
lp=[pf([x for x in L if x is not r]) for r in L]
sp=[pf([x for x in S if x is not r]) for r in S]
print(f"   jackknife (drop any 1 trade):")
print(f"     longs  PF range  [{min(lp):.3f}, {max(lp):.3f}]   -> still >1.0 in {sum(1 for v in lp if v>1)}/{len(lp)} cases")
print(f"     shorts PF range  [{min(sp):.3f}, {max(sp):.3f}]   -> still <1.0 in {sum(1 for v in sp if v<1)}/{len(sp)} cases")

# drop the 3 worst shorts entirely - is the short side still bad?
S2 = sorted(S, key=lambda r: r[4])[3:]
print(f"   shorts after deleting their 3 WORST losses: PF={pf(S2):.3f} (n={len(S2)})  -> {'still losing' if pf(S2)<1 else 'profitable'}")
# drop the best long - is the long side still ok?
L2 = sorted(L, key=lambda r: -r[4])[1:]
print(f"   longs after deleting their BEST win:        PF={pf(L2):.3f} (n={len(L2)})  -> {'still profitable' if pf(L2)>1 else 'LOSES without its best trade'}")

# bootstrap PF>1
def boot(rows, B=20000):
    c=0
    for _ in range(B):
        s=[random.choice(rows) for _ in range(len(rows))]
        if pf(s)>1: c+=1
    return c/B
print(f"   bootstrap P(PF>1):  longs {boot(L)*100:.1f}%   shorts {boot(S)*100:.1f}%")

print()
print("="*96)
print("WHAT WOULD GATE-K RETURN IF IT MEASURED EDGE PER DIRECTION?")
print("="*96)
for lbl, rows in (("LONG", L), ("SHORT", S)):
    r = kelly(rows)
    n=r['n']
    if n < 40:
        verdict = f"n={n} < min_trades 40  ->  probation_sizing_insufficient_sample  ->  APPROVED at 0.50% risk"
    elif r['k'] <= 0:
        verdict = f"n={n}, k*={r['k']:+.4f}  ->  negative_measured_edge  ->  REJECTED"
    else:
        verdict = f"n={n}, k*={r['k']:+.4f}  ->  fractional_kelly  ->  APPROVED"
    print(f"   {lbl:<6}: {verdict}")
print()
print("   NOTE: the long side clears only because n<40 sends it to PROBATION sizing (0.50%),")
print("   not because a positive edge has been demonstrated. Small sample -> small size is")
print("   the gate's own designed behaviour, and it is the conservative outcome here.")
