// api/stock-price.js  ── Vercel serverless function
// Place this file at:  /api/stock-price.js  in your project root
//
// Uses Yahoo Finance /v7/finance/quote which returns price + PE + beta +
// sector + marketCap in a single reliable call. No session/cookie needed.

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
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

  // Yahoo /v7/finance/quote accepts comma-separated symbols in one call
  // Split into chunks of 20 to stay within URL limits
  const chunks = [];
  for (let i = 0; i < tickers.length; i += 20) {
    chunks.push(tickers.slice(i, i + 20));
  }

  const allResults = {};
  await Promise.all(chunks.map(async (chunk) => {
    const data = await fetchQuoteChunk(chunk);
    Object.assign(allResults, data);
  }));

  // Make sure every requested ticker has an entry
  const output = {};
  tickers.forEach(t => {
    output[t] = allResults[t] || { ok: false, ticker: t };
  });

  return res.status(200).json(output);
}

// ─── Fetch a batch of tickers via /v7/finance/quote ─────────────────────────
async function fetchQuoteChunk(tickers) {
  const symbols = tickers.join(",");

  // Try both query1 and query2
  for (const host of ["query1", "query2"]) {
    try {
      const url = `https://${host}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketPreviousClose,regularMarketChange,regularMarketChangePercent,trailingPE,forwardPE,beta,marketCap,currency,exchangeName,longName,shortName,quoteType,sector,industry`;
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) continue;

      const json = await res.json();
      const quotes = json?.quoteResponse?.result;
      if (!Array.isArray(quotes)) continue;

      const result = {};
      quotes.forEach(q => {
        const ticker   = q.symbol;
        const price    = q.regularMarketPrice ?? null;
        const prevClose = q.regularMarketPreviousClose ?? price;
        const change   = q.regularMarketChange   != null ? +q.regularMarketChange.toFixed(2)          : price != null ? +(price - prevClose).toFixed(2) : 0;
        const changePct = q.regularMarketChangePercent != null ? +q.regularMarketChangePercent.toFixed(2) : 0;
        const currency = q.currency || "INR";
        const isETF    = q.quoteType === "ETF";

        // PE: trailing preferred over forward
        const pe   = q.trailingPE  != null ? +q.trailingPE.toFixed(2)
                   : q.forwardPE   != null ? +q.forwardPE.toFixed(2)
                   : null;
        const beta = q.beta        != null ? +q.beta.toFixed(2) : null;

        // Market cap → Large / Mid / Small
        const cap = isETF ? "ETF" : classifyCap(q.marketCap, currency);

        result[ticker] = {
          ok:        price != null,
          ticker,
          price:     price != null ? +price.toFixed(2) : null,
          change,
          changePct,
          currency,
          exchange:  q.exchangeName || "",
          name:      q.longName || q.shortName || ticker,
          // ── Fundamentals ──
          pe,
          beta,
          sector:    isETF ? "ETF"      : (q.sector   || null),
          industry:  isETF ? "ETF"      : (q.industry || null),
          cap,
          marketCap: q.marketCap || null,
        };
      });

      // Mark any ticker that Yahoo didn't return as failed
      tickers.forEach(t => {
        if (!result[t]) result[t] = { ok: false, ticker: t };
      });

      return result;
    } catch (_) { continue; }
  }

  // Both hosts failed — return all as failed
  const failed = {};
  tickers.forEach(t => { failed[t] = { ok: false, ticker: t }; });
  return failed;
}

// ─── Classify market cap ─────────────────────────────────────────────────────
function classifyCap(marketCapRaw, currency) {
  if (!marketCapRaw) return null;
  if (currency === "INR") {
    const cr = marketCapRaw / 1e7; // rupees → crore
    if (cr >= 20000) return "Large";
    if (cr >= 5000)  return "Mid";
    return "Small";
  } else {
    const b = marketCapRaw / 1e9; // → billion USD
    if (b >= 10) return "Large";
    if (b >= 2)  return "Mid";
    return "Small";
  }
}
