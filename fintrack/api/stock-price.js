// api/stock-price.js  ── Vercel serverless function
// Fetches live prices AND fundamentals (PE, beta, sector, marketCap/cap).

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

// ── Classify market cap ──────────────────────────────────────────────────────
function classifyCap(marketCapUSD, ticker) {
  // ETFs (common suffixes)
  if (/ETF|BEES|IETF|NIFBEES/i.test(ticker)) return "ETF";
  if (!marketCapUSD) return null;
  // INR tickers: Yahoo returns marketCap in local currency (INR), not USD
  // Use rough thresholds in USD (Yahoo always returns USD-equivalent for non-INR? No — for .NS/.BO it returns INR)
  // We'll use INR thresholds for Indian tickers and USD for US tickers
  const isIndian = ticker.endsWith(".NS") || ticker.endsWith(".BO");
  if (isIndian) {
    // INR: Large >₹20,000 Cr (~$2.4B), Mid ₹5,000–20,000 Cr, Small <₹5,000 Cr
    const cr = marketCapUSD / 1e7; // Yahoo gives INR value in rupees; convert to Crore
    if (cr >= 20000) return "Large";
    if (cr >= 5000)  return "Mid";
    return "Small";
  } else {
    // USD: Large >$10B, Mid $2B–$10B, Small <$2B
    if (marketCapUSD >= 10e9)  return "Large";
    if (marketCapUSD >= 2e9)   return "Mid";
    return "Small";
  }
}

const HEADERS_V1 = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://finance.yahoo.com/",
  "Origin": "https://finance.yahoo.com",
};

// ── Fetch fundamentals from Yahoo quoteSummary ───────────────────────────────
async function fetchFundamentals(ticker) {
  const modules = "summaryDetail,defaultKeyStatistics,assetProfile,quoteType";
  const url = `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}`;
  try {
    const res = await fetch(url, { headers: HEADERS_V1 });
    if (!res.ok) {
      // fallback to query2
      const res2 = await fetch(
        `https://query2.finance.yahoo.com/v11/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}`,
        { headers: { "User-Agent": HEADERS_V1["User-Agent"], "Accept": "application/json", "Referer": "https://finance.yahoo.com/" } }
      );
      if (!res2.ok) return {};
      const j2 = await res2.json();
      return parseFundamentals(j2, ticker);
    }
    const json = await res.json();
    return parseFundamentals(json, ticker);
  } catch {
    return {};
  }
}

function parseFundamentals(json, ticker) {
  const r = json?.quoteSummary?.result?.[0];
  if (!r) return {};

  const sd  = r.summaryDetail      || {};
  const ks  = r.defaultKeyStatistics || {};
  const ap  = r.assetProfile        || {};
  const qt  = r.quoteType           || {};

  const pe        = sd.trailingPE?.raw         ?? ks.trailingEps?.raw ? null : null;
  // trailingPE lives in summaryDetail
  const trailingPE = sd.trailingPE?.raw ?? null;
  const beta       = sd.beta?.raw ?? ks.beta?.raw ?? null;
  const sector     = ap.sector   || null;
  const industry   = ap.industry || null;
  const marketCap  = sd.marketCap?.raw ?? ks.enterpriseValue?.raw ?? null;
  const quoteType  = qt.quoteType || "";

  // ETF check via quoteType
  const isETF = quoteType === "ETF" || /ETF|BEES|NIFBEES/i.test(ticker);
  const cap   = isETF ? "ETF" : classifyCap(marketCap, ticker);

  return {
    pe:        trailingPE !== null ? +trailingPE.toFixed(2) : null,
    beta:      beta       !== null ? +beta.toFixed(2)       : null,
    sector:    sector,
    industry:  industry,
    marketCap: marketCap,
    cap:       cap,
  };
}

// ── Main fetch: price + fundamentals ────────────────────────────────────────
async function fetchOne(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d&includePrePost=false`;

  try {
    const res = await fetch(url, { headers: HEADERS_V1 });

    if (!res.ok) return await fetchOneV2(ticker);

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return await fetchOneV2(ticker);

    const meta = result.meta;
    const price = meta.regularMarketPrice ?? meta.previousClose ?? null;
    if (price == null) return { ok: false, ticker };

    const prevClose = meta.chartPreviousClose ?? meta.regularMarketPreviousClose ?? meta.previousClose ?? price;
    const change    = +(price - prevClose).toFixed(2);
    const changePct = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;

    // Fetch fundamentals in parallel (non-blocking — if it fails we still return price)
    const fund = await fetchFundamentals(ticker);

    return {
      ok: true,
      ticker,
      price: +price.toFixed(2),
      change,
      changePct,
      currency: meta.currency || "INR",
      exchange: meta.exchangeName || "",
      name: meta.longName || meta.shortName || ticker,
      // Fundamentals
      pe:        fund.pe        ?? null,
      beta:      fund.beta      ?? null,
      sector:    fund.sector    ?? null,
      industry:  fund.industry  ?? null,
      marketCap: fund.marketCap ?? null,
      cap:       fund.cap       ?? null,
    };
  } catch (e) {
    try { return await fetchOneV2(ticker); } catch (_) {}
    return { ok: false, ticker, error: e.message };
  }
}

async function fetchOneV2(ticker) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json",
      "Referer": "https://finance.yahoo.com/",
    },
  });
  if (!res.ok) return { ok: false, ticker };
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) return { ok: false, ticker };
  const meta = result.meta;
  const price = meta.regularMarketPrice ?? meta.previousClose ?? null;
  if (price == null) return { ok: false, ticker };
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const change    = +(price - prevClose).toFixed(2);
  const changePct = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;

  const fund = await fetchFundamentals(ticker);

  return {
    ok: true,
    ticker,
    price: +price.toFixed(2),
    change,
    changePct,
    currency: meta.currency || "INR",
    exchange: meta.exchangeName || "",
    name: meta.longName || meta.shortName || ticker,
    pe:        fund.pe        ?? null,
    beta:      fund.beta      ?? null,
    sector:    fund.sector    ?? null,
    industry:  fund.industry  ?? null,
    marketCap: fund.marketCap ?? null,
    cap:       fund.cap       ?? null,
  };
}
