// api/stock-price.js — Vercel Serverless Function
// Returns price + fundamentals (PE, Beta, sector, marketCap) via Yahoo Finance v7/v8
// GET /api/stock-price?ticker=INFY.NS,TCS.NS,AAPL
// GET /api/stock-price?ticker=INFY.NS&fundamentals=1  (include PE/Beta/sector)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker, fundamentals } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker param required" });

  const tickers = String(ticker).split(",").map(t => t.trim()).filter(Boolean).slice(0, 30);
  const includeFundamentals = fundamentals === "1";
  const results = {};

  await Promise.allSettled(tickers.map(async (t) => {
    // ── Yahoo Finance v7 /quote — prices + basic fundamentals ────────────────
    const fields = [
      "regularMarketPrice","regularMarketPreviousClose","regularMarketChangePercent",
      "currency","trailingPE","beta","sector","marketCap","shortName",
      "fiftyTwoWeekHigh","fiftyTwoWeekLow",
    ].join(",");

    const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
    for (const host of hosts) {
      try {
        const url = `https://${host}/v7/finance/quote?symbols=${encodeURIComponent(t)}&fields=${fields}`;
        const r = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
            "Accept": "application/json",
            "Referer": "https://finance.yahoo.com",
          },
        });
        if (!r.ok) continue;
        const d = await r.json();
        const q = d?.quoteResponse?.result?.[0];
        if (!q || q.regularMarketPrice == null) continue;

        const price = q.regularMarketPrice;
        const prev  = q.regularMarketPreviousClose ?? null;

        // Market cap → cap category
        const mcap = q.marketCap ?? null;
        let capCategory = null;
        if (mcap != null) {
          // Indian: Large >20000Cr, Mid 5000-20000Cr, Small <5000Cr
          // US: Large >10B, Mid 2-10B, Small <2B
          const isIndian = t.endsWith(".NS") || t.endsWith(".BO");
          if (isIndian) {
            const crore = mcap / 1e7;
            capCategory = crore >= 20000 ? "Large" : crore >= 5000 ? "Mid" : "Small";
          } else {
            capCategory = mcap >= 10e9 ? "Large" : mcap >= 2e9 ? "Mid" : "Small";
          }
        }

        results[t] = {
          ok: true,
          price,
          prevClose: prev,
          change:    prev != null ? +(price - prev).toFixed(2) : null,
          changePct: q.regularMarketChangePercent != null ? +q.regularMarketChangePercent.toFixed(2) : null,
          currency:  q.currency ?? "INR",
          symbol:    q.symbol ?? t,
          // Fundamentals
          pe:        q.trailingPE   != null ? +q.trailingPE.toFixed(1)  : null,
          beta:      q.beta         != null ? +q.beta.toFixed(2)        : null,
          sector:    q.sector       ?? null,
          marketCap: mcap,
          cap:       capCategory,
          name:      q.shortName    ?? null,
          week52High: q.fiftyTwoWeekHigh ?? null,
          week52Low:  q.fiftyTwoWeekLow  ?? null,
        };
        return;
      } catch { /* try next host */ }
    }

    // Fallback: v8 chart (prices only, no fundamentals)
    try {
      const r = await fetch(
        `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=1d`,
        { headers: { "User-Agent": "python-requests/2.31.0", "Accept": "application/json" } }
      );
      if (r.ok) {
        const d = await r.json();
        const meta = d?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice != null) {
          const price = meta.regularMarketPrice;
          const prev  = meta.chartPreviousClose ?? meta.previousClose ?? null;
          results[t] = {
            ok: true, price, prevClose: prev,
            change:    prev != null ? +(price - prev).toFixed(2) : null,
            changePct: prev != null ? +((price-prev)/prev*100).toFixed(2) : null,
            currency: meta.currency ?? "INR",
            symbol: meta.symbol ?? t,
            pe: null, beta: null, sector: null, cap: null, marketCap: null,
          };
          return;
        }
      }
    } catch {}

    results[t] = { ok: false, reason: "all_sources_failed" };
  }));

  return res.status(200).json(results);
}
