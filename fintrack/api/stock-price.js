// api/stock-price.js  ── Vercel serverless function
// Place this file at:  /api/stock-price.js  in your project root
// Fetches live prices + fundamentals (PE, Beta, Sector, Market Cap) from Yahoo Finance
// — server-side, no CORS, no API key needed.

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://finance.yahoo.com/",
  "Origin": "https://finance.yahoo.com",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "Missing ticker param" });

  const tickers = ticker.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
  if (tickers.length === 0) return res.status(400).json({ error: "No valid tickers" });

  // Fetch all tickers in parallel
  const results = await Promise.all(tickers.map(t => fetchOne(t)));

  const output = {};
  tickers.forEach((t, i) => { output[t] = results[i]; });

  return res.status(200).json(output);
}

// ─── Classify market cap (in USD or INR, both supported) ────────────────────
function classifyCap(marketCapRaw, currency) {
  if (!marketCapRaw) return null;
  // Yahoo returns market cap in local currency
  // Indian stocks: Large >20,000 Cr, Mid 5,000–20,000 Cr, Small <5,000 Cr
  // US stocks:     Large >10B USD, Mid 2B–10B, Small <2B
  const isIndian = currency === "INR";
  if (isIndian) {
    const cr = marketCapRaw / 1e7; // convert to Crore
    if (cr >= 20000) return "Large";
    if (cr >= 5000)  return "Mid";
    return "Small";
  } else {
    const b = marketCapRaw / 1e9; // Billions USD
    if (b >= 10)  return "Large";
    if (b >= 2)   return "Mid";
    return "Small";
  }
}

// ─── Fetch price + fundamentals using quoteSummary ──────────────────────────
async function fetchOne(ticker) {
  try {
    // quoteSummary gives us PE, Beta, Sector, Industry, Market Cap all at once
    const summaryUrl = `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price%2CassetProfile%2CdefaultKeyStatistics%2CsummaryDetail`;

    const res = await fetch(summaryUrl, { headers: YF_HEADERS });

    if (!res.ok) return await fetchOneFallback(ticker);

    const json = await res.json();
    const result = json?.quoteSummary?.result?.[0];
    if (!result) return await fetchOneFallback(ticker);

    const price      = result.price            || {};
    const profile    = result.assetProfile     || {};
    const keyStats   = result.defaultKeyStatistics || {};
    const summary    = result.summaryDetail    || {};

    const currentPrice = price.regularMarketPrice?.raw ?? null;
    if (currentPrice == null) return await fetchOneFallback(ticker);

    const prevClose   = price.regularMarketPreviousClose?.raw ?? currentPrice;
    const change      = +(currentPrice - prevClose).toFixed(2);
    const changePct   = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;
    const currency    = price.currency || "INR";
    const marketCapRaw = price.marketCap?.raw ?? null;

    // PE: prefer trailing PE, fall back to forward PE
    const pe = summary.trailingPE?.raw ?? summary.forwardPE?.raw ?? null;

    // Beta from key stats
    const beta = keyStats.beta?.raw ?? summary.beta?.raw ?? null;

    // Sector & Industry from assetProfile
    const sector   = profile.sector   || null;
    const industry = profile.industry || null;

    // Market Cap classification
    const cap = classifyCap(marketCapRaw, currency);

    // Detect ETFs (no sector in profile + quoteType is ETF)
    const quoteType = price.quoteType || "";
    const isETF = quoteType === "ETF" || (!sector && !pe && !beta);

    return {
      ok: true,
      ticker,
      price: +currentPrice.toFixed(2),
      change,
      changePct,
      currency,
      exchange: price.exchangeName || "",
      name: price.longName || price.shortName || ticker,
      // ── Fundamentals (new fields used by PortfolioAnalysisView) ──
      pe:        pe   != null ? +pe.toFixed(2)   : null,
      beta:      beta != null ? +beta.toFixed(2) : null,
      sector:    isETF ? "ETF" : sector,
      industry,
      cap:       isETF ? "ETF" : cap,
      marketCap: marketCapRaw,
    };
  } catch (e) {
    try { return await fetchOneFallback(ticker); } catch (_) {}
    return { ok: false, ticker, error: e.message };
  }
}

// ─── Fallback: chart API (price only, no fundamentals) ──────────────────────
async function fetchOneFallback(ticker) {
  // Try query1 first, then query2
  for (const host of ["query1", "query2"]) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d&includePrePost=false`;
      const res = await fetch(url, { headers: YF_HEADERS });
      if (!res.ok) continue;

      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;

      const meta = result.meta;
      const price = meta.regularMarketPrice ?? meta.previousClose ?? null;
      if (price == null) continue;

      const prevClose = meta.chartPreviousClose ?? meta.regularMarketPreviousClose ?? meta.previousClose ?? price;
      const change    = +(price - prevClose).toFixed(2);
      const changePct = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;
      const currency  = meta.currency || "INR";

      return {
        ok: true,
        ticker,
        price: +price.toFixed(2),
        change,
        changePct,
        currency,
        exchange: meta.exchangeName || "",
        name: meta.longName || meta.shortName || ticker,
        // Fundamentals unavailable in chart API — return nulls
        pe: null, beta: null, sector: null, industry: null, cap: null, marketCap: null,
      };
    } catch (_) { continue; }
  }
  return { ok: false, ticker };
}
