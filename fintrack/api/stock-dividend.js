// api/stock-dividend.js — Vercel serverless function
// Yahoo Finance requires a crumb+cookie handshake since mid-2023.
// Flow: 1) GET consent/crumb page to obtain cookie  2) GET crumb value  3) Use both in API calls

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "Missing ticker param" });

  const tickers = ticker.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
  if (tickers.length === 0) return res.status(400).json({ error: "No valid tickers" });

  // Step 1: Obtain cookie + crumb
  let cookie = "";
  let crumb  = "";
  try {
    const { cookie: c, crumb: cr } = await getYahooCrumb();
    cookie = c;
    crumb  = cr;
  } catch (e) {
    return res.status(502).json({ error: "Failed to obtain Yahoo crumb", detail: String(e) });
  }

  // Step 2: Fetch all tickers in parallel batches
  const BATCH = 5;
  const output = {};
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(t => fetchDividend(t, cookie, crumb)));
    batch.forEach((t, j) => { output[t] = results[j]; });
  }

  return res.status(200).json(output);
}

// ── Yahoo crumb handshake ─────────────────────────────────────────────────────
async function getYahooCrumb() {
  const BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  // Step A: Hit the consent page to get the session cookie
  const consentRes = await fetch("https://fc.yahoo.com", { headers: BASE_HEADERS, redirect: "follow" });
  const rawCookies = consentRes.headers.get("set-cookie") || "";
  // Extract all cookie name=value pairs and join them
  const cookieStr = rawCookies
    .split(/,(?=[^ ].*?=)/)          // split on commas that start a new cookie
    .map(c => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  // Also try the guce consent endpoint which sets A3 cookie
  const guceRes = await fetch(
    "https://guce.yahoo.com/consent?brandType=nonEu&lang=en-US&done=https%3A%2F%2Ffinance.yahoo.com%2F",
    { headers: { ...BASE_HEADERS, "Cookie": cookieStr }, redirect: "follow" }
  );
  const guceCookies = guceRes.headers.get("set-cookie") || "";
  const allCookies = [cookieStr, ...guceCookies
    .split(/,(?=[^ ].*?=)/)
    .map(c => c.split(";")[0].trim())
    .filter(Boolean)
  ].filter(Boolean).join("; ");

  // Step B: Get the crumb using the cookie
  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: {
      ...BASE_HEADERS,
      "Accept": "text/plain, */*",
      "Cookie": allCookies,
      "Referer": "https://finance.yahoo.com/",
      "Origin": "https://finance.yahoo.com",
    },
  });

  if (!crumbRes.ok) {
    // Fallback: try query2
    const crumbRes2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: {
        ...BASE_HEADERS,
        "Accept": "text/plain, */*",
        "Cookie": allCookies,
        "Referer": "https://finance.yahoo.com/",
      },
    });
    if (!crumbRes2.ok) throw new Error(`Crumb fetch failed: ${crumbRes.status}`);
    const crumb = (await crumbRes2.text()).trim();
    return { cookie: allCookies, crumb };
  }

  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.length < 3) throw new Error("Empty crumb returned");
  return { cookie: allCookies, crumb };
}

// ── Per-ticker dividend fetch ─────────────────────────────────────────────────
async function fetchDividend(ticker, cookie, crumb) {
  const modules = "summaryDetail,defaultKeyStatistics";
  const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finance.yahoo.com/",
    "Origin": "https://finance.yahoo.com",
    "Cookie": cookie,
  };

  const urls = [
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`,
  ];

  let json = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: baseHeaders });
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

  const raw = v => (v && typeof v === "object" ? v.raw : v) ?? null;

  const dividendRate               = raw(sd.dividendRate);
  const trailingAnnualDividendRate = raw(sd.trailingAnnualDividendRate);
  const dividendYield              = raw(sd.dividendYield);
  const trailingAnnualDividendYield= raw(sd.trailingAnnualDividendYield);
  const exDividendDate             = raw(sd.exDividendDate);
  const payoutRatio                = raw(sd.payoutRatio);
  const fiveYearAvgDividendYield   = raw(sd.fiveYearAvgDividendYield);
  const dividendDate               = raw(ks.lastDividendDate) ?? raw(sd.exDividendDate);
  const lastDividendValue          = raw(ks.lastDividendValue);

  const annualDivPerShare = dividendRate ?? trailingAnnualDividendRate ?? null;
  const yieldDecimal      = dividendYield ?? trailingAnnualDividendYield ?? null;
  const isPaying          = annualDivPerShare != null && annualDivPerShare > 0;

  return {
    ok: true, ticker, isPaying,
    dividendRate:      annualDivPerShare,
    dividendYield:     yieldDecimal,
    trailingDivRate:   trailingAnnualDividendRate,
    trailingDivYield:  trailingAnnualDividendYield,
    exDividendDate,
    dividendDate,
    lastDividendValue,
    payoutRatio,
    fiveYearAvgYield:  fiveYearAvgDividendYield,
  };
}
