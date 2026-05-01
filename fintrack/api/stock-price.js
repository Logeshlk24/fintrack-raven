// api/stock-price.js
// Vercel Serverless Function — fetches Yahoo Finance server-side (no CORS)
// Usage: GET /api/stock-price?ticker=INFY.NS
//        GET /api/stock-price?ticker=INFY.NS,TCS.NS,RELIANCE.NS  (batch)

export default async function handler(req, res) {
  // Allow your Vercel app to call this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker param required" });

  const tickers = ticker.split(",").map(t => t.trim()).filter(Boolean).slice(0, 20); // max 20

  const results = {};

  await Promise.all(tickers.map(async (t) => {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=1d&includePrePost=false`;
      const response = await fetch(url, {
        headers: {
          // Mimic a browser request so Yahoo doesn't block us
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://finance.yahoo.com",
          "Origin": "https://finance.yahoo.com",
        },
      });

      if (!response.ok) {
        results[t] = { ok: false, status: response.status };
        return;
      }

      const json = await response.json();
      const meta = json?.chart?.result?.[0]?.meta;

      if (!meta || meta.regularMarketPrice == null) {
        results[t] = { ok: false, reason: "no data" };
        return;
      }

      const price = meta.regularMarketPrice;
      const prev  = meta.chartPreviousClose ?? meta.previousClose ?? null;

      results[t] = {
        ok:        true,
        price,
        prevClose: prev,
        change:    prev != null ? price - prev : null,
        changePct: prev != null ? ((price - prev) / prev) * 100 : null,
        currency:  meta.currency ?? "INR",
        symbol:    meta.symbol,
      };
    } catch (e) {
      results[t] = { ok: false, reason: e.message };
    }
  }));

  return res.status(200).json(results);
}
