// ═══════════════════════════════════════════════════════════════════════════
// POSITION SIZER v1.0 — Notional Cap + Sector Concentration Limits (C-6 fix)
//
// PURPOSE: Prevents any single position or sector from consuming a
// disproportionate share of account equity. Two enforcement points:
//   1. Signal State Machine (pre-trade gate) — blocks entry if caps breached
//   2. Alpaca Paper Trade (final guard) — clamps qty before order submission
//
// DESIGN PRINCIPLES:
//   - All limits are % of equity, not absolute dollars (scales automatically)
//   - Sector map covers S&P 500 + common ETFs + leveraged products
//   - Alerts fire at warning thresholds (80% of limit) before blocking
//   - Every blocked or clamped trade is logged with full context
//
// CONFIGURATION: Override via workflow static data key `_positionLimits`:
//   {
//     maxPositionPct: 10,       // hard cap per position (% of equity)
//     maxSectorPct: 25,         // hard cap per sector (% of equity)
//     warnPositionPct: 8,       // warning alert threshold (% of equity)
//     warnSectorPct: 20,        // warning alert threshold (% of equity)
//     maxTotalExposurePct: 80,  // total portfolio exposure cap (% of equity)
//   }
// ═══════════════════════════════════════════════════════════════════════════

// ── DEFAULT LIMITS ───────────────────────────────────────────────────────
const DEFAULT_LIMITS = {
  maxPositionPct:       10,    // 10% of equity per position
  maxSectorPct:         25,    // 25% of equity per sector
  warnPositionPct:       8,    // warn at 8% (80% of limit)
  warnSectorPct:        20,    // warn at 20% (80% of limit)
  maxTotalExposurePct:  80,    // 80% total exposure cap
};

