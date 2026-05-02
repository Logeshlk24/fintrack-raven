// api/stock-price.js  ── Vercel serverless function
// Fetches live prices + fundamentals (PE, beta, sector, cap) via Yahoo Finance.
// Uses crumb + cookie auth for the quoteSummary endpoint.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://finance.yahoo.com/",
  "Origin": "https://finance.yahoo.com",
};

// ── Module-level crumb cache (survives warm Vercel instances) ────────────────
let _crumb  = null;
let _cookie = null;

async function getYahooCrumb() {
  if (_crumb && _cookie) return { crumb: _crumb, cookie: _cookie };
  try {
    const r1 = await fetch("https://finance.yahoo.com/", {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
    });
    const raw = r1.headers.get("set-cookie") || "";
    const cookies = raw.split(/,(?=[^ ])/).map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
    _cookie = cookies;

    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, "Accept": "text/plain, */*", "Cookie": cookies, "Referer": "https://finance.yahoo.com/" },
    });
    if (r2.ok) _crumb = (await r2.text()).trim();
  } catch {}
  return { crumb: _crumb, cookie: _cookie };
}

// ── Cap classification ───────────────────────────────────────────────────────
function classifyCap(marketCap, ticker) {
  if (/ETF|BEES|NIFBEES|LIQUIDBEES|GOLDBEES/i.test(ticker)) return "ETF";
  if (!marketCap || marketCap <= 0) return null;
  const isIndian = ticker.endsWith(".NS") || ticker.endsWith(".BO");
  if (isIndian) {
    const cr = marketCap / 1e7; // rupees → crore
    if (cr >= 20000) return "Large";
    if (cr >= 5000)  return "Mid";
    return "Small";
  } else {
    if (marketCap >= 10e9) return "Large";
    if (marketCap >= 2e9)  return "Mid";
    return "Small";
  }
}

// ── Fetch fundamentals via v10 quoteSummary ──────────────────────────────────
async function fetchFundamentals(ticker) {
  const { crumb, cookie } = await getYahooCrumb();
  const modules = "summaryDetail,defaultKeyStatistics,assetProfile,quoteType";

  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const crumbParam = crumb ? `&crumb=${encodeURIComponent(crumb)}` : "";
      const url = `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}${crumbParam}`;
      const headers = { ...BASE_HEADERS };
      if (cookie) headers["Cookie"] = cookie;
      const r = await fetch(url, { headers });
      if (!r.ok) continue;
      const json = await r.json();
      const res  = json?.quoteSummary?.result?.[0];
      if (!res) continue;

      const sd = res.summaryDetail        || {};
      const ks = res.defaultKeyStatistics || {};
      const ap = res.assetProfile         || {};
      const qt = res.quoteType            || {};

      const trailingPE = sd.trailingPE?.raw ?? null;
      const beta       = sd.beta?.raw       ?? ks.beta?.raw ?? null;
      const sector     = ap.sector          || null;
      const industry   = ap.industry        || null;
      const marketCap  = sd.marketCap?.raw  ?? null;
      const isETF      = qt.quoteType === "ETF";

      return {
        pe:       trailingPE != null ? +trailingPE.toFixed(2) : null,
        beta:     beta       != null ? +beta.toFixed(2)       : null,
        sector,
        industry,
        marketCap,
        cap: isETF ? "ETF" : classifyCap(marketCap, ticker),
      };
    } catch {}
  }
  return {};
}

// ── Fetch price via v8 chart ─────────────────────────────────────────────────
async function fetchPrice(ticker) {
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d&includePrePost=false`;
      const r = await fetch(url, { headers: BASE_HEADERS });
      if (!r.ok) continue;
      const json = await r.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta;
      const price = meta.regularMarketPrice ?? meta.previousClose ?? null;
      if (price == null) continue;
      const prevClose = meta.chartPreviousClose ?? meta.regularMarketPreviousClose ?? meta.previousClose ?? price;
      const change    = +(price - prevClose).toFixed(2);
      const changePct = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;
      return {
        price: +price.toFixed(2), change, changePct,
        currency: meta.currency || "INR",
        exchange: meta.exchangeName || "",
        name: meta.longName || meta.shortName || ticker,
      };
    } catch {}
  }
  return null;
}

// ── Per-ticker orchestrator ──────────────────────────────────────────────────
async function fetchOne(ticker) {
  try {
    const [priceData, fund] = await Promise.all([fetchPrice(ticker), fetchFundamentals(ticker)]);
    if (!priceData) return { ok: false, ticker };
    return {
      ok: true, ticker,
      ...priceData,
      pe:        fund.pe        ?? null,
      beta:      fund.beta      ?? null,
      sector:    fund.sector    ?? null,
      industry:  fund.industry  ?? null,
      marketCap: fund.marketCap ?? null,
      cap:       fund.cap       ?? null,
    };
  } catch (e) {
    return { ok: false, ticker, error: e.message };
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────
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
