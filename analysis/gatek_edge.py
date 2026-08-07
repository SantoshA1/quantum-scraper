import math, random, json
random.seed(20260807)  # deterministic

# The exact 42-row sample compute_kelly_gate measures (strategy/mode/status/r_multiple/90d).
# (symbol, side, exit_reason, lineage, net_pnl, r, stop_width_pct, entry_date)
T = [
("ADI","sell","stop","RECERT",-97.25,-1.0276,4.135,"2026-07-17"),
("CBRE","sell","time","RECERT",-34.65,-0.0664,4.831,"2026-07-17"),
("JKHY","sell","time","RECERT",-11.89,-0.0278,3.977,"2026-07-17"),
("MAR","sell","time","RECERT",-29.35,-0.0766,3.633,"2026-07-17"),
("RMD","sell","time","RECERT",31.86,0.1059,2.794,"2026-07-17"),
("AKAM","buy","manual","RECERT",-82.73,-0.1859,4.115,"2026-07-20"),
("FDX","sell","stop","RECERT",-202.71,-2.0909,3.547,"2026-07-20"),
("ALB","sell","stop","RECERT",-98.28,-1.0189,4.761,"2026-07-20"),
("HD","sell","stop","RECERT",-97.92,-1.0200,3.152,"2026-07-20"),
("BX","sell","stop","RECERT",-109.62,-1.1250,4.293,"2026-07-20"),
("SHW","buy","manual","RECERT",-453.81,-2.0403,2.099,"2026-07-22"),
("PGR","sell","stop","RECERT",-153.40,-1.5775,2.458,"2026-07-21"),
("XYL","sell","stop","RECERT",-119.21,-1.2358,3.338,"2026-07-21"),
("VRSN","sell","stop","RECERT",-132.21,-1.3893,2.924,"2026-07-21"),
("FIS","sell","stop","RECERT",-109.47,-1.1081,4.870,"2026-07-22"),
("AFL","buy","manual","RECERT",12.52,3.4778,None,"2026-04-09"),
("LDOS","sell","trail","RECERT_QUARANTINE",855.40,10.2174,None,"2026-04-23"),
("WMT","sell","stop","RECERT",-97.00,-1.0101,2.029,"2026-07-21"),
("WST","buy","manual","RECERT",-35.52,-0.0570,5.821,"2026-07-28"),
("WSM","buy","stop","RECERT",-99.94,-1.0278,5.046,"2026-07-28"),
("ZBRA","buy","manual","RECERT",540.80,1.7650,2.898,"2026-07-27"),
("ARE","buy","manual","RECERT",564.74,1.0657,4.866,"2026-07-28"),
("YUM","buy","stop","RECERT",-108.50,-1.1232,2.876,"2026-07-29"),
("AIZ","buy","stop","RECERT",-104.34,-1.1059,2.984,"2026-07-29"),
("AVB","buy","stop","RECERT",-119.84,-1.2370,3.210,"2026-07-29"),
("WYNN","buy","manual","RECERT",-36.04,-0.0988,3.406,"2026-07-30"),
("BA","sell","stop","RECERT",-316.54,-1.0016,2.223,"2026-07-29"),
("WY","sell","stop","RECERT",-39.34,-1.6316,3.490,"2026-07-30"),
("WST","sell","stop","RECERT",-103.23,-1.1063,1.702,"2026-07-31"),
("WMB","sell","stop","RECERT",-8.88,-1.2000,3.113,"2026-07-27"),
("ADSK","sell","stop","RECERT",-615.80,-1.9486,3.704,"2026-07-31"),
("AVB","sell","stop","RECERT",-107.68,-1.1318,1.746,"2026-08-03"),
("AKAM","buy","manual","RECERT",555.08,1.9403,2.693,"2026-07-30"),
("XPEV","sell","stop","RECERT",-94.27,-1.0000,3.223,"2026-08-03"),
("AEE","buy","stop","RECERT",-107.36,-1.1411,3.730,"2026-08-03"),
("WSM","buy","manual","RECERT",484.65,1.9871,2.311,"2026-08-03"),
("WMB","sell","stop","RECERT",-341.14,-1.0184,1.881,"2026-08-04"),
("WSM","buy","stop","RECERT",-112.98,-1.1956,3.238,"2026-08-05"),
("WMT","sell","trail","H4",-136.80,-0.3934,2.970,"2026-07-30"),
("AEP","sell","trail","H4",-110.35,-0.2089,4.912,"2026-08-05"),
("WRB","buy","manual","H4",-157.66,-0.8661,3.046,"2026-08-06"),
("APA","buy","manual","H4",-45.15,-0.1156,3.955,"2026-08-06"),
]