// ── SECTOR MAP ───────────────────────────────────────────────────────────
// GICS sector classification for S&P 500 + common ETFs + leveraged products.
// Tickers not in this map are classified as 'Unknown' (still subject to
// per-position cap, just not sector concentration limits).
const SECTOR_MAP = {
  // ── Information Technology ──────────────────────────────────────────
  AAPL: 'Technology', MSFT: 'Technology', NVDA: 'Technology', AVGO: 'Technology',
  ORCL: 'Technology', CRM: 'Technology', AMD: 'Technology', ADBE: 'Technology',
  CSCO: 'Technology', ACN: 'Technology', INTC: 'Technology', IBM: 'Technology',
  INTU: 'Technology', NOW: 'Technology', QCOM: 'Technology', TXN: 'Technology',
  AMAT: 'Technology', LRCX: 'Technology', ADI: 'Technology', KLAC: 'Technology',
  SNPS: 'Technology', CDNS: 'Technology', MRVL: 'Technology', FTNT: 'Technology',
  PANW: 'Technology', CRWD: 'Technology', ADSK: 'Technology', NXPI: 'Technology',
  MCHP: 'Technology', ON: 'Technology', MU: 'Technology', MSI: 'Technology',
  APH: 'Technology', TEL: 'Technology', HPQ: 'Technology', HPE: 'Technology',
  DELL: 'Technology', GLW: 'Technology', KEYS: 'Technology', CDW: 'Technology',
  IT: 'Technology', MPWR: 'Technology', FSLR: 'Technology', ENPH: 'Technology',
  ROP: 'Technology', SMCI: 'Technology', ARM: 'Technology', PLTR: 'Technology',

  // ── Communication Services ─────────────────────────────────────────
  GOOG: 'Communication', GOOGL: 'Communication', META: 'Communication',
  NFLX: 'Communication', DIS: 'Communication', CMCSA: 'Communication',
  TMUS: 'Communication', VZ: 'Communication', T: 'Communication',
  CHTR: 'Communication', ATVI: 'Communication', EA: 'Communication',
  MTCH: 'Communication', TTWO: 'Communication', LYV: 'Communication',
  PARA: 'Communication', WBD: 'Communication', FOX: 'Communication',
  FOXA: 'Communication', NWS: 'Communication', NWSA: 'Communication',
  IPG: 'Communication', OMC: 'Communication',

  // ── Consumer Discretionary ─────────────────────────────────────────
  AMZN: 'Consumer Disc', TSLA: 'Consumer Disc', HD: 'Consumer Disc',
  MCD: 'Consumer Disc', LOW: 'Consumer Disc', NKE: 'Consumer Disc',
  SBUX: 'Consumer Disc', TJX: 'Consumer Disc', BKNG: 'Consumer Disc',
  CMG: 'Consumer Disc', ORLY: 'Consumer Disc', MAR: 'Consumer Disc',
  HLT: 'Consumer Disc', GM: 'Consumer Disc', F: 'Consumer Disc',
  ROST: 'Consumer Disc', DHI: 'Consumer Disc', LEN: 'Consumer Disc',
  PHM: 'Consumer Disc', AZO: 'Consumer Disc', LULU: 'Consumer Disc',
  DECK: 'Consumer Disc', POOL: 'Consumer Disc', YUM: 'Consumer Disc',
  DPZ: 'Consumer Disc', ETSY: 'Consumer Disc', EXPE: 'Consumer Disc',
  LVS: 'Consumer Disc', CZR: 'Consumer Disc', MGM: 'Consumer Disc',
  CCL: 'Consumer Disc', NCLH: 'Consumer Disc', RCL: 'Consumer Disc',
  ABNB: 'Consumer Disc', RIVN: 'Consumer Disc', LCID: 'Consumer Disc',

  // ── Consumer Staples ───────────────────────────────────────────────
  PG: 'Consumer Staples', KO: 'Consumer Staples', PEP: 'Consumer Staples',
  COST: 'Consumer Staples', WMT: 'Consumer Staples', PM: 'Consumer Staples',
  MO: 'Consumer Staples', MDLZ: 'Consumer Staples', CL: 'Consumer Staples',
  KMB: 'Consumer Staples', GIS: 'Consumer Staples', KHC: 'Consumer Staples',
  HSY: 'Consumer Staples', K: 'Consumer Staples', SJM: 'Consumer Staples',
  CAG: 'Consumer Staples', CPB: 'Consumer Staples', HRL: 'Consumer Staples',
  MKC: 'Consumer Staples', STZ: 'Consumer Staples', BF_B: 'Consumer Staples',
  TAP: 'Consumer Staples', CLX: 'Consumer Staples', CHD: 'Consumer Staples',
  EL: 'Consumer Staples', KVUE: 'Consumer Staples',

  // ── Health Care ────────────────────────────────────────────────────
  UNH: 'Healthcare', JNJ: 'Healthcare', LLY: 'Healthcare', ABBV: 'Healthcare',
  MRK: 'Healthcare', TMO: 'Healthcare', ABT: 'Healthcare', PFE: 'Healthcare',
  DHR: 'Healthcare', BMY: 'Healthcare', AMGN: 'Healthcare', GILD: 'Healthcare',
  ISRG: 'Healthcare', VRTX: 'Healthcare', MDT: 'Healthcare', CI: 'Healthcare',
  ELV: 'Healthcare', HCA: 'Healthcare', BSX: 'Healthcare', SYK: 'Healthcare',
  BDX: 'Healthcare', ZBH: 'Healthcare', REGN: 'Healthcare', BIIB: 'Healthcare',
  MRNA: 'Healthcare', DXCM: 'Healthcare', IDXX: 'Healthcare', IQV: 'Healthcare',
  A: 'Healthcare', ALGN: 'Healthcare', HOLX: 'Healthcare', MTD: 'Healthcare',
  CNC: 'Healthcare', MOH: 'Healthcare', HUM: 'Healthcare', CVS: 'Healthcare',
  GEHC: 'Healthcare', IONQ: 'Healthcare',

  // ── Financials ─────────────────────────────────────────────────────
  BRK_B: 'Financials', JPM: 'Financials', V: 'Financials', MA: 'Financials',
  BAC: 'Financials', WFC: 'Financials', GS: 'Financials', MS: 'Financials',
  SPGI: 'Financials', BLK: 'Financials', C: 'Financials', AXP: 'Financials',
  MMC: 'Financials', CB: 'Financials', PGR: 'Financials', AON: 'Financials',
  ICE: 'Financials', CME: 'Financials', MCO: 'Financials', USB: 'Financials',
  PNC: 'Financials', TFC: 'Financials', SCHW: 'Financials', AIG: 'Financials',
  MET: 'Financials', PRU: 'Financials', AFL: 'Financials', ALL: 'Financials',
  COF: 'Financials', DFS: 'Financials', FIS: 'Financials', FISV: 'Financials',
  GPN: 'Financials', BK: 'Financials', STT: 'Financials', NTRS: 'Financials',
  FITB: 'Financials', KEY: 'Financials', CFG: 'Financials', HBAN: 'Financials',
  MTB: 'Financials', RF: 'Financials', CINF: 'Financials',

  // ── Industrials ────────────────────────────────────────────────────
  GE: 'Industrials', CAT: 'Industrials', UNP: 'Industrials', HON: 'Industrials',
  UPS: 'Industrials', RTX: 'Industrials', BA: 'Industrials', DE: 'Industrials',
  LMT: 'Industrials', GD: 'Industrials', NOC: 'Industrials', MMM: 'Industrials',
  ETN: 'Industrials', ITW: 'Industrials', EMR: 'Industrials', WM: 'Industrials',
  RSG: 'Industrials', CSX: 'Industrials', NSC: 'Industrials', PCAR: 'Industrials',
  FDX: 'Industrials', CTAS: 'Industrials', FAST: 'Industrials', ODFL: 'Industrials',
  JCI: 'Industrials', CARR: 'Industrials', OTIS: 'Industrials', ROK: 'Industrials',
  AME: 'Industrials', IR: 'Industrials', SWK: 'Industrials', GWW: 'Industrials',
  VRSK: 'Industrials', CPRT: 'Industrials', PAYX: 'Industrials', DAL: 'Industrials',
  AAL: 'Industrials', UAL: 'Industrials', LUV: 'Industrials',

  // ── Energy ─────────────────────────────────────────────────────────
  XOM: 'Energy', CVX: 'Energy', COP: 'Energy', EOG: 'Energy', SLB: 'Energy',
  MPC: 'Energy', PSX: 'Energy', VLO: 'Energy', OXY: 'Energy', PXD: 'Energy',
  HAL: 'Energy', DVN: 'Energy', FANG: 'Energy', HES: 'Energy', BKR: 'Energy',
  CTRA: 'Energy', MRO: 'Energy', APA: 'Energy', OKE: 'Energy', WMB: 'Energy',
  KMI: 'Energy', TRGP: 'Energy',

  // ── Materials ──────────────────────────────────────────────────────
  LIN: 'Materials', APD: 'Materials', SHW: 'Materials', ECL: 'Materials',
  FCX: 'Materials', NEM: 'Materials', NUE: 'Materials', DOW: 'Materials',
  DD: 'Materials', PPG: 'Materials', VMC: 'Materials', MLM: 'Materials',
  ALB: 'Materials', CF: 'Materials', MOS: 'Materials', IP: 'Materials',
  IFF: 'Materials', CE: 'Materials', EMN: 'Materials', AVY: 'Materials',

  // ── Utilities ──────────────────────────────────────────────────────
  NEE: 'Utilities', SO: 'Utilities', DUK: 'Utilities', D: 'Utilities',
  AEP: 'Utilities', SRE: 'Utilities', EXC: 'Utilities', XEL: 'Utilities',
  ED: 'Utilities', WEC: 'Utilities', ES: 'Utilities', AWK: 'Utilities',
  DTE: 'Utilities', EIX: 'Utilities', PCG: 'Utilities', FE: 'Utilities',
  PEG: 'Utilities', AEE: 'Utilities', CMS: 'Utilities', CNP: 'Utilities',
  NI: 'Utilities', EVRG: 'Utilities', ATO: 'Utilities', NRG: 'Utilities',
  CEG: 'Utilities', LNT: 'Utilities',

  // ── Real Estate ────────────────────────────────────────────────────
  PLD: 'Real Estate', AMT: 'Real Estate', CCI: 'Real Estate',
  EQIX: 'Real Estate', PSA: 'Real Estate', O: 'Real Estate',
  SPG: 'Real Estate', DLR: 'Real Estate', WELL: 'Real Estate',
  AVB: 'Real Estate', EQR: 'Real Estate', VICI: 'Real Estate',
  IRM: 'Real Estate', MAA: 'Real Estate', ARE: 'Real Estate',
  EXR: 'Real Estate', KIM: 'Real Estate', REG: 'Real Estate',
  ESS: 'Real Estate', HST: 'Real Estate', CPT: 'Real Estate',
  INVH: 'Real Estate', BXP: 'Real Estate', FRT: 'Real Estate',
  PEAK: 'Real Estate', UDR: 'Real Estate',

  // ── ETFs — mapped to their dominant sector/exposure ────────────────
  SPY: 'Broad Market', QQQ: 'Broad Market', IWM: 'Broad Market',
  DIA: 'Broad Market', VOO: 'Broad Market', VTI: 'Broad Market',
  XLK: 'Technology', XLF: 'Financials', XLE: 'Energy', XLV: 'Healthcare',
  XLI: 'Industrials', XLY: 'Consumer Disc', XLP: 'Consumer Staples',
  XLB: 'Materials', XLU: 'Utilities', XLRE: 'Real Estate',
  XLC: 'Communication', SMH: 'Technology', SOXX: 'Technology',
  GLD: 'Commodities', SLV: 'Commodities', USO: 'Energy',
  TLT: 'Fixed Income', IEF: 'Fixed Income', HYG: 'Fixed Income',
  LQD: 'Fixed Income', AGG: 'Fixed Income',

  // ── Leveraged ETFs — inherit sector of underlying, flagged as leveraged ──
  TQQQ: 'Technology',  SQQQ: 'Technology',
  SPXL: 'Broad Market', SPXS: 'Broad Market',
  SOXL: 'Technology',  SOXS: 'Technology',
  UVXY: 'Volatility',  SVXY: 'Volatility',
  UPRO: 'Broad Market', SPXU: 'Broad Market',
  LABU: 'Healthcare',  LABD: 'Healthcare',
  FAS: 'Financials',   FAZ: 'Financials',
  NUGT: 'Commodities', DUST: 'Commodities',
  JNUG: 'Commodities', JDST: 'Commodities',
  ERX: 'Energy',       ERY: 'Energy',
  TECL: 'Technology',  TECS: 'Technology',
  TNA: 'Broad Market', TZA: 'Broad Market',
};

