// /api/stock-history.js  — Vercel serverless function
// Fetches monthly historical OHLC data from Yahoo Finance
// Usage: /api/stock-history?ticker=%5ENSEI&range=10y&interval=1mo

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker, range = "10y", interval = "1mo" } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  const VALID_RANGES    = ["1y","2y","3y","5y","10y","ytd","max"];
  const VALID_INTERVALS = ["1d","1wk","1mo","3mo"];
  const safeRange    = VALID_RANGES.includes(range)    ? range    : "10y";
  const safeInterval = VALID_INTERVALS.includes(interval) ? interval : "1mo";

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=${safeRange}&interval=${safeInterval}&includePrePost=false&events=div%7Csplit`;

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });

    if (!r.ok) return res.status(r.status).json({ error: "Yahoo error " + r.status });

    const json = await r.json();
    const result = json?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: "No data" });

    const timestamps = result.timestamps || result.timestamp || [];
    const closes     = result.indicators?.quote?.[0]?.close || [];

    const prices = timestamps
      .map((ts, i) => ({ date: ts, close: closes[i] }))
      .filter(p => p.close != null && !isNaN(p.close));

    return res.status(200).json({
      ticker,
      range: safeRange,
      interval: safeInterval,
      prices,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Internal error" });
  }
}
