# C-5 Fix: Trailing Stop Race Condition — Atomic Replace + Circuit Breaker

## Audit Issue

**ID:** C-5 (Critical)  
**Component:** Trailing Stop Manager v1.6 (n8n workflow)  
**Risk:** During stop price adjustments, the old stop is cancelled and a new one placed 500ms+ later. In that window, the position is completely unprotected. A flash crash during the gap means no stop-loss fires.

## Root Cause (v1.6)

```javascript
// v1.6 DANGEROUS PATTERN (lines ~290-295 of original):
await alp.call(this, 'DELETE', '/v2/orders/' + existingStop.orderId);
await new Promise(r => setTimeout(r, 500));  // 500ms+ NAKED POSITION
const newOrder = await alp.call(this, 'POST', '/v2/orders', { ... });
```

**Timeline of exposure:**
1. DELETE fires → old stop cancelled immediately
2. 500ms artificial delay
3. POST fires → new stop submitted → ~50-200ms for exchange acceptance
4. **Total unprotected window: 700ms-1s+** (can be longer under load)

During this window, a position worth $50K+ has zero downside protection.

## Fix: Three-Layer Defense (v1.7)

### Layer 1: Atomic PATCH (primary)

Alpaca's `PATCH /v2/orders/{order_id}` atomically replaces an order — the old order transitions through `pending_replace` → `replaced` while the new order is created. There is **zero gap** where no stop exists.

```javascript
const replaced = await alp.call(this, 'PATCH', `/v2/orders/${oldOrder.orderId}`, {
  stop_price: String(newStopPrice)
});
```

Used when only the stop price changes (same qty). This covers ~80% of stop adjustments (pure tier-up raises).

### Layer 2: Overlap-Safe Fallback

When PATCH fails (e.g., qty changed after a scale-out, or order is in a transient state):

```javascript
// Step A: Place NEW stop while old still active (brief overlap — harmless)
const newOrder = await alp.call(this, 'POST', '/v2/orders', { ... });

// Step B: Verify new stop is accepted
const check = await alp.call(this, 'GET', `/v2/orders/${newOrder.id}`);

// Step C: Cancel old stop (position protected by new stop)
await alp.call(this, 'DELETE', `/v2/orders/${oldOrder.orderId}`);
```

**Why overlap is safe:** Having two stops briefly is harmless. If the stop price triggers during overlap, Alpaca fills the first and rejects the second (insufficient qty). The position is **always protected**.

### Layer 3: Circuit Breaker

If both methods fail twice consecutively for a symbol:

- That symbol's trailing is **paused** (skipped on subsequent runs)
- A Telegram alert fires immediately
- The old stop remains in place (never cancelled if new one can't be placed)
- Manual reset: clear `circuitBreaker.{SYMBOL}` from workflow static data

```javascript
const CIRCUIT_BREAKER_THRESHOLD = 2;

// In state:
state.circuitBreaker = {
  // Example when tripped:
  "AAPL": { failures: 2, lastFailure: "2026-...", pausedAt: "2026-..." }
};
```

## What Changed (v1.6 → v1.7)

| Aspect | v1.6 | v1.7 |
|--------|------|------|
| Stop replacement | DELETE → 500ms wait → POST | PATCH (atomic, 0ms gap) |
| Fallback | None | Place-new → verify → cancel-old |
| Failure handling | Log error, continue | Circuit breaker pauses symbol |
| Unprotected window | 500ms-1s+ | **0ms** |
| State tracking | scaledOut, trailState | + circuitBreaker |

## Files Modified

- `trailing-stop-v1.7.js` — Complete v1.7 code (standalone file for reference)
- `n8n-workflows/trailing-stop-manager-v1.json` — Updated workflow JSON (importable)

## Deployment Steps

### Option A: Import Updated Workflow (Recommended)
1. Open n8n at tradenextgen.app.n8n.cloud
2. Go to Trailing Stop Manager workflow
3. **Backup**: Export current workflow as JSON first
4. Delete the existing "Trail Stops" Code node
5. Import the code from `trailing-stop-v1.7.js` into a new Code node
6. Reconnect: "Every 15 min" trigger → new Code node
7. Save and activate

### Option B: Manual Code Replacement
1. Open the "Trail Stops" Code node
2. Select all code and delete
3. Paste the entire contents of `trailing-stop-v1.7.js`
4. Save the node, save the workflow

### Post-Deployment Verification
1. Check n8n execution logs for `[TRAIL v1.7]` prefix (confirms new version running)
2. Wait for a tier transition on any position
3. Verify log shows `ATOMIC REPLACE` or `OVERLAP-SAFE` method used
4. Confirm no `500ms` delay in execution timeline

## Circuit Breaker Management

**View status:** Check `circuitBreaker` in workflow static data  
**Reset a paused symbol:** Delete its key from `state.circuitBreaker`  
**Adjust threshold:** Change `CIRCUIT_BREAKER_THRESHOLD` constant (default: 2)

## Commit

Part of audit fix batch — commit includes updated workflow JSON and standalone JS file.