// Leveraged ETFs get a 2x-3x notional multiplier for concentration purposes
const LEVERAGED_MULTIPLIER = {
  TQQQ: 3, SQQQ: 3, SPXL: 3, SPXS: 3, SOXL: 3, SOXS: 3,
  UVXY: 2, SVXY: 2, UPRO: 3, SPXU: 3, LABU: 3, LABD: 3,
  FAS: 3, FAZ: 3, TNA: 3, TZA: 3, TECL: 3, TECS: 3,
  ERX: 3, ERY: 3, NUGT: 3, DUST: 3, JNUG: 3, JDST: 3,
};


// ═══════════════════════════════════════════════════════════════════════════
// EXPORTED FUNCTIONS — used by Signal State Machine and Alpaca Paper Trade
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the sector for a ticker. Returns 'Unknown' if not mapped.
 */
function getSector(ticker) {
  return SECTOR_MAP[ticker] || SECTOR_MAP[ticker.replace('.', '_')] || 'Unknown';
}

/**
 * Get the leverage multiplier for concentration calculation.
 * Regular stocks = 1, 3x ETFs = 3, 2x ETFs = 2.
 */
function getLeverageMultiplier(ticker) {
  return LEVERAGED_MULTIPLIER[ticker] || 1;
}

/**
 * Load limits from workflow static data or use defaults.
 */
