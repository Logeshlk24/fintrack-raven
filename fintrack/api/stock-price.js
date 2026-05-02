// api/stock-price.js  ── Vercel serverless function
// Place this file at:  /api/stock-price.js  in your project root
// Strategy:
//   1. Fetch PRICE from the reliable v8/chart API (same as before — was working)
//   2. Fetch FUNDAMENTALS (PE, Beta, Sector, Cap) from quoteSummary in parallel
//   3. Merge both results — if quoteSummary fails, price still works fine

const HEADERS_1 = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://finance.yahoo.com/",
  "Origin": "https://finance.yahoo.com",
};

const HEADERS_2 = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json",
  "Referer": "https://finance.yahoo.com/",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "Missing ticker param" });

  const tickers = ticker.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
  if (tickers.length === 0) return res.status(400).json({ error: "No valid tickers" });

  const results = await Promise.all(tickers.map(t => fetchOne(t)));

  const output = {};
  tickers.forEach((t, i) => { output[t] = results[i]; });

  return res.status(200).json(output);
}

// ─── Main fetch: price + fundamentals in parallel ────────────────────────────
async function fetchOne(ticker) {
  const [priceData, fundData] = await Promise.all([
    fetchPrice(ticker),
    fetchFundamentals(ticker),
  ]);

  if (!priceData.ok) return { ok: false, ticker };

  return {
    ...priceData,
    // Merge fundamentals — null if quoteSummary failed (price still works)
    pe:        fundData?.pe        ?? null,
    beta:      fundData?.beta      ?? null,
    sector:    fundData?.sector    ?? null,
    industry:  fundData?.industry  ?? null,
    cap:       fundData?.cap       ?? null,
    marketCap: fundData?.marketCap ?? null,
  };
}

// ─── PRICE: v8/chart API — same reliable endpoint as original ────────────────
async function fetchPrice(ticker) {
  // Try query1 first, then query2 as fallback
  for (const [host, headers] of [["query1", HEADERS_1], ["query2", HEADERS_2]]) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d&includePrePost=false`;
      const res = await fetch(url, { headers });
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
        price:    +price.toFixed(2),
        change,
        changePct,
        currency,
        exchange: meta.exchangeName || "",
        name:     meta.longName || meta.shortName || ticker,
      };
    } catch (_) { continue; }
  }
  return { ok: false, ticker };
}

// ─── FUNDAMENTALS: quoteSummary — graceful fail, never breaks price ──────────
async function fetchFundamentals(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price%2CassetProfile%2CdefaultKeyStatistics%2CsummaryDetail`;
    const res = await fetch(url, { headers: HEADERS_1 });
    if (!res.ok) return null;

    const json = await res.json();
    const result = json?.quoteSummary?.result?.[0];
    if (!result) return null;

    const price    = result.price                  || {};
    const profile  = result.assetProfile           || {};
    const keyStats = result.defaultKeyStatistics   || {};
    const summary  = result.summaryDetail          || {};

    const currency     = price.currency || "INR";
    const marketCapRaw = price.marketCap?.raw ?? null;
    const quoteType    = price.quoteType || "";
    const isETF        = quoteType === "ETF";

    // PE: trailing preferred, fall back to forward
    const pe   = summary.trailingPE?.raw ?? summary.forwardPE?.raw ?? null;
    // Beta from keyStats or summaryDetail
    const beta = keyStats.beta?.raw ?? summary.beta?.raw ?? null;
    // Sector from assetProfile
    const sector   = isETF ? "ETF" : (profile.sector   || null);
    const industry = isETF ? "ETF" : (profile.industry || null);
    // Market cap classification
    const cap = isETF ? "ETF" : classifyCap(marketCapRaw, currency);

    return {
      pe:        pe   != null ? +pe.toFixed(2)   : null,
      beta:      beta != null ? +beta.toFixed(2) : null,
      sector,
      industry,
      cap,
      marketCap: marketCapRaw,
    };
  } catch (_) {
    return null; // fundamentals failed — price still returned fine
  }
}

// ─── Classify market cap by currency ─────────────────────────────────────────
function classifyCap(marketCapRaw, currency) {
  if (!marketCapRaw) return null;
  if (currency === "INR") {
    const cr = marketCapRaw / 1e7; // to Crore
    if (cr >= 20000) return "Large";
    if (cr >= 5000)  return "Mid";
    return "Small";
  } else {
    const b = marketCapRaw / 1e9; // to Billion USD
    if (b >= 10) return "Large";
    if (b >= 2)  return "Mid";
    return "Small";
  }
}
