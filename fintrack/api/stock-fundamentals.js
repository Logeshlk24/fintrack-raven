// api/stock-fundamentals.js  ── Vercel serverless function
// Fetches PE, Beta, Sector, MarketCap for the Analysis tab.
// Called SEPARATELY from stock-price.js so a failure here never breaks prices.
//
// Yahoo Finance v10/quoteSummary requires a crumb + cookie since 2023.
// This file handles that auth flow with module-level caching.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── Crumb cache (survives warm Vercel instances) ──────────────────────────────
let _crumb   = null;
let _cookie  = null;
let _crumbAt = 0;

async function getYahooCrumb() {
  // Return cached crumb if less than 25 minutes old
  if (_crumb && _cookie && (Date.now() - _crumbAt) < 25 * 60 * 1000) {
    return { crumb: _crumb, cookie: _cookie };
  }

  try {
    // Step 1: Load Yahoo Finance homepage to get a session cookie
    const r1 = await fetch("https://finance.yahoo.com/", {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    // Yahoo sends multiple Set-Cookie headers; node fetch collapses them with ", "
    // We need to extract just the name=value part of each cookie
    const raw = r1.headers.get("set-cookie") || "";
    const cookies = raw
      .split(/;\s*(?=[A-Za-z_][^=]+=)/)  // split on ; followed by a new cookie name
      .map(part => {
        // Each part may be "name=value; Path=...; ..." — take only "name=value"
        const eq = part.indexOf("=");
        if (eq < 0) return null;
        // Find the first semicolon after the value
        const semi = part.indexOf(";", eq);
        return semi > 0 ? part.substring(0, semi).trim() : part.trim();
      })
      .filter(Boolean)
      .join("; ");

    _cookie = cookies;

    // Step 2: Exchange cookie for a crumb token
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: {
        "User-Agent": UA,
        "Accept": "text/plain, */*",
        "Referer": "https://finance.yahoo.com/",
        "Cookie": _cookie,
      },
    });

    if (r2.ok) {
      const text = (await r2.text()).trim();
      // A valid crumb is short (< 50 chars) and not an HTML error page
      if (text && text.length < 50 && !text.includes("<")) {
        _crumb   = text;
        _crumbAt = Date.now();
      }
    }
  } catch (_) {
    // Crumb fetch failed — we'll proceed without it (Yahoo may still respond)
  }

  return { crumb: _crumb, cookie: _cookie };
}

// ── Market cap classification ────────────────────────────────────────────────
function classifyCap(raw, currency) {
  if (!raw || raw <= 0) return null;
  if (currency === "INR") {
    const cr = raw / 1e7; // rupees → crore
    if (cr >= 20000) return "Large";
    if (cr >= 5000)  return "Mid";
    return "Small";
  }
  // USD
  const b = raw / 1e9;
  if (b >= 10) return "Large";
  if (b >= 2)  return "Mid";
  return "Small";
}

// ── Fetch fundamentals for one ticker ───────────────────────────────────────
async function fetchFundamentals(ticker) {
  const { crumb, cookie } = await getYahooCrumb();
  const modules = "summaryDetail,defaultKeyStatistics,assetProfile,price";

  for (const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
    try {
      const crumbParam = crumb ? `&crumb=${encodeURIComponent(crumb)}` : "";
      const url = `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}${crumbParam}`;

      const headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://finance.yahoo.com/",
      };
      if (cookie) headers["Cookie"] = cookie;

      const r = await fetch(url, { headers });
      if (!r.ok) continue;

      const json = await r.json();
      const result = json?.quoteSummary?.result?.[0];
      if (!result) continue;

      const priceModule = result.price               || {};
      const summary     = result.summaryDetail       || {};
      const keyStats    = result.defaultKeyStatistics || {};
      const profile     = result.assetProfile        || {};

      const currency  = priceModule.currency || "INR";
      const quoteType = priceModule.quoteType || "";
      const isETF     = quoteType === "ETF";

      const marketCapRaw = priceModule.marketCap?.raw ?? summary.marketCap?.raw ?? null;

      // PE: prefer trailing, fall back to forward
      const pe   = summary.trailingPE?.raw ?? summary.forwardPE?.raw ?? keyStats.forwardPE?.raw ?? null;
      const beta = keyStats.beta?.raw      ?? summary.beta?.raw ?? null;

      return {
        ok:        true,
        ticker,
        pe:        pe   != null ? +Number(pe).toFixed(2)   : null,
        beta:      beta != null ? +Number(beta).toFixed(2) : null,
        sector:    isETF ? "ETF"  : (profile.sector   || null),
        industry:  isETF ? "ETF"  : (profile.industry || null),
        cap:       isETF ? "ETF"  : classifyCap(marketCapRaw, currency),
        marketCap: marketCapRaw,
      };
    } catch (_) { continue; }
  }

  return { ok: false, ticker };
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "Missing ticker" });

  const tickers = ticker.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) return res.status(400).json({ error: "No valid tickers" });

  // Small stagger to avoid rate-limiting on large portfolios
  const output = {};
  for (let i = 0; i < tickers.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 100));
    output[tickers[i]] = await fetchFundamentals(tickers[i]);
  }

  return res.status(200).json(output);
}
