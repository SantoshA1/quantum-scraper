// ═══════════════════════════════════════════════════════════════════════
// Limit Order Entry Module — Reference Implementation
// H-2 Fix: Replace market orders with limit orders at bid+1 tick
// ═══════════════════════════════════════════════════════════════════════
// PROBLEM:
//   Market orders on SMCI/IONQ-sized positions (low liquidity, wide spreads)
//   cause significant slippage. A 500-share SMCI market buy can walk the book
//   $0.50–$2.00 above the NBBO mid, costing $250–$1000 per entry.
//
// SOLUTION:
//   1. Fetch NBBO quote from Alpaca Data API before every order
//   2. Buy entries: limit_price = best_ask + 1 tick (aggressive but capped)
//   3. Sell entries: limit_price = best_bid - 1 tick
//   4. Bracket orders: entry leg is limit (not market), TIF=day
//   5. Non-bracket (volatile trail path): limit + IOC, market fallback on cancel
//
// TICK SIZE:
//   SEC Rule 612 (Sub-Penny Rule): stocks >= $1.00 → tick = $0.01
//   Stocks < $1.00 → tick = $0.0001 (but we don't trade sub-dollar)
//   We use $0.01 universally since the S&P 500 whitelist is all ≥ $1.
//
// SPREAD GUARD:
//   If spread > 0.5% of mid, the book is thin → widen to mid+1tick instead
//   of chasing the ask. This caps adverse selection on illiquid names.
//
// FALLBACK:
//   If quote fetch fails (data API down, pre-market, etc.) → fall back to
//   market order with a log warning. Position protection is more important
//   than saving a few cents of slippage.
// ═══════════════════════════════════════════════════════════════════════

const TICK = 0.01;  // Minimum price increment (SEC Rule 612)
const SPREAD_WARN_PCT = 0.005;  // 0.5% — flag wide spreads
const DATA_API_BASE = 'https://data.alpaca.markets/v2';

/**
 * Fetch the latest NBBO quote for a symbol from Alpaca Data API v2.
 *
 * @param {object} helpers - n8n helpers object (for httpRequest)
 * @param {string} symbol  - Ticker symbol (e.g., 'SMCI')
 * @param {object} headers - Alpaca auth headers (same keys work for data API)
 * @returns {object|null}  - { bid, ask, bidSize, askSize, spread, mid, limitPrice, orderType }
 */
async function getQuoteAndLimitPrice(helpers, symbol, headers, side) {
  try {
    const quoteResp = await helpers.httpRequest({
      method: 'GET',
      url: `${DATA_API_BASE}/stocks/${symbol}/quotes/latest`,
      headers: {
        'APCA-API-KEY-ID': headers['APCA-API-KEY-ID'],
        'APCA-API-SECRET-KEY': headers['APCA-API-SECRET-KEY'],
      },
      json: true,
      timeout: 5000,
    });

    const quote = quoteResp.quote || quoteResp;
    const bid = parseFloat(quote.bp || quote.bid_price || 0);
    const ask = parseFloat(quote.ap || quote.ask_price || 0);
    const bidSize = parseInt(quote.bs || quote.bid_size || 0);
    const askSize = parseInt(quote.as || quote.ask_size || 0);

    if (bid <= 0 || ask <= 0 || ask < bid) {
      console.warn(`[QUOTE] Invalid quote for ${symbol}: bid=${bid} ask=${ask}`);
      return null;
    }

    const spread = ask - bid;
    const mid = (bid + ask) / 2;
    const spreadPct = spread / mid;

    let limitPrice;
    const isBuy = side === 'buy';

    if (spreadPct > SPREAD_WARN_PCT) {
      // Wide spread — use midpoint + 1 tick to avoid chasing thin ask
      // This caps slippage at half the spread instead of paying full ask
      limitPrice = isBuy
        ? Math.round((mid + TICK) * 100) / 100
        : Math.round((mid - TICK) * 100) / 100;
      console.log(`[QUOTE] WIDE SPREAD ${symbol}: bid=$${bid} ask=$${ask} spread=${(spreadPct*100).toFixed(3)}% → using mid±tick: $${limitPrice}`);
    } else {
      // Normal spread — bid+1tick for buys, ask-1tick for sells
      // Aggressive enough to fill immediately, but doesn't walk the book
      limitPrice = isBuy
        ? Math.round((ask + TICK) * 100) / 100    // ask + 1 tick: cross spread to guarantee fill
        : Math.round((bid - TICK) * 100) / 100;   // bid - 1 tick: cross spread to guarantee fill
      console.log(`[QUOTE] ${symbol}: bid=$${bid} ask=$${ask} spread=$${spread.toFixed(4)} → limit=$${limitPrice}`);
    }

    return {
      bid, ask, bidSize, askSize, spread, mid, spreadPct,
      limitPrice,
      orderType: 'limit',
      wideSpread: spreadPct > SPREAD_WARN_PCT,
    };
  } catch (err) {
    console.warn(`[QUOTE] Failed to fetch quote for ${symbol}: ${err.message} — falling back to market`);
    return null;
  }
}

module.exports = { getQuoteAndLimitPrice, TICK, SPREAD_WARN_PCT, DATA_API_BASE };
