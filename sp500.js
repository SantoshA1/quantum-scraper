/* ─────────────────────────────────────────────────────────────
 *  S&P 500 Ticker Whitelist  (Audit Fix C-2)
 *  Canonical constituent set as of April 2026.
 *  Override / extend via env vars:
 *    SP500_EXTRA_TICKERS  — comma-separated additional tickers
 *    SP500_TICKERS_FILE   — path to a newline-separated file
 * ───────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');

// ── S&P 500 constituents + approved ETFs/equities ────────────
const DEFAULT_TICKERS = [
  'A','AAL','AAPL','ABBV','ABNB','ABT','ACGL','ACN','ADBE','ADI',
  'ADM','ADP','ADSK','AEE','AEP','AES','AFL','AIG','AIZ','AJG',
  'AKAM','ALB','ALGN','ALK','ALL','ALLE','AMAT','AMCR','AMD','AME',
  'AMGN','AMP','AMT','AMZN','ANET','ANSS','AON','AOS','APA','APD',
  'APH','APTV','ARE','ATO','ATVI','AVB','AVGO','AVY','AWK','AXP',
  'AZO','BA','BAC','BAX','BBWI','BBY','BDX','BEN','BF.B','BG',
  'BIIB','BIO','BK','BKNG','BKR','BLK','BMY','BR','BRK.B','BRO',
  'BSX','BWA','BXP','C','CAG','CAH','CARR','CAT','CB','CBOE',
  'CBRE','CCI','CCL','CDAY','CDNS','CDW','CE','CEG','CF','CFG',
  'CHD','CHRW','CHTR','CI','CINF','CL','CLX','CMA','CMCSA','CME',
  'CMG','CMI','CMS','CNC','CNP','COF','COO','COP','COST','CPB',
  'CPRT','CPT','CRL','CRM','CRWD','CSCO','CSGP','CSX','CTAS','CTLT',
  'CTRA','CTSH','CTVA','CVS','CVX','CZR','D','DAL','DD','DE',
  'DECK','DFS','DG','DGX','DHI','DHR','DIS','DISH','DLTR','DOV',
  'DOW','DPZ','DRI','DTE','DUK','DVA','DVN','DXC','DXCM','EA',
  'EBAY','ECL','ED','EFX','EIX','EL','EMN','EMR','ENPH','EOG',
  'EPAM','EQIX','EQR','EQT','ES','ESS','ETN','ETR','ETSY','EVRG',
  'EW','EXC','EXPD','EXPE','EXR','F','FANG','FAST','FBHS','FCX',
  'FDS','FDX','FE','FFIV','FIS','FISV','FITB','FLT','FMC','FOX',
  'FOXA','FRT','FTNT','FTV','GD','GE','GEHC','GEN','GILD','GIS',
  'GL','GLW','GM','GNRC','GOOG','GOOGL','GPC','GPN','GRMN','GS',
  'GWW','HAL','HAS','HBAN','HCA','PEAK','HES','HIG','HII','HLT',
  'HOLX','HON','HPE','HPQ','HRL','HSIC','HST','HSY','HUM','HWM',
  'IBM','ICE','IDXX','IEX','IFF','ILMN','INCY','INTC','INTU','INVH',
  'IP','IPG','IQV','IR','IRM','ISRG','IT','ITW','IVZ','J',
  'JBHT','JCI','JKHY','JNJ','JNPR','JPM','K','KDP','KEY','KEYS',
  'KHC','KIM','KLAC','KMB','KMI','KMX','KO','KR','KVUE','L',
  'LDOS','LEN','LH','LHX','LIN','LKQ','LLY','LMT','LNT','LOW',
  'LRCX','LULU','LUV','LVS','LW','LYB','LYV','MA','MAA','MAR',
  'MAS','MCD','MCHP','MCK','MCO','MDLZ','MDT','MET','META','MGM',
  'MHK','MKC','MKTX','MLM','MMC','MMM','MNST','MO','MOH','MOS',
  'MPC','MPWR','MRK','MRNA','MRO','MS','MSCI','MSFT','MSI','MTB',
  'MTCH','MTD','MU','NCLH','NDAQ','NDSN','NEE','NEM','NFLX','NI',
  'NKE','NOC','NOW','NRG','NSC','NTAP','NTRS','NUE','NVDA','NVR',
  'NWL','NWS','NWSA','NXPI','O','ODFL','OGN','OKE','OMC','ON',
  'ORCL','ORLY','OTIS','OXY','PANW','PARA','PAYC','PAYX','PCAR','PCG',
  'PEG','PEP','PFE','PFG','PG','PGR','PH','PHM','PKG','PKI',
  'PLD','PM','PNC','PNR','PNW','POOL','PPG','PPL','PRU','PSA',
  'PSX','PTC','PVH','PWR','PXD','PYPL','QCOM','QRVO','RCL','RE',
  'REG','REGN','RF','RHI','RJF','RL','RMD','ROK','ROL','ROP',
  'ROST','RSG','RTX','RVTY','SBAC','SBUX','SCHW','SEE','SHW','SJM',
  'SLB','SMCI','SNA','SNPS','SO','SPG','SPGI','SRE','STE','STLD',
  'STT','STX','STZ','SWK','SWKS','SYF','SYK','SYY','T','TAP',
  'TDG','TDY','TECH','TEL','TER','TFC','TFX','TGT','TJX','TMO',
  'TMUS','TPR','TRGP','TRMB','TROW','TRV','TSCO','TSLA','TSN','TT',
  'TTWO','TXN','TXT','TYL','UAL','UDR','UHS','ULTA','UNH','UNP',
  'UPS','URI','USB','V','VFC','VICI','VLO','VLTO','VMC','VRSN',
  'VRTX','VTR','VTRS','VZ','WAB','WAT','WBA','WBD','WDC','WEC',
  'WELL','WFC','WHR','WM','WMB','WMT','WRB','WRK','WST','WTW',
  'WY','WYNN','XEL','XOM','XRAY','XYL','YUM','ZBH','ZBRA','ZION',
  'ZTS',
  // ETFs actively traded by the pipeline
  'SPY','QQQ','IWM','DIA','SQQQ','TQQQ','UVXY','VXX','SPXU','SDS',
  // Additional equities in the current portfolio / watchlist
  'IONQ','PLTR','SOFI','HOOD','RIVN','LCID','MARA','RIOT','COIN',
  'SNOW','DDOG','NET','ZS','OKTA','MDB','BILL','HUBS','VEEV','TEAM',
  'ABNB','DASH','RBLX','U','PATH','S','CFLT','MNDY',
];

// ── Build ticker Set (merge env overrides) ───────────────────
function buildTickerSet() {
  const set = new Set(DEFAULT_TICKERS.map(t => t.toUpperCase().trim()));

  // Extra tickers from env (comma-separated)
  if (process.env.SP500_EXTRA_TICKERS) {
    process.env.SP500_EXTRA_TICKERS.split(',')
      .map(t => t.trim().toUpperCase())
      .filter(Boolean)
      .forEach(t => set.add(t));
  }

  // Extra tickers from file
  if (process.env.SP500_TICKERS_FILE) {
    try {
      const raw = fs.readFileSync(process.env.SP500_TICKERS_FILE, 'utf8');
      raw.split(/[\n,]+/)
        .map(t => t.trim().toUpperCase())
        .filter(Boolean)
        .forEach(t => set.add(t));
      console.log(`[WHITELIST] Loaded tickers from file: ${process.env.SP500_TICKERS_FILE}`);
    } catch (err) {
      console.error(`[WHITELIST] Failed to load tickers file: ${err.message}`);
    }
  }

  console.log(`[WHITELIST] ${set.size} tickers whitelisted`);
  return set;
}

const VALID_TICKERS = buildTickerSet();

// ── Validation helper ────────────────────────────────────────
/**
 * Validate and normalize a ticker string.
 * @param {*} raw - The raw ticker input
 * @returns {{ valid: true, ticker: string } | { valid: false, reason: string }}
 */
function validateTicker(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { valid: false, reason: 'Ticker is required.' };
  }
  if (typeof raw !== 'string') {
    return { valid: false, reason: 'Ticker must be a string.' };
  }

  const ticker = raw.trim().toUpperCase();

  if (ticker.length === 0 || ticker.length > 10) {
    return { valid: false, reason: 'Ticker must be 1-10 characters.' };
  }
  if (!/^[A-Z0-9.]{1,10}$/.test(ticker)) {
    return { valid: false, reason: 'Ticker contains invalid characters. Only letters, digits, and dots are allowed.' };
  }
  if (!VALID_TICKERS.has(ticker)) {
    return { valid: false, reason: `"${ticker}" is not in the approved ticker whitelist (S&P 500 + approved ETFs/equities).` };
  }

  return { valid: true, ticker };
}

module.exports = { validateTicker, VALID_TICKERS };