function loadLimits(state) {
  const overrides = state._positionLimits || {};
  return {
    maxPositionPct:      overrides.maxPositionPct      ?? DEFAULT_LIMITS.maxPositionPct,
    maxSectorPct:        overrides.maxSectorPct        ?? DEFAULT_LIMITS.maxSectorPct,
    warnPositionPct:     overrides.warnPositionPct     ?? DEFAULT_LIMITS.warnPositionPct,
    warnSectorPct:       overrides.warnSectorPct       ?? DEFAULT_LIMITS.warnSectorPct,
    maxTotalExposurePct: overrides.maxTotalExposurePct ?? DEFAULT_LIMITS.maxTotalExposurePct,
  };
}

/**
 * Compute sector exposure from current positions.
 * Returns: { [sector]: { notional, pctOfEquity, tickers: [...] } }
 */
function computeSectorExposure(activePositions, equity) {
  const sectors = {};
  for (const [sym, pos] of Object.entries(activePositions)) {
    const sector = getSector(sym);
    const leverage = getLeverageMultiplier(sym);
    const mv = (pos.marketValue || 0) * leverage;

    if (!sectors[sector]) {
      sectors[sector] = { notional: 0, pctOfEquity: 0, tickers: [] };
    }
    sectors[sector].notional += mv;
    sectors[sector].tickers.push(sym);
  }

  // Calculate percentages
  for (const s of Object.values(sectors)) {
    s.pctOfEquity = equity > 0 ? parseFloat((s.notional / equity * 100).toFixed(2)) : 0;
  }
  return sectors;
}

