// api/stock-price.js
// Vercel Serverless Function — fetches Yahoo Finance server-side (no CORS)
// GET /api/stock-price?ticker=INFY.NS,TCS.NS
// api/stock-price.js  ── Vercel serverless function
// Place this file at:  /api/stock-price.js  in your project root
// Fetches live prices from Yahoo Finance — server-side, no CORS, no API key needed.

export default async function handler(req, res) {
  // Allow browser requests from your domain
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
if (req.method === "OPTIONS") return res.status(200).end();

const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker param required" });
  if (!ticker) return res.status(400).json({ error: "Missing ticker param" });

  const tickers = String(ticker)
    .split(",")
    .map(t => t.trim())
    .filter(Boolean)
    .slice(0, 20);
  const tickers = ticker.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
  if (tickers.length === 0) return res.status(400).json({ error: "No valid tickers" });

  const results = {};
  // Fetch all tickers in parallel
  const results = await Promise.all(tickers.map(t => fetchOne(t)));

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
  const output = {};
  tickers.forEach((t, i) => { output[t] = results[i]; });

          if (!response.ok) {
            if (response.status === 429 || response.status === 403) continue;
            results[t] = { ok: false, status: response.status };
            return;
          }
  return res.status(200).json(output);
}

async function fetchOne(ticker) {
  // Yahoo Finance v8 chart API — free, no key, works server-side
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d&includePrePost=false`;

  try {
    const res = await fetch(url, {
      headers: {
        // Mimic a browser request so Yahoo doesn't block it
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://finance.yahoo.com/",
        "Origin": "https://finance.yahoo.com",
      },
    });

          const json = await response.json();
          const meta = json?.chart?.result?.[0]?.meta;
    if (!res.ok) {
      // Try query2 as fallback
      return await fetchOneV2(ticker);
    }

          if (!meta || meta.regularMarketPrice == null) {
            results[t] = { ok: false, reason: "no_data" };
            return;
          }
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return await fetchOneV2(ticker);

          const price = meta.regularMarketPrice;
          const prev = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const meta = result.meta;
    const price = meta.regularMarketPrice ?? meta.previousClose ?? null;
    if (price == null) return { ok: false, ticker };

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
    const prevClose = meta.chartPreviousClose ?? meta.regularMarketPreviousClose ?? meta.previousClose ?? price;
    const change = +(price - prevClose).toFixed(2);
    const changePct = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;

    return {
      ok: true,
      ticker,
      price: +price.toFixed(2),
      change,
      changePct,
      currency: meta.currency || "INR",
      exchange: meta.exchangeName || "",
      name: meta.longName || meta.shortName || ticker,
    };
  } catch (e) {
    try { return await fetchOneV2(ticker); } catch (_) {}
    return { ok: false, ticker, error: e.message };
  }
}

  return res.status(200).json(results);
// Fallback: Yahoo Finance query2 endpoint
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
  const change = +(price - prevClose).toFixed(2);
  const changePct = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;
  return {
    ok: true,
    ticker,
    price: +price.toFixed(2),
    change,
    changePct,
    currency: meta.currency || "INR",
    exchange: meta.exchangeName || "",
    name: meta.longName || meta.shortName || ticker,
  };
}
