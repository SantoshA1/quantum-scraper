import os
_HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(_HERE, 'gatek_edge.py')).read().split('print("="*76)\nprint("1.')[0])
import math
def wilson(k,n,z=1.96):
    if n==0: return (0,0)
    p=k/n; d=1+z*z/n
    c=(p+z*z/(2*n))/d; h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
    return c-h,c+h

def show(label, rows):
    r = kelly(rows)
    if not r: print(f"   {label:<34} n=0"); return
    if r.get('k') is None:
        print(f"   {label:<34} n={r['n']:<3} wins={r['wins']:<2} DEGENERATE"); return
    lo,hi = wilson(r['wins'], r['n'])
    pnl = sum(x[4] for x in rows)
    print(f"   {label:<34} n={r['n']:<3} wr={r['wr']*100:5.1f}% [{lo*100:4.1f}-{hi*100:4.1f}]  k*={r['k']:+.4f}  P&L=${pnl:>+9,.2f}")

print("="*104)
print("IS ANY PART OF THIS STRATEGY PROFITABLE? (all cuts on the full 42)")
print("="*104)
show("ALL", T)
print("   " + "-"*98)
show("LONGS only", [r for r in T if r[1]=="buy"])
show("SHORTS only", [r for r in T if r[1]=="sell"])
print("   " + "-"*98)
for reason in ("stop","manual","trail","time"):
    show(f"exit = {reason}", [r for r in T if r[2]==reason])
print("   " + "-"*98)
show("entered in the last 14 days", [r for r in T if r[7] >= "2026-07-24"])
show("entered before that", [r for r in T if r[7] < "2026-07-24"])

print()
print("="*104)
print("DOLLARS, NOT R — the number that is not distorted by the risk-basis problem")
print("="*104)
tot = sum(r[4] for r in T)
L = [r for r in T if r[1]=="buy"]; S=[r for r in T if r[1]=="sell"]
print(f"   total realised over the 42-trade window : ${tot:>+10,.2f}")
print(f"     longs  (n={len(L):<2}) : ${sum(r[4] for r in L):>+10,.2f}")
print(f"     shorts (n={len(S):<2}) : ${sum(r[4] for r in S):>+10,.2f}")
gw = sum(r[4] for r in T if r[4]>0); gl = sum(r[4] for r in T if r[4]<=0)
print(f"   gross win ${gw:,.2f} / gross loss ${abs(gl):,.2f}  -> profit factor = {gw/abs(gl):.3f}")
for lbl, rows in (("longs",L),("shorts",S)):
    w=sum(r[4] for r in rows if r[4]>0); l=abs(sum(r[4] for r in rows if r[4]<=0))
    print(f"     {lbl:<7} profit factor = {w/l:.3f}   (win ${w:,.2f} / loss ${l:,.2f})")
