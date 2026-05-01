// api/stock-price.js
// Vercel Serverless Function — fetches Yahoo Finance server-side (no CORS)
// GET /api/stock-price?ticker=INFY.NS,TCS.NS

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker param required" });

  const tickers = String(ticker)
    .split(",")
    .map(t => t.trim())
    .filter(Boolean)
    .slice(0, 20);

  const results = {};

  await Promise.allSettled(
    tickers.map(async (t) => {
      const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
      for (const host of hosts) {
        try {
          const url = `https://${host}/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=1d&includePrePost=false`;
          const response = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "application/json, text/plain, */*",
              "Accept-Language": "en-US,en;q=0.9",
              "Referer": "https://finance.yahoo.com/",
              "Origin": "https://finance.yahoo.com",
            },
          });

          if (!response.ok) {
            if (response.status === 429 || response.status === 403) continue;
            results[t] = { ok: false, status: response.status };
            return;
          }

          const json = await response.json();
          const meta = json?.chart?.result?.[0]?.meta;

          if (!meta || meta.regularMarketPrice == null) {
            results[t] = { ok: false, reason: "no_data" };
            return;
          }

          const price = meta.regularMarketPrice;
          const prev = meta.chartPreviousClose ?? meta.previousClose ?? null;

          results[t] = {
            ok: true,
            price,
            prevClose: prev,
            change: prev != null ? +(price - prev).toFixed(4) : null,
            changePct: prev != null ? +((price - prev) / prev * 100).toFixed(4) : null,
            currency: meta.currency ?? "INR",
            symbol: meta.symbol ?? t,
          };
          return;
        } catch (e) {
          // try next host
        }
      }
      if (!results[t]) results[t] = { ok: false, reason: "fetch_failed" };
    })
  );

  return res.status(200).json(results);
}
