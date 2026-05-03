// api/stock-dividend.js — Vercel serverless function
// Uses Yahoo Finance with proper cookie+crumb authentication (required since 2023)

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "Missing ticker param" });

  const tickers = ticker.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) return res.status(400).json({ error: "No valid tickers" });

  let cookie = "", crumb = "";

  try {
    const homeRes = await fetch("https://finance.yahoo.com/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    const setCookieHeader = homeRes.headers.get("set-cookie") || "";
    cookie = setCookieHeader.split(/,(?=\s*[A-Za-z0-9_-]+=)/).map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");

    for (const host of ["query1", "query2"]) {
      try {
        const crumbRes = await fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/plain, */*",
            "Referer": "https://finance.yahoo.com/",
            "Cookie": cookie,
          },
        });
        if (crumbRes.ok) {
          const text = (await crumbRes.text()).trim();
          if (text && text.length > 2 && !text.includes("<")) { crumb = text; break; }
        }
      } catch (_) {}
    }
  } catch (e) { console.error("Yahoo auth failed:", e.message); }

  const BATCH = 5;
  const output = {};
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(t => fetchDividend(t, cookie, crumb)));
    batch.forEach((t, j) => { output[t] = results[j]; });
  }
  return res.status(200).json(output);
}

const HEADERS = (cookie) => ({
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://finance.yahoo.com/",
  "Origin": "https://finance.yahoo.com",
  ...(cookie ? { "Cookie": cookie } : {}),
});

async function fetchDividend(ticker, cookie, crumb) {
  const modules = "summaryDetail,defaultKeyStatistics";
  const cp = crumb ? `&crumb=${encodeURIComponent(crumb)}` : "";
  const t = encodeURIComponent(ticker);
  const urls = [
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${t}?modules=${modules}${cp}`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${t}?modules=${modules}${cp}`,
    `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${t}?modules=${modules}${cp}`,
  ];
  let json = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: HEADERS(cookie) });
      if (!r.ok) continue;
      json = await r.json();
      if (json?.quoteSummary?.result?.[0]) break;
      json = null;
    } catch (_) {}
  }
  if (!json?.quoteSummary?.result?.[0]) return { ok: false, ticker };

  const result = json.quoteSummary.result[0];
  const sd = result.summaryDetail || {};
  const ks = result.defaultKeyStatistics || {};
  const raw = v => (v && typeof v === "object" ? v.raw : v) ?? null;
  const divRate = raw(sd.dividendRate) ?? raw(sd.trailingAnnualDividendRate);
  const divYield = raw(sd.dividendYield) ?? raw(sd.trailingAnnualDividendYield);
  return {
    ok: true, ticker, isPaying: divRate != null && divRate > 0,
    dividendRate: divRate, dividendYield: divYield,
    trailingDivRate: raw(sd.trailingAnnualDividendRate),
    trailingDivYield: raw(sd.trailingAnnualDividendYield),
    exDividendDate: raw(sd.exDividendDate),
    dividendDate: raw(ks.lastDividendDate) ?? raw(sd.exDividendDate),
    lastDividendValue: raw(ks.lastDividendValue),
    payoutRatio: raw(sd.payoutRatio),
    fiveYearAvgYield: raw(sd.fiveYearAvgDividendYield),
  };
}
