// api/stock-price.js  ── Vercel serverless function
//
// TWO MODES (selected via ?mode= query param):
//   (default) price mode  → exactly the original working logic, returns price/change/etc.
//   mode=fundamentals     → fetches PE, beta, sector, cap via quoteSummary (separate, safe)
//
// This separation means a fundamentals failure can NEVER break price fetching.

const UA_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UA_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// ── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker, mode } = req.query;
  if (!ticker) return res.status(400).json({ error: "Missing ticker param" });

  const tickers = ticker.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
  if (tickers.length === 0) return res.status(400).json({ error: "No valid tickers" });

  if (mode === "fundamentals") {
    // ── FUNDAMENTALS MODE ──────────────────────────────────────────────────
    const results = await Promise.all(tickers.map(t => fetchFundamentals(t)));
    const output = {};
    tickers.forEach((t, i) => { output[t] = results[i]; });
    return res.status(200).json(output);
  }

  // ── PRICE MODE (original, unchanged) ─────────────────────────────────────
  const results = await Promise.all(tickers.map(t => fetchOne(t)));
  const output = {};
  tickers.forEach((t, i) => { output[t] = results[i]; });
  return res.status(200).json(output);
}

// ════════════════════════════════════════════════════════════════════════════
// PRICE FETCHING — original logic, untouched
// ════════════════════════════════════════════════════════════════════════════
async function fetchOne(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d&includePrePost=false`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA_MAC,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://finance.yahoo.com/",
        "Origin": "https://finance.yahoo.com",
      },
    });
    if (!res.ok) return await fetchOneV2(ticker);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return await fetchOneV2(ticker);
    const meta = result.meta;
    const price = meta.regularMarketPrice ?? meta.previousClose ?? null;
    if (price == null) return { ok: false, ticker };
    const prevClose = meta.chartPreviousClose ?? meta.regularMarketPreviousClose ?? meta.previousClose ?? price;
    const change = +(price - prevClose).toFixed(2);
    const changePct = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;
    return {
      ok: true, ticker,
      price: +price.toFixed(2), change, changePct,
      currency: meta.currency || "INR",
      exchange: meta.exchangeName || "",
      name: meta.longName || meta.shortName || ticker,
    };
  } catch (e) {
    try { return await fetchOneV2(ticker); } catch (_) {}
    return { ok: false, ticker, error: e.message };
  }
}

async function fetchOneV2(ticker) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA_WIN, "Accept": "application/json", "Referer": "https://finance.yahoo.com/" },
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
    ok: true, ticker,
    price: +price.toFixed(2), change, changePct,
    currency: meta.currency || "INR",
    exchange: meta.exchangeName || "",
    name: meta.longName || meta.shortName || ticker,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FUNDAMENTALS FETCHING — separate, crumb-aware, safe to fail
// ════════════════════════════════════════════════════════════════════════════

// Module-level crumb cache
let _crumb = null;
let _cookie = null;
let _crumbFetchedAt = 0;

async function getYahooCrumb() {
  // Re-fetch crumb if older than 30 minutes
  if (_crumb && _cookie && Date.now() - _crumbFetchedAt < 30 * 60 * 1000) {
    return { crumb: _crumb, cookie: _cookie };
  }
  try {
    const r1 = await fetch("https://finance.yahoo.com/", {
      headers: { "User-Agent": UA_MAC, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
    });
    const raw = r1.headers.get("set-cookie") || "";
    // Parse cookies — join all name=value parts
    _cookie = raw.split(/,(?=[A-Za-z_])/).map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");

    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: {
        "User-Agent": UA_MAC,
        "Accept": "text/plain, */*",
        "Cookie": _cookie,
        "Referer": "https://finance.yahoo.com/",
      },
    });
    if (r2.ok) {
      const text = (await r2.text()).trim();
      // Valid crumb is short alphanumeric, not an HTML/error page
      if (text.length < 50 && !text.startsWith("<")) {
        _crumb = text;
        _crumbFetchedAt = Date.now();
      }
    }
  } catch {}
  return { crumb: _crumb, cookie: _cookie };
}

function classifyCap(marketCap, ticker) {
  if (/ETF|BEES|NIFBEES|LIQUIDBEES|GOLDBEES/i.test(ticker)) return "ETF";
  if (!marketCap || marketCap <= 0) return null;
  const isIndian = ticker.endsWith(".NS") || ticker.endsWith(".BO");
  if (isIndian) {
    const cr = marketCap / 1e7; // rupees → crore
    if (cr >= 20000) return "Large";
    if (cr >= 5000)  return "Mid";
    return "Small";
  }
  // USD
  if (marketCap >= 10e9) return "Large";
  if (marketCap >= 2e9)  return "Mid";
  return "Small";
}

async function fetchFundamentals(ticker) {
  const { crumb, cookie } = await getYahooCrumb();
  const modules = "summaryDetail,defaultKeyStatistics,assetProfile,quoteType";

  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const crumbParam = crumb ? `&crumb=${encodeURIComponent(crumb)}` : "";
      const url = `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}${crumbParam}`;
      const headers = {
        "User-Agent": UA_MAC,
        "Accept": "application/json",
        "Referer": "https://finance.yahoo.com/",
      };
      if (cookie) headers["Cookie"] = cookie;

      const r = await fetch(url, { headers });
      if (!r.ok) continue;
      const json = await r.json();
      const result = json?.quoteSummary?.result?.[0];
      if (!result) continue;

      const sd = result.summaryDetail        || {};
      const ks = result.defaultKeyStatistics || {};
      const ap = result.assetProfile         || {};
      const qt = result.quoteType            || {};

      const pe        = sd.trailingPE?.raw ?? null;
      const beta      = sd.beta?.raw       ?? ks.beta?.raw ?? null;
      const sector    = ap.sector          || null;
      const industry  = ap.industry        || null;
      const marketCap = sd.marketCap?.raw  ?? null;
      const isETF     = qt.quoteType === "ETF";

      return {
        ok: true, ticker,
        pe:       pe   != null ? +pe.toFixed(2)   : null,
        beta:     beta != null ? +beta.toFixed(2) : null,
        sector, industry, marketCap,
        cap: isETF ? "ETF" : classifyCap(marketCap, ticker),
      };
    } catch {}
  }

  return { ok: false, ticker };
}