/**
 * PRE-TRADE CHECK — called by Signal State Machine before routing to Alpaca.
 *
 * Returns: {
 *   allowed: boolean,
 *   clampedQty: number | null,     // reduced qty if clamped, null if blocked
 *   warnings: string[],            // approaching-limit alerts
 *   blocks: string[],              // hard blocks (trade rejected)
 *   proposedNotional: number,
 *   proposedPctOfEquity: number,
 *   sector: string,
 *   sectorExposure: number,        // current sector % BEFORE this trade
 *   sectorExposureAfter: number,   // projected sector % AFTER this trade
 * }
 */
function preTradeCheck(ticker, price, proposedQty, activePositions, accountSnapshot, state) {
  const limits = loadLimits(state);
  const equity = (accountSnapshot && accountSnapshot.equity) || 100000;
  const leverage = getLeverageMultiplier(ticker);
  const sector = getSector(ticker);

  const proposedNotional = price * proposedQty * leverage;
  const proposedPct = equity > 0 ? (proposedNotional / equity * 100) : 0;

  const warnings = [];
  const blocks = [];

  // ── 1. Per-position notional cap ───────────────────────────────────
  const maxPositionNotional = equity * (limits.maxPositionPct / 100);
  const warnPositionNotional = equity * (limits.warnPositionPct / 100);

  let clampedQty = proposedQty;

  if (proposedNotional > maxPositionNotional) {
    // Clamp qty down to fit within cap
    clampedQty = Math.max(1, Math.floor(maxPositionNotional / (price * leverage)));
    const clampedNotional = price * clampedQty * leverage;
    const clampedPct = (clampedNotional / equity * 100).toFixed(1);

    blocks.push(
      `POSITION CAP: ${ticker} proposed $${proposedNotional.toFixed(0)} (${proposedPct.toFixed(1)}% of equity) ` +
      `exceeds ${limits.maxPositionPct}% cap ($${maxPositionNotional.toFixed(0)}). ` +
      `Clamped: ${proposedQty} → ${clampedQty} shares ($${clampedNotional.toFixed(0)}, ${clampedPct}%).`
    );
  } else if (proposedNotional > warnPositionNotional) {
    warnings.push(
      `Position approaching cap: ${ticker} $${proposedNotional.toFixed(0)} ` +
      `(${proposedPct.toFixed(1)}%) — warning at ${limits.warnPositionPct}%, cap at ${limits.maxPositionPct}%`
    );
  }

  // ── 2. Sector concentration limit ─────────────────────────────────
  const sectorExposure = computeSectorExposure(activePositions, equity);
  const currentSector = sectorExposure[sector] || { notional: 0, pctOfEquity: 0, tickers: [] };
  const clampedNotional = price * clampedQty * leverage;
  const afterSectorNotional = currentSector.notional + clampedNotional;
  const afterSectorPct = equity > 0 ? (afterSectorNotional / equity * 100) : 0;

  const maxSectorNotional = equity * (limits.maxSectorPct / 100);
  const warnSectorNotional = equity * (limits.warnSectorPct / 100);

  if (afterSectorNotional > maxSectorNotional) {
    // Clamp further to fit within sector cap
    const sectorRoom = Math.max(0, maxSectorNotional - currentSector.notional);
    const sectorClampQty = sectorRoom > 0
      ? Math.max(1, Math.floor(sectorRoom / (price * leverage)))
      : 0;

    if (sectorClampQty === 0) {
      blocks.push(
        `SECTOR CAP BLOCKED: ${sector} already at $${currentSector.notional.toFixed(0)} ` +
        `(${currentSector.pctOfEquity}%) — ${limits.maxSectorPct}% cap. ` +
        `Existing: ${currentSector.tickers.join(', ')}. No room for ${ticker}.`
      );
      clampedQty = 0;  // fully blocked
    } else if (sectorClampQty < clampedQty) {
      blocks.push(
        `SECTOR CAP: ${sector} would reach ${afterSectorPct.toFixed(1)}% (cap: ${limits.maxSectorPct}%). ` +
        `Clamped: ${clampedQty} → ${sectorClampQty} shares. ` +
        `Existing in sector: ${currentSector.tickers.join(', ')}`
      );
      clampedQty = sectorClampQty;
    }
  }

  if (afterSectorNotional > warnSectorNotional && afterSectorNotional <= maxSectorNotional) {
    warnings.push(
      `Sector approaching cap: ${sector} would be ${afterSectorPct.toFixed(1)}% ` +
      `after ${ticker} — warning at ${limits.warnSectorPct}%, cap at ${limits.maxSectorPct}%. ` +
      `In sector: ${[...currentSector.tickers, ticker].join(', ')}`
    );
  }

  // ── 3. Total exposure cap ─────────────────────────────────────────
  const currentExposure = (accountSnapshot && accountSnapshot.totalExposure) || 0;
  const afterExposure = currentExposure + (price * clampedQty * leverage);
  const afterExposurePct = equity > 0 ? (afterExposure / equity * 100) : 0;
  const maxExposure = equity * (limits.maxTotalExposurePct / 100);

  if (afterExposure > maxExposure && clampedQty > 0) {
    const exposureRoom = Math.max(0, maxExposure - currentExposure);
    const exposureClampQty = exposureRoom > 0
      ? Math.max(1, Math.floor(exposureRoom / (price * leverage)))
      : 0;

    if (exposureClampQty === 0) {
      blocks.push(
        `TOTAL EXPOSURE CAP BLOCKED: Portfolio at $${currentExposure.toFixed(0)} ` +
        `(${(currentExposure / equity * 100).toFixed(1)}%) — ` +
        `${limits.maxTotalExposurePct}% cap ($${maxExposure.toFixed(0)}). No room.`
      );
      clampedQty = 0;
    } else if (exposureClampQty < clampedQty) {
      blocks.push(
        `TOTAL EXPOSURE CAP: Would reach ${afterExposurePct.toFixed(1)}% ` +
        `(cap: ${limits.maxTotalExposurePct}%). Clamped: ${clampedQty} → ${exposureClampQty} shares.`
      );
      clampedQty = exposureClampQty;
    }
  }

  // Final notional after all clamping
  const finalNotional = price * clampedQty * leverage;
  const finalPct = equity > 0 ? (finalNotional / equity * 100) : 0;

  return {
    allowed:                clampedQty > 0,
    clampedQty:             clampedQty > 0 ? clampedQty : null,
    originalQty:            proposedQty,
    warnings,
    blocks,
    proposedNotional:       parseFloat(proposedNotional.toFixed(2)),
    proposedPctOfEquity:    parseFloat(proposedPct.toFixed(2)),
    finalNotional:          parseFloat(finalNotional.toFixed(2)),
    finalPctOfEquity:       parseFloat(finalPct.toFixed(2)),
    sector,
    sectorExposureBefore:   currentSector.pctOfEquity,
    sectorExposureAfter:    parseFloat((equity > 0 ? ((currentSector.notional + finalNotional) / equity * 100) : 0).toFixed(2)),
    leverage,
    equity:                 parseFloat(equity.toFixed(2)),
    limits,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FORMAT HELPERS — for Telegram alerts
// ═══════════════════════════════════════════════════════════════════════════

function formatSizerAlert(result, ticker) {
  const lines = [];

  if (result.warnings.length > 0) {
    lines.push(`⚠️ <b>POSITION SIZER WARNING — ${ticker}</b>`);
    for (const w of result.warnings) lines.push(`  ${w}`);
  }

  if (result.blocks.length > 0) {
    if (result.allowed) {
      lines.push(`🔶 <b>POSITION CLAMPED — ${ticker}</b>`);
    } else {
      lines.push(`🛑 <b>POSITION BLOCKED — ${ticker}</b>`);
    }
    for (const b of result.blocks) lines.push(`  ${b}`);
  }

  if (result.allowed && result.clampedQty !== result.originalQty) {
    lines.push(`📐 Qty: ${result.originalQty} → ${result.clampedQty} shares`);
    lines.push(`💰 Notional: $${result.finalNotional.toFixed(0)} (${result.finalPctOfEquity}% of $${result.equity.toFixed(0)} equity)`);
  }

  lines.push(`📊 Sector: ${result.sector} (${result.sectorExposureBefore}% → ${result.sectorExposureAfter}%)`);
  lines.push(`<i>Position Sizer v1.0 (C-6 audit fix)</i>`);

  return lines.join('\n');
}

// Export for use in n8n Code nodes (copy-paste the functions needed)
// In n8n, these are inlined — this file serves as the canonical reference.
