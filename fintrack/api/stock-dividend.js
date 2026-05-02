// api/stock-dividend.js  ── Vercel serverless function
// Fetches dividend data from Yahoo Finance quoteSummary endpoint
// Fields: trailingAnnualDividendRate, dividendYield, exDividendDate, dividendDate, dividendRate

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "Missing ticker param" });

  const tickers = ticker.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
  if (tickers.length === 0) return res.status(400).json({ error: "No valid tickers" });

  // Fetch all in parallel (but cap concurrency to avoid rate limits)
  const BATCH = 5;
  const output = {};
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(t => fetchDividend(t)));
    batch.forEach((t, j) => { output[t] = results[j]; });
  }

  return res.status(200).json(output);
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://finance.yahoo.com/",
  "Origin": "https://finance.yahoo.com",
};

async function fetchDividend(ticker) {
  // Try quoteSummary v10 first (most reliable for dividend fields)
  const modules = "summaryDetail,defaultKeyStatistics,assetProfile";
  const url1 = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}`;
  const url2 = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}`;

  let json = null;
  for (const url of [url1, url2]) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (!r.ok) continue;
      json = await r.json();
      if (json?.quoteSummary?.result?.[0]) break;
    } catch (_) {}
  }

  if (!json?.quoteSummary?.result?.[0]) {
    return { ok: false, ticker };
  }

  const result = json.quoteSummary.result[0];
  const sd = result.summaryDetail || {};
  const ks = result.defaultKeyStatistics || {};

  // Extract dividend fields — Yahoo returns raw values and {raw, fmt} objects
  const raw = v => (v && typeof v === "object" ? v.raw : v) ?? null;

  const dividendRate              = raw(sd.dividendRate);              // forward annual dividend per share
  const trailingAnnualDividendRate = raw(sd.trailingAnnualDividendRate); // trailing 12-month dividend per share
  const dividendYield             = raw(sd.dividendYield);             // forward yield (decimal, e.g. 0.035)
  const trailingAnnualDividendYield = raw(sd.trailingAnnualDividendYield); // trailing yield
  const exDividendDate            = raw(sd.exDividendDate);            // unix timestamp
  const payoutRatio               = raw(sd.payoutRatio);
  const fiveYearAvgDividendYield  = raw(sd.fiveYearAvgDividendYield);  // percentage, e.g. 3.5

  // dividendDate is in defaultKeyStatistics
  const dividendDate = raw(ks.lastDividendDate) ?? raw(sd.exDividendDate);
  const lastDividendValue = raw(ks.lastDividendValue);

  // Use trailing rate preferring forward if available
  const annualDivPerShare = dividendRate ?? trailingAnnualDividendRate ?? null;
  const yieldDecimal = dividendYield ?? trailingAnnualDividendYield ?? null;

  const isPaying = annualDivPerShare != null && annualDivPerShare > 0;

  return {
    ok: true,
    ticker,
    isPaying,
    dividendRate:       annualDivPerShare,
    dividendYield:      yieldDecimal,
    trailingDivRate:    trailingAnnualDividendRate,
    trailingDivYield:   trailingAnnualDividendYield,
    exDividendDate:     exDividendDate,      // unix timestamp
    dividendDate:       dividendDate,        // unix timestamp
    lastDividendValue:  lastDividendValue,
    payoutRatio:        payoutRatio,
    fiveYearAvgYield:   fiveYearAvgDividendYield,  // already a percentage
  };
}