def kelly(rows):
    n = len(rows)
    if n == 0: return None
    wins = sum(1 for r in rows if r[4] > 0)
    wr = wins / n
    pos = [r[5] for r in rows if r[5] > 0]
    neg = [r[5] for r in rows if r[5] <= 0]
    if not pos or not neg: return dict(n=n, wins=wins, wr=wr, b=None, a=None, k=None)
    b = sum(pos)/len(pos)          # avg win R
    a = abs(sum(neg)/len(neg))     # avg loss R
    k = wr/a - (1-wr)/b
    return dict(n=n, wins=wins, wr=wr, b=b, a=a, k=k, breakeven_wr=a/(a+b))

base = kelly(T)
print("="*76)
print("1. BASELINE — reproduce what the live gate returned")
print("="*76)
print(f"   n={base['n']}  wins={base['wins']}  win_rate={base['wr']:.4f}")
print(f"   avg_win_r={base['b']:.4f}  avg_loss_r={base['a']:.4f}  kelly*={base['k']:.4f}")
print(f"   live gate said: n=42 wr=0.1667 b=2.9370 a=0.9603 k=-0.1102")
print(f"   MATCH: {abs(base['k']+0.1102)<0.001 and base['n']==42}")
print(f"   breakeven win rate needed = {base['breakeven_wr']:.4f} ({base['breakeven_wr']*100:.2f}%)")

print()
print("="*76)
print("2. HOW CONFIDENT IS THE VERDICT? (is -0.11 signal or noise?)")
print("="*76)
# Wilson 95% CI for win rate
def wilson(k, n, z=1.96):
    p = k/n; d = 1 + z*z/n
    c = (p + z*z/(2*n))/d
    h = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))/d
    return c-h, c+h
lo, hi = wilson(base['wins'], base['n'])
print(f"   win rate 7/42 = 16.67%   Wilson 95% CI = [{lo*100:.2f}%, {hi*100:.2f}%]")
print(f"   breakeven 24.64% inside CI? {lo <= base['breakeven_wr'] <= hi}")

# one-sided binomial: P(X <= 7 | n=42, p=breakeven)
def binom_cdf(k, n, p):
    return sum(math.comb(n,i)*p**i*(1-p)**(n-i) for i in range(k+1))
pval = binom_cdf(base['wins'], base['n'], base['breakeven_wr'])
print(f"   P(<=7 wins | n=42, p=breakeven 24.64%) = {pval:.4f}")
print(f"   -> can we reject 'strategy is at least breakeven' at 5%? {'YES' if pval<0.05 else 'NO'}")

# bootstrap sign stability of k*
B, negk, valid = 20000, 0, 0
for _ in range(B):
    s = [random.choice(T) for _ in range(len(T))]
    r = kelly(s)
    if r and r.get('k') is not None:
        valid += 1
        if r['k'] <= 0: negk += 1
print(f"   bootstrap ({valid} valid resamples): kelly* <= 0 in {negk/valid*100:.1f}% of them")

print()
print("="*76)
print("3. DOES THE SAMPLE DESCRIBE THE SYSTEM AS IT EXISTS TODAY?")
print("="*76)
widths = [r[6] for r in T if r[6] is not None]
print(f"   trades with a recorded stop width: {len(widths)}/{len(T)}")
print(f"   stop width  min={min(widths):.3f}%  median={sorted(widths)[len(widths)//2]:.3f}%  max={max(widths):.3f}%")
post = [w for w in widths if w <= 1.2]
print(f"   trades taken at the CURRENT 1.2% clamp: {len(post)}  <-- the whole point")
print(f"   trades wider than the TSM's 1.2% limit: {len([w for w in widths if w>1.2])}/{len(widths)} = {len([w for w in widths if w>1.2])/len(widths)*100:.1f}%")

stops = [r for r in T if r[2]=="stop"]
sw = kelly(stops)
print(f"   'stop' exits: n={len(stops)} wins={sum(1 for r in stops if r[4]>0)} totalP&L=${sum(r[4] for r in stops):,.2f}")
nonstop = [r for r in T if r[2]!="stop"]
ns = kelly(nonstop)
print(f"   everything else: n={ns['n']} wins={ns['wins']} wr={ns['wr']:.3f} k*={ns['k']:+.4f} totalP&L=${sum(r[4] for r in nonstop):,.2f}")

