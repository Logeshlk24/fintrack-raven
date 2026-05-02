// api/stock-fundamentals.js  ── Vercel serverless function
// Place at: /api/stock-fundamentals.js
// Fetches PE, Beta, Sector, MarketCap for the Analysis tab.
// Called SEPARATELY from stock-price.js so a failure here never breaks prices.
//
// Uses Yahoo Finance v10/quoteSummary on query2 host (more permissive than query1)

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://finance.yahoo.com/quote/",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "Missing ticker" });

  const tickers = ticker.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) return res.status(400).json({ error: "No valid tickers" });

  // Fetch one at a time with a tiny stagger to avoid rate-limiting
  const output = {};
  for (let i = 0; i < tickers.length; i++) {
    if (i > 0) await sleep(120); // 120ms between calls
    output[tickers[i]] = await fetchFundamentals(tickers[i]);
  }

  return res.status(200).json(output);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchFundamentals(ticker) {
  // Try query2 first (less restricted), then query1
  for (const host of ["query2", "query1"]) {
    try {
      const url = `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}`
        + `?modules=summaryDetail%2CdefaultKeyStatistics%2CassetProfile%2CfinancialData%2Cprice`;

      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) continue;

      const json = await res.json();
      const r = json?.quoteSummary?.result?.[0];
      if (!r) continue;

      const price    = r.price                 || {};
      const summary  = r.summaryDetail         || {};
      const keyStats = r.defaultKeyStatistics  || {};
      const profile  = r.assetProfile          || {};

      const currency     = price.currency || "INR";
      const quoteType    = price.quoteType || "";
      const isETF        = quoteType === "ETF";
      const marketCapRaw = price.marketCap?.raw ?? summary.marketCap?.raw ?? null;

      const pe   = summary.trailingPE?.raw  ?? summary.forwardPE?.raw  ?? keyStats.forwardPE?.raw  ?? null;
      const beta = keyStats.beta?.raw       ?? summary.beta?.raw        ?? null;

      return {
        ok:        true,
        ticker,
        pe:        pe   != null ? +Number(pe).toFixed(2)   : null,
        beta:      beta != null ? +Number(beta).toFixed(2) : null,
        sector:    isETF ? "ETF" : (profile.sector   || null),
        industry:  isETF ? "ETF" : (profile.industry || null),
        cap:       isETF ? "ETF" : classifyCap(marketCapRaw, currency),
        marketCap: marketCapRaw,
      };
    } catch (_) { continue; }
  }

  return { ok: false, ticker };
}

function classifyCap(raw, currency) {
  if (!raw) return null;
  if (currency === "INR") {
    const cr = raw / 1e7;
    if (cr >= 20000) return "Large";
    if (cr >= 5000)  return "Mid";
    return "Small";
  }
  const b = raw / 1e9;
  if (b >= 10) return "Large";
  if (b >= 2)  return "Mid";
  return "Small";
}