print()
print("="*76)
print("4. SENSITIVITY — which trades is the verdict leaning on?")
print("="*76)
def show(label, rows):
    r = kelly(rows)
    if not r or r.get('k') is None:
        print(f"   {label:<46} n={r['n']:<3} (degenerate)"); return
    verdict = "REJECT ALL" if (r['n']>=40 and r['k']<=0) else ("probation->APPROVE" if r['n']<40 else "APPROVE")
    print(f"   {label:<46} n={r['n']:<3} wr={r['wr']*100:5.2f}%  k*={r['k']:+.4f}  -> {verdict}")
show("as-is (what the gate sees)", T)
show("drop the 2 April legacy trades (AFL, LDOS)", [r for r in T if r[7] < "2026-07-01"])
show("drop the QUARANTINED trade (LDOS)", [r for r in T if r[3]!="RECERT_QUARANTINE"])
show("drop the 4 rows H4 booked yesterday", [r for r in T if r[3]!="H4"])
show("only trades with stop width <= 3%", [r for r in T if r[6] is not None and r[6]<=3.0])
show("only trades with stop width > 3%", [r for r in T if r[6] is not None and r[6]>3.0])

print()
print("="*76)
print("5. RISK-BASIS INTEGRITY — are the R multiples comparable?")
print("="*76)
print("   implied risk_amount = net_pnl / r_multiple")
ra = []
for r in T:
    if r[5] != 0:
        ra.append((r[0], r[7], abs(r[4]/r[5])))
ra.sort(key=lambda x: x[2])
for sym, d, v in ra[:5]:
    print(f"     {sym:<6} {d}  risk_basis=${v:>9,.2f}   <-- smallest")
print("     ...")
for sym, d, v in ra[-3:]:
    print(f"     {sym:<6} {d}  risk_basis=${v:>9,.2f}")
med = ra[len(ra)//2][2]
print(f"   median risk basis = ${med:,.2f}")
outl = [x for x in ra if x[2] < med*0.5]
print(f"   trades whose risk basis is <50% of median: {len(outl)} -> {[x[0] for x in outl]}")

print()
print("="*76)
print("6. THE ONE PATH THAT NEEDS NO INTERVENTION: the 4 open positions closing")
print("="*76)
# live unrealized as of 2026-08-07 15:30Z, and each position's risk basis from its
# intended_stop (qty * |entry-stop|) so the implied R is computed the way the gate would.
OPEN = [
  # sym, side, qty, entry, intended_stop, unrealized_pnl
  ("AES","sell",731,14.66,14.78,-43.86),
  ("ALLE","buy", 64,165.87,157.71, 264.00),
  ("DGX","buy",  45,234.82,227.16, 148.95),
  ("XPEV","sell",858,12.42,12.90, 231.662574),
]
add = []
for sym, side, qty, entry, stop, pnl in OPEN:
    risk = qty*abs(entry-stop)
    r = pnl/risk
    add.append((sym, side, "open", "LIVE", pnl, r, abs(entry-stop)/entry*100, "2026-08-07"))
    print(f"   {sym:<5} {side:<4} risk_basis=${risk:>8,.2f}  unrealized=${pnl:>+9,.2f}  implied R={r:>+7.4f}")

proj = kelly(T + add)
print()
print(f"   IF all four closed right now at today's marks:")
print(f"     n={proj['n']}  wins={proj['wins']}  win_rate={proj['wr']*100:.2f}%")
print(f"     avg_win_r={proj['b']:.4f}  avg_loss_r={proj['a']:.4f}")
print(f"     kelly* = {proj['k']:+.4f}   breakeven wr = {proj['breakeven_wr']*100:.2f}%")
print(f"     VERDICT -> {'STILL REJECT ALL' if proj['k']<=0 else 'APPROVED — gate self-clears'}")

print()
print("   how many additional WINS (at the sample's current avg win R) would clear it?")
for extra in range(0, 13):
    sim = T + [("SIM","buy","manual","SIM", 100.0, base['b'], 1.2, "2026-08-10")]*extra
    r = kelly(sim)
    if r['k'] > 0:
        print(f"     -> {extra} more average-sized wins flips kelly* to {r['k']:+.4f} (n={r['n']}, wr={r['wr']*100:.1f}%)")
        break
else:
    print("     -> not reachable within 12 added wins")

print()
print("="*76)
print("7. IS THE HALT TOTAL? any other strategy still able to trade?")
print("="*76)
