import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  auth,
  signInWithGoogle,
  signOutUser,
  onAuthStateChanged,
  loadFromFirestore,
  saveToFirestore,
} from "./firebase";

// ── Force Light Mode CSS Variables ──────────────────────────────────────────
const LIGHT_MODE_STYLE = `
  :root, [data-theme], * {
    color-scheme: light !important;
  }
  :root {
    --color-background-primary: #ffffff;
    --color-background-secondary: #f5f5f5;
    --color-background-tertiary: #f0f0f0;
    --color-text-primary: #111111;
    --color-text-secondary: #6b7280;
    --color-border-primary: #d1d5db;
    --color-border-secondary: #e5e7eb;
    --color-border-tertiary: #e5e7eb;
  }
  input, select, textarea {
    background: #ffffff !important;
    color: #111111 !important;
    border: 1px solid #d1d5db !important;
    border-radius: 6px;
    padding: 6px 10px;
  }
  html, body { overflow-x: hidden; }
  * { box-sizing: border-box; }
  @media (max-width: 767px) {
    /* Prevent any element from causing horizontal scroll */
    main, .main-content { max-width: 100vw; overflow-x: hidden; }
    /* Tables scroll inside their container */
    table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    /* Inputs always fit */
    input[type="time"], input[type="date"] { min-width: 0; width: 100% !important; }
    /* Mobile holdings stats grid: 2 cols instead of 4 */
    .mobile-stats-2col { grid-template-columns: 1fr 1fr !important; }
    /* Make pie chart wrap on mobile */
    .pie-wrap { flex-direction: column !important; align-items: center !important; }
    /* Bar charts: don't overflow */
    svg { max-width: 100%; }
  }
`;

// ── localStorage → kept only for one-time migration on first sign-in ──────────
const STORAGE_KEY = "fintrack_data_v2";

function migrateLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    localStorage.removeItem(STORAGE_KEY); // clear after migration
    return { ...defaultData, ...parsed };
  } catch { return null; }
}


const defaultData = {
  user: null,
  profile: { age: "", income: "", expense: "", savings: "" },
  assets: [],
  liabilities: [],
  transactions: [],
  banks: [],
  emis: [],
  foTrades: [],
  foCharges: { brokerage: 40, stt: 0.05, exchangeFee: 0.05, sebi: 0.0001, gst: 18, stampDuty: 0.003 },
  brokerProfiles: [
    { id: 1, name: "Zerodha", charges: { brokerage: 20, stt: 0.05, exchangeFee: 0.05, sebi: 0.0001, gst: 18, stampDuty: 0.003 } },
  ],
  lotSizes: { "Nifty 50": 65, "Bank Nifty": 30, "Sensex": 20, "Crude Oil": 100, "Crude Oil M": 10, "Natural Gas": 1250, "Natural Gas M": 250, "Gold": 100, "Gold M": 10 },
  customInstruments: { "Index Options": [], "Stock Options": [], "Commodities": [] },
  portfolioHoldings: [],
  goals: [],
  snapshots: [],
  scheduledPayments: [],
  needsWants: [],
  featureToggles: { fo: true, portfolio: true },
  businessData: [],
  projectsData: [],
  projectTaskTypes: ["Design", "Development", "Research", "Review", "Testing", "Meeting", "Documentation", "Bug Fix", "Marketing", "Other"],
  liabilityTypes: ["Credit Card", "Personal Loan", "Car Loan", "Home Loan", "Other"],
};



const ASSET_TYPES = ["Stocks & Equity", "Equity Funds", "Gold & Silver", "FD & RD", "EPF / PPF / NPS", "Real Estate", "Crypto", "Cash", "Other"];
const STRATEGIES = ["Call", "Put"];
const INSTRUMENTS = ["Index Options", "Stock Options", "Commodities"];

const fmt = (n) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n || 0);
const fmtCur = (n) => "₹" + fmt(n);
const fmtPct = (n) => (n >= 0 ? "+" : "") + (n || 0).toFixed(2) + "%";

// ── XIRR — Newton-Raphson solver ──────────────────────────────────────────────
// cashflows: [{ amount, date }]  (negative = outflow, positive = inflow)
function calcXIRR(cashflows, guess = 0.1, maxIter = 1000, tol = 1e-7) {
  if (!cashflows || cashflows.length < 2) return null;
  const t0 = cashflows[0].date;
  const daysArr = cashflows.map(cf => (cf.date - t0) / (1000 * 60 * 60 * 24 * 365));
  let rate = guess;
  for (let i = 0; i < maxIter; i++) {
    let f = 0, df = 0;
    for (let j = 0; j < cashflows.length; j++) {
      const t = daysArr[j];
      const v = cashflows[j].amount / Math.pow(1 + rate, t);
      f  += v;
      df -= t * cashflows[j].amount / Math.pow(1 + rate, t + 1);
    }
    const newRate = rate - f / df;
    if (Math.abs(newRate - rate) < tol) return isFinite(newRate) ? newRate : null;
    rate = newRate;
  }
  return isFinite(rate) ? rate : null;
}

// ── CAGR — simple point-to-point ──────────────────────────────────────────────
function calcCAGR(invested, current, buyDate) {
  if (!buyDate || invested <= 0 || current <= 0) return null;
  const years = (Date.now() - new Date(buyDate).getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (years < 0.01) return null;
  return Math.pow(current / invested, 1 / years) - 1;
}

// ── Portfolio-level XIRR from multiple holdings ───────────────────────────────
// Each holding contributes one outflow (buyDate) and one inflow (today at curVal)
function calcPortfolioXIRR(holdings, getCurVal) {
  const cashflows = [];
  holdings.forEach(h => {
    if (!h.buyDate) return;
    const invested = (h.buyPrice || 0) * (h.qty || 0);
    const curVal   = getCurVal(h);
    if (!invested || curVal == null) return;
    cashflows.push({ amount: -invested, date: new Date(h.buyDate) });
    cashflows.push({ amount: curVal,    date: new Date() });
  });
  return calcXIRR(cashflows);
}

function fmtRate(r) {
  if (r == null || !isFinite(r)) return "—";
  return (r * 100).toFixed(2) + "%";
}


// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE CONTEXT — persistent auth + upload utility used app-wide
// ═══════════════════════════════════════════════════════════════════════════════
const DriveContext = React.createContext(null);

function DriveProvider({ children, data, update }) {
  const LS_TOKEN  = "fintracker_drive_token";
  const LS_EXPIRY = "fintracker_drive_expiry";
  const LS_EMAIL  = "fintracker_drive_email";

  // Restore from localStorage on mount
  const storedToken  = localStorage.getItem(LS_TOKEN)  || null;
  const storedExpiry = parseInt(localStorage.getItem(LS_EXPIRY) || "0");
  const storedEmail  = localStorage.getItem(LS_EMAIL)  || null;
  const isValid      = storedToken && Date.now() < storedExpiry;

  const [token,       setToken]       = useState(isValid ? storedToken  : null);
  const [email,       setEmail]       = useState(isValid ? storedEmail  : null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState("");
  const clientId = data.driveClientId || "";

  // ── Auto-silent refresh on mount if token expired but clientId + email exist ──
  useEffect(() => {
    if (isValid) return; // still valid, nothing to do
    const cid = data.driveClientId;
    const savedEmail = storedEmail;
    if (!cid || !savedEmail) return; // never authenticated before

    // Wait for GIS script to load, then silently request a new token
    function tryRefresh() {
      if (!window.google?.accounts?.oauth2) return;
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: cid,
        scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
        hint: savedEmail, // pre-fill the account
        callback: async (resp) => {
          if (resp.error || !resp.access_token) return; // silent fail — user can re-login manually
          saveToken(resp.access_token, resp.expires_in || 3600);
          setEmail(savedEmail);
        },
      });
      // prompt: "none" = fully silent, no popup — only works if user already granted
      client.requestAccessToken({ prompt: "none" });
    }

    if (window.google?.accounts?.oauth2) {
      tryRefresh();
    } else {
      // Script still loading — poll until ready
      const iv = setInterval(() => {
        if (window.google?.accounts?.oauth2) { clearInterval(iv); tryRefresh(); }
      }, 200);
      setTimeout(() => clearInterval(iv), 8000); // give up after 8s
    }
  }, []); // eslint-disable-line

  // Load google scripts once
  useEffect(() => {
    if (!window._gapiReady) {
      const s = document.createElement("script");
      s.src = "https://apis.google.com/js/api.js";
      s.onload = () => window._gapiReady = true;
      document.head.appendChild(s);
    }
    if (!window._gisReady) {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.onload = () => window._gisReady = true;
      document.head.appendChild(s);
    }
  }, []);

  function saveToken(t, expiresIn) {
    const expiry = Date.now() + (expiresIn - 60) * 1000; // 1 min early
    localStorage.setItem(LS_TOKEN,  t);
    localStorage.setItem(LS_EXPIRY, String(expiry));
    setToken(t);
  }
  function saveEmail(e) { localStorage.setItem(LS_EMAIL, e); setEmail(e); }
  function clearDrive() {
    localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_EXPIRY); localStorage.removeItem(LS_EMAIL);
    setToken(null); setEmail(null);
  }

  function signIn(cid) {
    if (!cid) { setError("Paste your Google OAuth Client ID first."); return; }
    setError(""); setLoading(true);
    const doSignIn = () => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: cid,
        scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
        callback: async (resp) => {
          setLoading(false);
          if (resp.error) { setError("Sign-in cancelled or failed."); return; }
          saveToken(resp.access_token, resp.expires_in || 3600);
          update(p => ({ driveClientId: cid }));
          // fetch email
          try {
            const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + resp.access_token } });
            const u = await r.json(); saveEmail(u.email || "");
          } catch {}
        },
      });
      client.requestAccessToken({ prompt: "" }); // prompt:"" = silent if already granted
    };
    if (window.google?.accounts?.oauth2) { doSignIn(); }
    else {
      let wait = 0;
      const iv = setInterval(() => { wait += 100; if (window.google?.accounts?.oauth2 || wait > 5000) { clearInterval(iv); if (window.google?.accounts?.oauth2) doSignIn(); else { setLoading(false); setError("Google script failed to load. Check your internet."); } } }, 100);
    }
  }

  // Upload file to Google Drive — returns { id, name, webViewLink } or null
  async function uploadToDrive(file, driveFolderId) {
    if (!token) return null;
    try {
      const ab   = await file.arrayBuffer();
      const meta = JSON.stringify({ name: file.name, ...(driveFolderId ? { parents: [driveFolderId] } : {}) });
      const form = new FormData();
      form.append("metadata", new Blob([meta], { type: "application/json" }));
      form.append("file", new Blob([ab], { type: file.type || "application/octet-stream" }), file.name);
      const res = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,webContentLink,size",
        { method: "POST", headers: { Authorization: "Bearer " + token }, body: form }
      );
      if (res.status === 401) { clearDrive(); return null; } // token expired
      if (!res.ok) return null;
      const d = await res.json();
      // Make publicly viewable so we can render it in an iframe
      await fetch(`https://www.googleapis.com/drive/v3/files/${d.id}/permissions`, {
        method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "reader", type: "anyone" })
      });
      return { id: d.id, name: d.name, mimeType: d.mimeType, webViewLink: d.webViewLink, downloadUrl: `https://drive.google.com/uc?export=download&id=${d.id}`, previewUrl: `https://drive.google.com/file/d/${d.id}/preview`, size: file.size };
    } catch { return null; }
  }

  const connected = !!token;
  return (
    <DriveContext.Provider value={{ connected, token, email, loading, error, clientId, signIn, clearDrive, uploadToDrive, setError }}>
      {children}
    </DriveContext.Provider>
  );
}

function useDrive() { return React.useContext(DriveContext); }
// ═══════════════════════════════════════════════════════════════════════════════

export default function App() {
  // ── Mobile detection ──────────────────────────────────────────────────────
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches
  );
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e) => setMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // ── Firebase auth state ───────────────────────────────────────────────────
  // undefined = still checking  |  null = signed out  |  object = signed in
  const [firebaseUser, setFirebaseUser] = useState(undefined);
  const [data, setData]                 = useState({ ...defaultData });
  const [dataReady, setDataReady]       = useState(false);

  const [page, setPage]                 = useState("overview");
  const [onboarding, setOnboarding]     = useState(false);
  const [onboardStep, setOnboardStep]   = useState(0);
  const [modal, setModal]               = useState(null);
  const [foTab, setFoTab]               = useState("trades");
  const [moneyTab, setMoneyTab]         = useState("transactions");
  const [essentialsTab, setEssentialsTab] = useState("essentials");
  const [settingsTab, setSettingsTab]   = useState("trading");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const navDragIdx = useRef(null);
  const [navDragOver, setNavDragOver] = useState(null);
  const [navEditMode, setNavEditMode] = useState(false);

  // Debounce timer ref — avoids hammering Firestore on every keystroke
  const saveTimer = useRef(null);

  // ── 1. Listen to Firebase auth changes ───────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => setFirebaseUser(user ?? null));
    return unsub;
  }, []);

  // ── 2. Load user data from Firestore after sign-in ────────────────────────
  useEffect(() => {
    if (!firebaseUser) return;
    let cancelled = false;
    (async () => {
      // Check for any existing localStorage data to migrate
      const migrated = migrateLocalStorage();
      const loaded   = await loadFromFirestore(firebaseUser.uid, migrated || defaultData);
      if (cancelled) return;

      setData({
        ...loaded,
        // Always use real Firebase user info
        user: {
          name:   firebaseUser.displayName || "User",
          email:  firebaseUser.email,
          photo:  firebaseUser.photoURL || null,
        },
      });
      setDataReady(true);

      // If we just migrated local data, persist it to Firestore immediately
      if (migrated) saveToFirestore(firebaseUser.uid, loaded);
    })();
    return () => { cancelled = true; };
  }, [firebaseUser]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 3. update() — same API as before, but writes to Firestore ─────────────
  const update = useCallback((fn) => {
    setData(prev => {
      const next = { ...prev, ...fn(prev) };
      // Debounced Firestore write (800 ms after last change)
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        if (firebaseUser) saveToFirestore(firebaseUser.uid, next);
      }, 800);
      return next;
    });
  }, [firebaseUser]);

  const totalIncome = data.transactions.filter(t => t.type === "income").reduce((s, t) => s + Number(t.amount || 0), 0);
  const totalExpense = data.transactions.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount || 0), 0);
  // Net worth = sum of all bank balances (linked transactions) + unlinked transactions
  const linkedBankIds = new Set((data.banks || []).map(b => String(b.id)));
  const unlinkedIncome = data.transactions.filter(t => t.type === "income" && (!t.bankId || !linkedBankIds.has(String(t.bankId)))).reduce((s, t) => s + Number(t.amount || 0), 0);
  const unlinkedExpense = data.transactions.filter(t => t.type === "expense" && (!t.bankId || !linkedBankIds.has(String(t.bankId)))).reduce((s, t) => s + Number(t.amount || 0), 0);
  const netWorth = (data.banks || []).reduce((s, b) => {
    const inc = data.transactions.filter(t => t.type === "income" && String(t.bankId) === String(b.id)).reduce((a, t) => a + Number(t.amount || 0), 0);
    const exp = data.transactions.filter(t => t.type === "expense" && String(t.bankId) === String(b.id)).reduce((a, t) => a + Number(t.amount || 0), 0);
    if (b.type === "Credit Card") {
      const outstanding = (b.openingBalance || 0) + exp - inc;
      return s - outstanding;
    }
    return s + (b.openingBalance || 0) + inc - exp;
  }, 0) + (unlinkedIncome - unlinkedExpense);

  const totalAssets = data.assets.reduce((s, a) => s + Number(a.value || 0), 0);
  const totalLiabilities = data.liabilities.reduce((s, l) => s + Number(l.value || 0), 0);

  const foNetPnl = data.foTrades.reduce((s, t) => {
    const gross = (Number(t.sellPremium || 0) - Number(t.buyPremium || 0)) * Number(t.lots || 1) * Number(t.lotSize || 50);
    const charges = calcCharges(t, t.brokerCharges || data.foCharges);
    return s + gross - charges;
  }, 0);

  function calcCharges(trade, charges) {
    const c = charges || data.foCharges;
    const turnover = (Number(trade.buyPremium || 0) + Number(trade.sellPremium || 0)) * Number(trade.lots || 1) * Number(trade.lotSize || 50);
    const brokerage = c.brokerage * 2;
    const stt = (Number(trade.sellPremium || 0) * Number(trade.lots || 1) * Number(trade.lotSize || 50)) * (c.stt / 100);
    const exchange = turnover * (c.exchangeFee / 100);
    const sebi = turnover * (c.sebi / 100);
    const gstAmt = (brokerage + exchange) * (c.gst / 100);
    const stamp = (Number(trade.buyPremium || 0) * Number(trade.lots || 1) * Number(trade.lotSize || 50)) * (c.stampDuty / 100);
    return brokerage + stt + exchange + sebi + gstAmt + stamp;
  }

  // ── Auth gates ────────────────────────────────────────────────────────────
  if (firebaseUser === undefined) return <SplashScreen msg="Loading…" />;
  if (firebaseUser === null)      return <SignInPage />;
  if (!dataReady)                 return <SplashScreen msg="Syncing your data…" />;

  if (onboarding) return <Onboarding step={onboardStep} setStep={setOnboardStep} data={data} update={update} done={() => setOnboarding(false)} />;

  const toggles = data.featureToggles || { fo: true, portfolio: true };
  const portfolioOn = toggles.portfolio !== false;
  const allNavItems = [
    { id: "money",      label: "Money",     icon: "⊕" },
    ...(toggles.fo ? [{ id: "fo", label: "F&O", icon: "◉" }] : []),
    ...(portfolioOn ? [{ id: "portfolio", label: "Portfolio", icon: "📈" }] : []),
    { id: "goals",      label: "Goals",     icon: "◎" },
    { id: "business",   label: "Business",  icon: "🏢" },
    { id: "projects",   label: "Projects",  icon: "📋" },
  ];

  // Restore saved nav order, filtering out items that may have been toggled off
  const savedNavOrder = data.navOrder || [];
  const availableIds = allNavItems.map(i => i.id);
  const orderedIds = [
    ...savedNavOrder.filter(id => availableIds.includes(id)),
    ...availableIds.filter(id => !savedNavOrder.includes(id)),
  ];
  const navItems = orderedIds.map(id => allNavItems.find(i => i.id === id)).filter(Boolean);

  function onNavDragStart(e, i) { navDragIdx.current = i; e.dataTransfer.effectAllowed = "move"; }
  function onNavDragOver(e, i) { e.preventDefault(); if (i !== navDragOver) setNavDragOver(i); }
  function onNavDrop(e, i) {
    e.preventDefault();
    if (navDragIdx.current === null || navDragIdx.current === i) { setNavDragOver(null); return; }
    const next = [...navItems.map(x => x.id)];
    const [moved] = next.splice(navDragIdx.current, 1);
    next.splice(i, 0, moved);
    update(() => ({ navOrder: next }));
    navDragIdx.current = null; setNavDragOver(null);
  }

  // Mobile: extra nav items for "More" sheet
  const moreItems = navItems.filter(n => !["money","goals","portfolio"].includes(n.id));

  return (
    <DriveProvider data={data} update={update}>
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "'DM Sans', sans-serif", background: "var(--color-background-tertiary)", color: "var(--color-text-primary)" }}>
      <style>{LIGHT_MODE_STYLE}</style>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Serif+Display&display=swap" rel="stylesheet" />

      {/* Sidebar — hidden on mobile */}
      <aside style={{
        width: sidebarCollapsed ? 56 : 200,
        background: "var(--color-background-primary)",
        borderRight: "0.5px solid var(--color-border-tertiary)",
        display: mobile ? "none" : "flex", flexDirection: "column",
        padding: "1rem 0",
        position: "sticky", top: 0, height: "100vh",
        flexShrink: 0,
        transition: "width 0.22s cubic-bezier(.4,0,.2,1)",
        overflow: "hidden"
      }}>
        {/* Logo + toggle row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: sidebarCollapsed ? "center" : "space-between", padding: sidebarCollapsed ? "0 0 1rem" : "0 0.75rem 1rem 1rem", borderBottom: "0.5px solid var(--color-border-tertiary)", marginBottom: "0.5rem" }}>
          {!sidebarCollapsed && <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 20, color: "var(--color-text-primary)", whiteSpace: "nowrap" }}>FinTrack</span>}
          <button onClick={() => setSidebarCollapsed(c => !c)} style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--color-text-secondary)", fontSize: 18, lineHeight: 1,
            padding: "2px 4px", borderRadius: 6, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center"
          }} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {sidebarCollapsed ? "›" : "‹"}
          </button>
        </div>

        {/* Fixed Overview at top */}
        <button onClick={() => setPage("overview")} style={{
          display: "flex", alignItems: "center",
          gap: sidebarCollapsed ? 0 : 10,
          justifyContent: sidebarCollapsed ? "center" : "flex-start",
          padding: sidebarCollapsed ? "0.6rem 0" : "0.6rem 1rem",
          background: page === "overview" ? "var(--color-background-secondary)" : "transparent",
          border: "none", cursor: "pointer",
          color: page === "overview" ? "var(--color-text-primary)" : "var(--color-text-secondary)",
          fontWeight: page === "overview" ? 500 : 400, fontSize: 14,
          borderLeft: page === "overview" ? "2px solid #1a6b3c" : "2px solid transparent",
          width: "100%", textAlign: "left", whiteSpace: "nowrap", overflow: "hidden"
        }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>⊞</span>
          {!sidebarCollapsed && "Overview"}
        </button>

        {/* Draggable nav items */}
        {navItems.map((item, i) => (
          <div key={item.id}
            draggable={navEditMode && !sidebarCollapsed}
            onDragStart={navEditMode ? e => onNavDragStart(e, i) : undefined}
            onDragOver={navEditMode ? e => onNavDragOver(e, i) : undefined}
            onDrop={navEditMode ? e => onNavDrop(e, i) : undefined}
            onDragEnd={navEditMode ? () => { navDragIdx.current = null; setNavDragOver(null); } : undefined}
            style={{ display: "flex", alignItems: "center", borderLeft: navDragOver === i ? "2px solid #1a6b3c" : page === item.id ? "2px solid #1a6b3c" : "2px solid transparent", background: navDragOver === i ? "#e8f5ee" : page === item.id ? "var(--color-background-secondary)" : "transparent" }}
          >
            {!sidebarCollapsed && navEditMode && (
              <span style={{ paddingLeft: 6, color: "var(--color-border-primary)", cursor: "grab", fontSize: 13, userSelect: "none" }}>⠿</span>
            )}
            <button onClick={() => { if (!navEditMode) setPage(item.id); }} title={sidebarCollapsed ? item.label : undefined} style={{
              flex: 1, display: "flex", alignItems: "center",
              gap: sidebarCollapsed ? 0 : 8,
              justifyContent: sidebarCollapsed ? "center" : "flex-start",
              padding: sidebarCollapsed ? "0.6rem 0" : "0.6rem 0.6rem 0.6rem 4px",
              background: "transparent", border: "none", cursor: navEditMode ? "grab" : "pointer",
              color: page === item.id ? "var(--color-text-primary)" : "var(--color-text-secondary)",
              fontWeight: page === item.id ? 500 : 400, fontSize: 14,
              width: "100%", textAlign: "left", whiteSpace: "nowrap", overflow: "hidden"
            }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>{item.icon}</span>
              {!sidebarCollapsed && item.label}
            </button>
          </div>
        ))}

        {!sidebarCollapsed && (
          <div style={{ marginTop: "auto", padding: "0 0 0.5rem" }}>
            <button onClick={() => setPage("settings")} title="Settings" style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "0.6rem 1rem",
              background: page === "settings" ? "var(--color-background-secondary)" : "transparent",
              border: "none", cursor: "pointer",
              color: page === "settings" ? "var(--color-text-primary)" : "var(--color-text-secondary)",
              fontWeight: page === "settings" ? 500 : 400, fontSize: 14,
              borderLeft: page === "settings" ? "2px solid #1a6b3c" : "2px solid transparent",
              width: "100%", textAlign: "left"
            }}>
              <span style={{ fontSize: 16 }}>⚙️</span> Settings
            </button>
            <div style={{ padding: "0.6rem 1rem", borderTop: "0.5px solid var(--color-border-tertiary)", marginTop: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                {data.user?.photo
                  ? <img src={data.user.photo} alt="" style={{ width: 26, height: 26, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                  : <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#1a6b3c", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, flexShrink: 0 }}>{(data.user?.name || "U")[0]}</div>
                }
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.user?.name || "User"}</div>

                </div>
              </div>
              <button onClick={signOutUser} style={{ width: "100%", background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: "5px 0", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}>
                Sign out
              </button>
            </div>
          </div>
        )}
        {sidebarCollapsed && (
          <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "0.5rem 0" }}>
            <button onClick={() => setPage("settings")} title="Settings" style={{
              background: page === "settings" ? "var(--color-background-secondary)" : "none",
              border: "none", cursor: "pointer", fontSize: 18,
              width: "100%", padding: "0.5rem 0", display: "flex", justifyContent: "center",
              borderLeft: page === "settings" ? "2px solid #1a6b3c" : "2px solid transparent",
            }}>⚙️</button>
            {data.user?.photo
              ? <img src={data.user.photo} alt="" style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }} title={data.user.name} />
              : <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#1a6b3c", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600 }}>
                  {(data.user?.name || "U")[0]}
                </div>
            }
          </div>
        )}
      </aside>

      {/* Main */}
      <main style={{ flex: 1, padding: mobile ? "1rem" : "1.5rem", paddingBottom: mobile ? "80px" : "1.5rem", overflowY: "auto", overflowX: "hidden", minWidth: 0, maxWidth: "100%" }}>
        {page === "overview" && <Overview data={data} netWorth={netWorth} foNetPnl={foNetPnl} setPage={setPage} toggles={toggles} update={update} portfolioOn={portfolioOn} />}
        {page === "money" && <MoneyPage data={data} update={update} tab={moneyTab} setTab={setMoneyTab} />}
        {page === "fo" && <FOPage data={data} update={update} tab={foTab} setTab={setFoTab} calcCharges={calcCharges} foNetPnl={foNetPnl} />}
        {page === "portfolio" && portfolioOn && <PortfolioHub data={data} update={update} />}
        {page === "goals" && <GoalsPage data={data} update={update} />}
        {page === "business" && <BusinessPage data={data} update={update} />}
        {page === "projects" && <ProjectsPage data={data} update={update} />}
        {page === "settings" && <SettingsPage data={data} update={update} tab={settingsTab} setTab={setSettingsTab} navItems={navItems} navEditMode={navEditMode} setNavEditMode={setNavEditMode} onNavDragStart={onNavDragStart} onNavDragOver={onNavDragOver} onNavDrop={onNavDrop} navDragOver={navDragOver} navDragIdx={navDragIdx} setNavDragOver={setNavDragOver} />}
      </main>

      {/* ── Mobile Bottom Navigation Bar ── */}
      {mobile && (
        <>
          {/* More menu overlay */}
          {showMoreMenu && (
            <div onClick={() => setShowMoreMenu(false)} style={{
              position: "fixed", inset: 0, zIndex: 998, background: "rgba(0,0,0,0.3)"
            }}>
              <div onClick={e => e.stopPropagation()} style={{
                position: "fixed", bottom: 64, left: 0, right: 0, zIndex: 999,
                background: "var(--color-background-primary)",
                borderTop: "0.5px solid var(--color-border-tertiary)",
                borderRadius: "16px 16px 0 0",
                padding: "1rem",
                display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8,
              }}>
                {moreItems.map(item => (
                  <button key={item.id} onClick={() => { setPage(item.id); setShowMoreMenu(false); }} style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                    padding: "12px 8px", borderRadius: 12, border: "none",
                    background: page === item.id ? "var(--color-background-secondary)" : "transparent",
                    cursor: "pointer", fontSize: 12, color: "var(--color-text-primary)",
                  }}>
                    <span style={{ fontSize: 22 }}>{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
                {/* Settings */}
                <button onClick={() => { setPage("settings"); setShowMoreMenu(false); }} style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                  padding: "12px 8px", borderRadius: 12, border: "none",
                  background: page === "settings" ? "var(--color-background-secondary)" : "transparent",
                  cursor: "pointer", fontSize: 12, color: "var(--color-text-primary)",
                }}>
                  <span style={{ fontSize: 22 }}>⚙️</span>
                  <span>Settings</span>
                </button>
              </div>
            </div>
          )}

          {/* Bottom bar */}
          <nav style={{
            position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 1000,
            background: "var(--color-background-primary)",
            borderTop: "0.5px solid var(--color-border-tertiary)",
            display: "flex", alignItems: "stretch",
            height: 64,
            paddingBottom: "env(safe-area-inset-bottom)",
          }}>
            {/* Overview */}
            <button onClick={() => { setPage("overview"); setShowMoreMenu(false); }} style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", gap: 3, border: "none", background: "transparent",
              cursor: "pointer", fontSize: 10, fontWeight: 500,
              color: page === "overview" ? "#1a6b3c" : "var(--color-text-secondary)",
            }}>
              <span style={{ fontSize: 22 }}>⊞</span>
              <span>Overview</span>
            </button>
            {/* Money */}
            <button onClick={() => { setPage("money"); setShowMoreMenu(false); }} style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", gap: 3, border: "none", background: "transparent",
              cursor: "pointer", fontSize: 10, fontWeight: 500,
              color: page === "money" ? "#1a6b3c" : "var(--color-text-secondary)",
            }}>
              <span style={{ fontSize: 22 }}>⊕</span>
              <span>Money</span>
            </button>
            {/* Goals */}
            <button onClick={() => { setPage("goals"); setShowMoreMenu(false); }} style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", gap: 3, border: "none", background: "transparent",
              cursor: "pointer", fontSize: 10, fontWeight: 500,
              color: page === "goals" ? "#1a6b3c" : "var(--color-text-secondary)",
            }}>
              <span style={{ fontSize: 22 }}>◎</span>
              <span>Goals</span>
            </button>
            {/* Portfolio */}
            <button onClick={() => { setPage("portfolio"); setShowMoreMenu(false); }} style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", gap: 3, border: "none", background: "transparent",
              cursor: "pointer", fontSize: 10, fontWeight: 500,
              color: page === "portfolio" ? "#1a6b3c" : "var(--color-text-secondary)",
            }}>
              <span style={{ fontSize: 22 }}>📈</span>
              <span>Portfolio</span>
            </button>
            {/* More */}
            <button onClick={() => setShowMoreMenu(p => !p)} style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", gap: 3, border: "none", background: "transparent",
              cursor: "pointer", fontSize: 10, fontWeight: 500,
              color: showMoreMenu || !["overview","money","goals","portfolio"].includes(page)
                ? "#1a6b3c" : "var(--color-text-secondary)",
            }}>
              <span style={{ fontSize: 22, letterSpacing: 2 }}>•••</span>
              <span>More</span>
            </button>
          </nav>
        </>
      )}
    </div>
    </DriveProvider>
  );
}

// ─── Splash / Loading screen ──────────────────────────────────────────────────
function SplashScreen({ msg }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#f5f5f5", fontFamily: "'DM Sans', sans-serif" }}>
      <style>{LIGHT_MODE_STYLE}</style>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Serif+Display&display=swap" rel="stylesheet" />
      <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 30, marginBottom: 12, color: "#111" }}>FinTrack</div>
      <div style={{ fontSize: 13, color: "#6b7280" }}>{msg}</div>
    </div>
  );
}

// ─── Sign-In Page ─────────────────────────────────────────────────────────────
function SignInPage() {
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

  async function handleGoogle() {
    setError("");
    setLoading(true);
    try {
      await signInWithGoogle();
      // onAuthStateChanged in App() handles everything after this
    } catch (e) {
      console.error(e);
      setError("Sign-in failed — please try again.");
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "var(--color-background-tertiary)", fontFamily: "'DM Sans', sans-serif" }}>
      <style>{LIGHT_MODE_STYLE}</style>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Serif+Display&display=swap" rel="stylesheet" />

      <div style={{ background: "var(--color-background-primary)", borderRadius: 20, border: "0.5px solid var(--color-border-tertiary)", padding: "2.5rem 2rem", width: "min(400px, 90vw)", textAlign: "center", boxShadow: "0 4px 24px rgba(0,0,0,0.06)" }}>

        {/* Logo */}
        <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 32, marginBottom: 6 }}>FinTrack</div>
        <p style={{ color: "var(--color-text-secondary)", fontSize: 14, marginBottom: 28, lineHeight: 1.5 }}>
          Your private net worth &amp; F&amp;O tracker
        </p>

        {/* Feature pills */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 28 }}>
          {[["◈", "Assets &\nNet Worth"], ["◉", "F&O P&L\nTracker"], ["☁", "Cloud\nSync"]].map(([icon, label]) => (
            <div key={label} style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "0.9rem 0.5rem", fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
              <div style={{ fontSize: 22, color: "#1a6b3c", marginBottom: 6 }}>{icon}</div>
              {label}
            </div>
          ))}
        </div>

        {/* Google button */}
        <button
          onClick={handleGoogle}
          disabled={loading}
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            padding: "12px 16px", border: "0.5px solid var(--color-border-secondary)", borderRadius: 10,
            background: loading ? "var(--color-background-secondary)" : "var(--color-background-primary)",
            cursor: loading ? "not-allowed" : "pointer", fontSize: 15, fontWeight: 500,
            color: "var(--color-text-primary)", transition: "background 0.15s",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          {loading ? "Signing in…" : "Continue with Google"}
        </button>

        {error && <p style={{ color: "#d44", fontSize: 13, marginTop: 12 }}>{error}</p>}

        <p style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 20, lineHeight: 1.7 }}>
          Your data is stored privately in your own account.<br />
          No broker connections. No third-party tracking.
        </p>
      </div>
    </div>
  );
}

// ─── Onboarding ───────────────────────────────────────────────────────────────
function Onboarding({ step, setStep, data, update, done }) {
  const [form, setForm]     = useState({ name: "", email: "", ...data.profile });
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const steps = [
    { title: "Welcome to FinTrack", sub: "Your privacy-first net worth + F&O tracker. No broker connections, no third-party tracking." },
    { title: "Your Financial Profile", sub: "Optional — helps provide personalised insights." },
    { title: "Add your assets", sub: "You can always add more later." },
  ];

  async function handleGoogle() {
    setAuthError("");
    setAuthLoading(true);
    try {
      await signInWithGoogle();
      // onAuthStateChanged in App() takes over — moves to main app
      setStep(1);
    } catch (e) {
      setAuthError("Sign-in failed — please try again.");
      setAuthLoading(false);
    }
  }

  function handleProfile() {
    update(() => ({ profile: { age: form.age, income: form.income, expense: form.expense, savings: form.savings } }));
    setStep(2);
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "var(--color-background-tertiary)", fontFamily: "'DM Sans', sans-serif" }}>
      <style>{LIGHT_MODE_STYLE}</style>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Serif+Display&display=swap" rel="stylesheet" />
      <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 28, marginBottom: 8 }}>FinTrack</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 28 }}>
        {steps.map((_, i) => <div key={i} style={{ width: i === step ? 28 : 8, height: 8, borderRadius: 4, background: i === step ? "#1a6b3c" : i < step ? "#1a6b3c80" : "var(--color-border-tertiary)", transition: "all 0.3s" }} />)}
      </div>
      <div style={{ background: "var(--color-background-primary)", borderRadius: 16, border: "0.5px solid var(--color-border-tertiary)", padding: "2rem", width: "min(480px, 90vw)" }}>
        <h2 style={{ textAlign: "center", marginBottom: 8, fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 22 }}>{steps[step].title}</h2>
        <p style={{ textAlign: "center", color: "var(--color-text-secondary)", fontSize: 14, marginBottom: 24 }}>{steps[step].sub}</p>

        {step === 0 && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 24 }}>
              {[["◈", "Track assets & liabilities"], ["⊕", "Multi-currency support"], ["✓", "Private & secure"]].map(([icon, label]) => (
                <div key={label} style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "1rem", textAlign: "center", fontSize: 12, color: "var(--color-text-secondary)" }}>
                  <div style={{ fontSize: 20, color: "#1a6b3c", marginBottom: 6 }}>{icon}</div>{label}
                </div>
              ))}
            </div>
            <GoogleBtn onClick={handleGoogle} disabled={authLoading} label={authLoading ? "Signing in…" : undefined} />
            {authError && <p style={{ color: "#d44", fontSize: 13, textAlign: "center", marginTop: 10 }}>{authError}</p>}
          </div>
        )}

        {step === 1 && (
          <div>
            {[["age", "Age", "e.g. 30", "number"], ["income", "Monthly Income (₹ INR)", "e.g. 1,00,000", "text"], ["expense", "Avg. Monthly Family Expense (₹ INR)", "e.g. 50,000", "text"], ["savings", "Monthly Savings / Investments (₹ INR)", "e.g. 30,000", "text"]].map(([key, label, ph, type]) => (
              <div key={key} style={{ marginBottom: 14 }}>
                <label style={{ display: "block", fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 4 }}>{label}</label>
                <input type={type} placeholder={ph} value={form[key] || ""} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20 }}>
              <button onClick={() => setStep(0)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)" }}>Back</button>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setStep(2)} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", padding: "0.4rem 1rem", borderRadius: 8, cursor: "pointer", color: "var(--color-text-secondary)" }}>Skip</button>
                <GreenBtn onClick={handleProfile} label="Continue →" />
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <div style={{ border: "1.5px dashed var(--color-border-secondary)", borderRadius: 10, padding: "1rem", display: "flex", alignItems: "center", gap: 12, marginBottom: 20, cursor: "pointer" }}>
              <span style={{ fontSize: 20 }}>⬆</span>
              <div><div style={{ fontWeight: 500, fontSize: 14 }}>Import from Broker</div><div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Upload CSV/Excel from Zerodha, Groww, or any broker</div></div>
              <span style={{ marginLeft: "auto" }}>→</span>
            </div>
            <div style={{ textAlign: "center", fontSize: 12, color: "var(--color-text-secondary)", margin: "10px 0" }}>or add manually</div>
            <AddAssetMini update={update} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20 }}>
              <button onClick={() => setStep(1)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)" }}>Back</button>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={done} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", padding: "0.4rem 1rem", borderRadius: 8, cursor: "pointer", color: "var(--color-text-secondary)" }}>Skip</button>
                <GreenBtn onClick={done} label="Save →" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AddAssetMini({ update }) {
  const [type, setType] = useState("Stocks & Equity");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4, display: "block" }}>Asset Type</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {ASSET_TYPES.slice(0, 6).map(t => (
            <button key={t} onClick={() => setType(t)} style={{ padding: "4px 10px", borderRadius: 6, border: "0.5px solid", borderColor: type === t ? "#1a6b3c" : "var(--color-border-secondary)", background: type === t ? "#e8f5ee" : "transparent", fontSize: 12, cursor: "pointer", color: type === t ? "#1a6b3c" : "var(--color-text-secondary)" }}>{t}</button>
          ))}
        </div>
      </div>
      <input placeholder="Name (e.g. HDFC Balanced Advantage Fund)" value={name} onChange={e => setName(e.target.value)} style={{ width: "100%", marginBottom: 8, boxSizing: "border-box" }} />
      <input placeholder="Current Value (INR)" value={value} onChange={e => setValue(e.target.value)} style={{ width: "100%", marginBottom: 8, boxSizing: "border-box" }} />
      <button onClick={() => { if (name && value) { update(p => ({ assets: [...p.assets, { id: Date.now(), type, name, value: parseFloat(value.replace(/,/g, "")), date: new Date().toISOString() }] })); setName(""); setValue(""); } }}
        style={{ background: "#e8f5ee", color: "#1a6b3c", border: "0.5px solid #1a6b3c", borderRadius: 8, padding: "6px 16px", cursor: "pointer", fontSize: 13, fontWeight: 500 }}>+ Add Asset</button>
    </div>
  );
}


// ─── Profile Page ─────────────────────────────────────────────────────────────
function ProfilePage({ data, update }) {
  const profile = data.userProfile || {};
  const [name, setName] = useState(profile.name || data.user?.name || "");
  const [dob, setDob] = useState(profile.dob || "");
  const [widgetType, setWidgetType] = useState(profile.widgetType || "none");
  const [customWidget, setCustomWidget] = useState(profile.customWidget || "");
  const [saved, setSaved] = useState(false);

  function calcAge(dobStr) {
    if (!dobStr) return null;
    const birth = new Date(dobStr);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age;
  }

  const age = calcAge(dob);

  function save() {
    update(() => ({ userProfile: { name, dob, widgetType, customWidget } }));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const cardStyle = { background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "1.4rem 1.6rem", marginBottom: 16 };
  const labelStyle = { fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" };
  const inputStyle = { width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--color-border-primary)", fontSize: 14, boxSizing: "border-box" };

  const WIDGET_OPTIONS = [
    { id: "none",       label: "None",               desc: "No widget" },
    { id: "clock",      label: "🕐 Live Clock",       desc: "Shows current time" },
    { id: "greeting",   label: "👋 Greeting",         desc: "Good morning / afternoon / evening with your name" },
    { id: "quote",      label: "💬 Daily Quote",      desc: "A motivational quote" },
    { id: "networth",   label: "📊 Net Worth Trend",  desc: "Quick net worth snapshot" },
    { id: "custom",     label: "✏️ Custom Text",      desc: "Write whatever you want" },
  ];

  return (
    <div>
      <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26, marginBottom: 4 }}>Profile</h1>
      <p style={{ color: "var(--color-text-secondary)", fontSize: 14, marginBottom: 20 }}>Personalise your FinTrack experience.</p>

      {/* Personal Info */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <span style={{ fontSize: 18 }}>👤</span>
          <span style={{ fontWeight: 600, fontSize: 15 }}>Personal Info</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={labelStyle}>Display Name</label>
            <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
          </div>
          <div>
            <label style={labelStyle}>Date of Birth</label>
            <input type="date" style={inputStyle} value={dob} onChange={e => setDob(e.target.value)} />
          </div>
        </div>
        {age !== null && (
          <div style={{ marginTop: 12, padding: "10px 14px", background: "#f0f9f4", borderRadius: 8, border: "0.5px solid #b7dfc8", display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>🎂</span>
            <span style={{ fontSize: 14, fontWeight: 600, color: "#1a6b3c" }}>Age: {age} years old</span>
          </div>
        )}
      </div>



      {/* Overview Widget */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 18 }}>🧩</span>
          <span style={{ fontWeight: 600, fontSize: 15 }}>Overview Widget</span>
        </div>
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>Choose what to display in the widget area on the right side of your Overview.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
          {WIDGET_OPTIONS.map(opt => (
            <button key={opt.id} onClick={() => setWidgetType(opt.id)} style={{
              padding: "12px 14px", borderRadius: 10, textAlign: "left",
              border: widgetType === opt.id ? "2px solid #1a6b3c" : "1px solid var(--color-border-primary)",
              background: widgetType === opt.id ? "#f0f9f4" : "var(--color-background-secondary)",
              cursor: "pointer"
            }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: widgetType === opt.id ? "#1a6b3c" : "var(--color-text-primary)", marginBottom: 3 }}>{opt.label}</div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{opt.desc}</div>
            </button>
          ))}
        </div>
        {widgetType === "custom" && (
          <div>
            <label style={labelStyle}>Custom Widget Content</label>
            <textarea
              style={{ ...inputStyle, minHeight: 80, resize: "vertical", fontFamily: "inherit" }}
              value={customWidget}
              onChange={e => setCustomWidget(e.target.value)}
              placeholder="Type anything you want to display — a note, a goal, a reminder..."
            />
          </div>
        )}
      </div>

      {/* Save */}
      <button onClick={save} style={{
        padding: "10px 28px", borderRadius: 8, border: "none", cursor: "pointer",
        background: saved ? "#2d9e5f" : "#1a6b3c", color: "#fff", fontWeight: 600, fontSize: 14,
        transition: "background 0.3s"
      }}>
        {saved ? "✓ Saved!" : "Save Profile"}
      </button>
    </div>
  );
}

// ─── Overview ─────────────────────────────────────────────────────────────────
function Overview({ data, netWorth, foNetPnl, setPage, toggles, update, portfolioOn }) {
  const foOn = toggles?.fo !== false;
  const todayStr = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const [period, setPeriod] = useState(data.overviewDefaultPeriod || "all");
  const [clockTime, setClockTime] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setClockTime(new Date()), 1000); return () => clearInterval(t); }, []);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const h = e => setIsMobile(e.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);

  const userProfile = data.userProfile || {};
  const widgetType = userProfile.widgetType || "none";
  const profileName = userProfile.name || data.user?.name || "";

  function getGreeting() {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  }

  const QUOTES = [
    "A budget is telling your money where to go instead of wondering where it went.",
    "Do not save what is left after spending, but spend what is left after saving.",
    "Financial freedom is available to those who learn about it and work for it.",
    "The stock market is filled with individuals who know the price of everything, but the value of nothing.",
    "It's not your salary that makes you rich, it's your spending habits.",
    "Wealth is not about having a lot of money; it's about having a lot of options.",
  ];
  const dailyQuote = QUOTES[new Date().getDate() % QUOTES.length];

  function OverviewWidget({ compact }) {
    if (widgetType === "none") return null;
    const box = compact
      ? { display: "flex", alignItems: "center", gap: 8, padding: "4px 16px", borderRadius: 20, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)" }
      : { background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.2rem", display: "flex", flexDirection: "column", justifyContent: "center" };
    if (widgetType === "clock") return (
      <div style={box}>
        <span style={{ fontSize: 18 }}>🕐</span>
        <div>
          <div style={{ fontSize: compact ? 16 : 32, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "var(--color-text-primary)", letterSpacing: 1 }}>
            {clockTime.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </div>
          {!compact && <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>{clockTime.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}</div>}
          {compact && <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{clockTime.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</div>}
        </div>
      </div>
    );
    if (widgetType === "greeting") return (
      <div style={box}>
        <div style={{ fontSize: 26, fontWeight: 400, fontFamily: "'DM Serif Display', serif", color: "var(--color-text-primary)", whiteSpace: "nowrap", lineHeight: 1 }}>{getGreeting()}{profileName ? `, ${profileName.split(" ")[0]}` : ""}! 👋</div>
      </div>
    );
    if (widgetType === "quote") return (
      <div style={box}>
        <span style={{ fontSize: 16, flexShrink: 0 }}>💬</span>
        <div style={{ fontSize: compact ? 12 : 13, fontStyle: "italic", color: "var(--color-text-primary)", lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: compact ? 2 : 10, WebkitBoxOrient: "vertical" }}>"{dailyQuote}"</div>
      </div>
    );
    if (widgetType === "networth") return (
      <div style={box}>
        <span style={{ fontSize: 16 }}>📊</span>
        <div>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Net Worth</div>
          <div style={{ fontSize: compact ? 16 : 26, fontWeight: 700, color: "#1a6b3c" }}>{fmtCur(netWorth)}</div>
        </div>
      </div>
    );
    if (widgetType === "custom") return (
      <div style={box}>
        <div style={{ fontSize: compact ? 13 : 14, color: "var(--color-text-primary)", whiteSpace: "pre-wrap", lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: compact ? 2 : 10, WebkitBoxOrient: "vertical" }}>{userProfile.customWidget || "No custom content set. Edit in Settings → Profile."}</div>
      </div>
    );
    return null;
  }

  // ── Quick To-Do ───────────────────────────────────────────────────────────
  const todos = data.overviewTodos || [];
  const [newTodo, setNewTodo] = useState("");
  function addTodo() {
    const text = newTodo.trim();
    if (!text) return;
    update(p => ({ overviewTodos: [...(p.overviewTodos || []), { id: Date.now(), text, done: false }] }));
    setNewTodo("");
  }
  function toggleTodo(id) {
    update(p => ({ overviewTodos: (p.overviewTodos || []).map(t => t.id === id ? { ...t, done: !t.done } : t) }));
  }
  function deleteTodo(id) {
    update(p => ({ overviewTodos: (p.overviewTodos || []).filter(t => t.id !== id) }));
  }

  const thisYear  = new Date().getFullYear();
  const thisMonth = new Date().getMonth();

  function matchesPeriod(date) {
    if (period === "all") return true;
    const d = new Date(date);
    if (period === "year")  return d.getFullYear() === thisYear;
    if (period === "month") return d.getFullYear() === thisYear && d.getMonth() === thisMonth;
    return true;
  }

  const txs = data.transactions;
  const filteredIncome  = txs.filter(t => t.type === "income"  && matchesPeriod(t.date)).reduce((s, t) => s + Number(t.amount), 0);
  const filteredExpense = txs.filter(t => t.type === "expense" && matchesPeriod(t.date)).reduce((s, t) => s + Number(t.amount), 0);

  const PERIODS = [
    { key: "all",   label: "All Time" },
    { key: "year",  label: "This Year" },
    { key: "month", label: "This Month" },
  ];
  const periodLabel = PERIODS.find(p => p.key === period)?.label || "All Time";

  // Bank balances: sum income - expense per bank (exclude credit cards)
  const banks = data.banks || [];
  const bankBalances = banks.filter(bank => bank.type !== "Credit Card").map(bank => {
    const inc = data.transactions.filter(t => t.type === "income" && String(t.bankId) === String(bank.id)).reduce((s, t) => s + Number(t.amount || 0), 0);
    const exp = data.transactions.filter(t => t.type === "expense" && String(t.bankId) === String(bank.id)).reduce((s, t) => s + Number(t.amount || 0), 0);
    // For bank accounts and cash: normal calculation
    return { ...bank, balance: (bank.openingBalance || 0) + inc - exp };
  });

  return (
    <div>
      {/* Overview Header row: title left, widget pill right */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26, margin: 0 }}>Overview</h1>
        {widgetType !== "none" && <OverviewWidget compact />}
      </div>

      {/* Top stat row — responsive */}
      {isMobile ? (
        /* ── MOBILE: Net Worth full width, then Income+Expenses 2-col ── */
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
          <StatCard label="Net Worth · ₹ INR" value={fmtCur(netWorth)} sub={todayStr} accent big />
          {/* Period toggle — shared, shown once above the 2-col row */}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <div style={{ display: "flex", background: "var(--color-background-secondary)", borderRadius: 8, padding: 2, gap: 1 }}>
              {PERIODS.map(p => (
                <button key={p.key} onClick={() => setPeriod(p.key)}
                  style={{ padding: "3px 9px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 11, fontWeight: period === p.key ? 600 : 400, background: period === p.key ? "#1a6b3c" : "transparent", color: period === p.key ? "#fff" : "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {/* Income card — mobile, no toggle (period shared above) */}
            <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "0.9rem 1rem", display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>⊕ Total Income</span>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#1a6b3c" }}>{fmtCur(filteredIncome)}</div>
              <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{periodLabel}</div>
            </div>
            {/* Expenses card — mobile */}
            <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "0.9rem 1rem", display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>⊟ Total Expenses</span>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#d44" }}>{fmtCur(filteredExpense)}</div>
              <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{periodLabel}</div>
            </div>
          </div>
          {foOn && <StatCard label="F&O Net P&L" value={fmtCur(foNetPnl)} sub={`${data.foTrades.length} trades`} icon="◉" pnl={foNetPnl} />}
        </div>
      ) : (
        /* ── DESKTOP: original grid layout ── */
        <div style={{ display: "grid", gridTemplateColumns: foOn ? "repeat(auto-fit, minmax(160px, 1fr))" : "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 12 }}>
          <StatCard label="Net Worth · ₹ INR" value={fmtCur(netWorth)} sub={todayStr} accent big />

          {/* Income card with period toggle */}
          <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.1rem", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
              <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>⊕ Total Income</span>
              <div style={{ display: "flex", background: "var(--color-background-secondary)", borderRadius: 6, padding: 2, gap: 1 }}>
                {PERIODS.map(p => (
                  <button key={p.key} onClick={() => setPeriod(p.key)}
                    style={{ padding: "2px 7px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 10, fontWeight: period === p.key ? 600 : 400, background: period === p.key ? "#1a6b3c" : "transparent", color: period === p.key ? "#fff" : "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#1a6b3c" }}>{fmtCur(filteredIncome)}</div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{periodLabel}</div>
          </div>

          {/* Expenses card with same period toggle (synced) */}
          <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.1rem", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
              <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>⊟ Total Expenses</span>
              <div style={{ display: "flex", background: "var(--color-background-secondary)", borderRadius: 6, padding: 2, gap: 1 }}>
                {PERIODS.map(p => (
                  <button key={p.key} onClick={() => setPeriod(p.key)}
                    style={{ padding: "2px 7px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 10, fontWeight: period === p.key ? 600 : 400, background: period === p.key ? "#d44" : "transparent", color: period === p.key ? "#fff" : "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#d44" }}>{fmtCur(filteredExpense)}</div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{periodLabel}</div>
          </div>

          {foOn && <StatCard label="F&O Net P&L" value={fmtCur(foNetPnl)} sub={`${data.foTrades.length} trades`} icon="◉" pnl={foNetPnl} />}
        </div>
      )}

      {/* Portfolio + To-Do row */}
      <div style={{ display: "grid", gridTemplateColumns: portfolioOn && !isMobile ? "minmax(0,1fr) minmax(0,1fr)" : "1fr", gap: 12, marginBottom: 12 }}>

        {/* ── Portfolio Summary ── */}
        {portfolioOn && (() => {
          const mfs = data.mutualFunds || [];

          // ── Live USD→INR rate (saved by Portfolio page auto-fetch) ──────────────
          const usdInr = data.usdInrRate || 84;

          // ── Indian stocks (prices in ₹) ───────────────────────────────────────
          const indHoldings = data.portfolioHoldings || [];
          const indPrices   = data["portfolioHoldings_livePrices"] || {};
          const indInvested = indHoldings.reduce((s, h) => s + (h.buyPrice || 0) * (h.qty || 0), 0);
          const indCurrent  = indHoldings.reduce((s, h) => {
            const ticker = Object.keys(indPrices).find(k => k.startsWith(h.symbol));
            const ltp = ticker && indPrices[ticker]?.ok ? indPrices[ticker].price : (h.buyPrice || 0);
            return s + ltp * (h.qty || 0);
          }, 0);
          // Indian day change = sum of (change_per_share_₹ × qty)
          const indDayChange = indHoldings.reduce((s, h) => {
            const ticker = Object.keys(indPrices).find(k => k.startsWith(h.symbol));
            const pd = ticker ? indPrices[ticker] : null;
            if (pd?.ok && pd.change != null) return s + pd.change * (h.qty || 0);
            return s;
          }, 0);

          // ── US stocks (Yahoo prices in USD → convert to ₹) ───────────────────
          const usHoldings = data.usHoldings || [];
          const usPrices   = data["usHoldings_livePrices"] || {};
          // buyPrice stored in ₹ (converted on save)
          const usInvested = usHoldings.reduce((s, h) => s + (h.buyPrice || 0) * (h.qty || 0), 0);
          const usCurrent  = usHoldings.reduce((s, h) => {
            const ticker = Object.keys(usPrices).find(k => k.startsWith(h.symbol));
            const pd = ticker ? usPrices[ticker] : null;
            // Yahoo price is USD → multiply by usdInr to get ₹
            const ltpInr = pd?.ok ? pd.price * usdInr : (h.buyPrice || 0);
            return s + ltpInr * (h.qty || 0);
          }, 0);
          // US day change = sum of (change_per_share_USD × usdInr × qty)
          const usDayChange = usHoldings.reduce((s, h) => {
            const ticker = Object.keys(usPrices).find(k => k.startsWith(h.symbol));
            const pd = ticker ? usPrices[ticker] : null;
            if (pd?.ok && pd.change != null) return s + (pd.change * usdInr) * (h.qty || 0);
            return s;
          }, 0);

          // ── Mutual Funds (all in ₹) ───────────────────────────────────────────
          const mfInvested = mfs.reduce((s, m) => s + (m.investedAmount || 0), 0);
          const mfCurrent  = mfs.reduce((s, m) => s + (m.units || 0) * (m.nav || 0), 0);
          // MF has no intraday price feed — day change = 0
          const mfDayChange = 0;

          // ── Totals (all in ₹) ─────────────────────────────────────────────────
          const totalInvested  = indInvested + usInvested  + mfInvested;
          const totalCurrent   = indCurrent  + usCurrent   + mfCurrent;
          const totalReturn    = totalCurrent - totalInvested;
          const totalDayChange = indDayChange + usDayChange + mfDayChange;

          return (
            <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.1rem" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, borderBottom: "0.5px solid var(--color-border-tertiary)", paddingBottom: 10 }}>
                <span style={{ fontWeight: 500, fontSize: 15 }}>📈 Assets</span>
                <button onClick={() => setPage("portfolio")} style={{ fontSize: 12, color: "#1a6b3c", background: "none", border: "none", cursor: "pointer" }}>View →</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {[
                  { label: "Invested",      val: fmtCur(totalInvested), color: "var(--color-text-primary)" },
                  { label: "Current Value", val: fmtCur(totalCurrent),  color: "#1a6b3c" },
                  { label: "Total Return",  val: fmtCur(totalReturn),   color: totalReturn >= 0 ? "#1a6b3c" : "#d44" },
                  {
                    label: "Day Change",
                    val: (indDayChange !== 0 || usDayChange !== 0)
                      ? (totalDayChange >= 0 ? "▲ +" : "▼ ") + fmtCur(Math.abs(totalDayChange))
                      : "—",
                    color: (indDayChange === 0 && usDayChange === 0)
                      ? "var(--color-text-secondary)"
                      : totalDayChange >= 0 ? "#1a6b3c" : "#d44"
                  },
                ].map(c => (
                  <div key={c.label} style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginBottom: 3 }}>{c.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: c.color }}>{c.val}</div>
                  </div>
                ))}
              </div>
              {Object.keys(indPrices).length === 0 && Object.keys(usPrices).length === 0 && (
                <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 8, textAlign: "center" }}>Open Portfolio and click Refresh to load live prices</div>
              )}
            </div>
          );
        })()}

        {/* ── Quick To-Do (right side) ── */}
        <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.1rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, borderBottom: "0.5px solid var(--color-border-tertiary)", paddingBottom: 10 }}>
            <span style={{ fontWeight: 500, fontSize: 15 }}>✅ To-Do</span>
            <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
              {todos.filter(t => t.done).length}/{todos.length} done
            </span>
          </div>

          {/* Input */}
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <input
              value={newTodo}
              onChange={e => setNewTodo(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addTodo()}
              placeholder="Add a task…"
              style={{ flex: 1, fontSize: 13, padding: "6px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", outline: "none", fontFamily: "inherit", background: "var(--color-background-secondary)", color: "var(--color-text-primary)" }}
            />
            <button onClick={addTodo}
              style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
              +
            </button>
          </div>

          {/* List */}
          {todos.length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--color-text-secondary)", fontSize: 12, padding: "1rem 0", fontStyle: "italic" }}>
              No tasks yet — add one above
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }}>
              {/* Pending first */}
              {todos.filter(t => !t.done).map(t => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 8, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)" }}>
                  <button onClick={() => toggleTodo(t.id)}
                    style={{ width: 18, height: 18, borderRadius: 4, border: "1.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }} />
                  <span style={{ flex: 1, fontSize: 13, color: "var(--color-text-primary)", wordBreak: "break-word" }}>{t.text}</span>
                  <button onClick={() => deleteTodo(t.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#d44", fontSize: 13, opacity: 0.45, padding: "0 2px", lineHeight: 1, flexShrink: 0 }}>✕</button>
                </div>
              ))}
              {/* Completed */}
              {todos.filter(t => t.done).map(t => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 8, background: "transparent", border: "0.5px solid var(--color-border-tertiary)", opacity: 0.55 }}>
                  <button onClick={() => toggleTodo(t.id)}
                    style={{ width: 18, height: 18, borderRadius: 4, border: "1.5px solid #1a6b3c", background: "#e8f5ee", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#1a6b3c", fontSize: 11 }}>✓</button>
                  <span style={{ flex: 1, fontSize: 13, color: "var(--color-text-secondary)", textDecoration: "line-through", wordBreak: "break-word" }}>{t.text}</span>
                  <button onClick={() => deleteTodo(t.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#d44", fontSize: 13, opacity: 0.45, padding: "0 2px", lineHeight: 1, flexShrink: 0 }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* F&O summary row */}
      {foOn && (
        <div style={{ marginBottom: 12 }}>
          <Card title="F&O Summary" action={<button onClick={() => setPage("fo")} style={{ fontSize: 12, color: "#1a6b3c", background: "none", border: "none", cursor: "pointer" }}>View all →</button>}>
            <FOSummaryMini trades={data.foTrades} netPnl={foNetPnl} />
          </Card>
        </div>
      )}

      {/* Bank balances */}
      {bankBalances.length > 0 && (
        <Card title="Bank Balances" action={<button onClick={() => setPage("money")} style={{ fontSize: 12, color: "#1a6b3c", background: "none", border: "none", cursor: "pointer" }}>Manage →</button>}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10, marginTop: 8 }}>
            {bankBalances.map(b => (
              <div key={b.id} style={{ background: "var(--color-background-secondary)", borderRadius: 10, padding: "10px 14px", border: "0.5px solid var(--color-border-tertiary)" }}>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>{b.name}</div>
                <div style={{ fontWeight: 600, fontSize: 16, color: b.balance >= 0 ? "var(--color-text-primary)" : "#d44" }}>{fmtCur(b.balance)}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {bankBalances.length === 0 && (
        <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px dashed var(--color-border-secondary)", padding: "1.2rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
          Add accounts in the <button onClick={() => setPage("money")} style={{ background: "none", border: "none", color: "#1a6b3c", cursor: "pointer", fontWeight: 500, fontSize: 13 }}>Money → Accounts</button> tab to track balances here.
        </div>
      )}
    </div>
  );
}

function FOSummaryMini({ trades, netPnl }) {
  const winning = trades.filter(t => (Number(t.sellPremium) - Number(t.buyPremium)) > 0).length;
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 8 }}>
        <div style={{ textAlign: "center" }}><div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Total Trades</div><div style={{ fontWeight: 500 }}>{trades.length}</div></div>
        <div style={{ textAlign: "center" }}><div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Winners</div><div style={{ fontWeight: 500, color: "#1a6b3c" }}>{winning}</div></div>
        <div style={{ textAlign: "center" }}><div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Net P&L</div><div style={{ fontWeight: 500, color: netPnl >= 0 ? "#1a6b3c" : "#d44" }}>{fmtCur(netPnl)}</div></div>
      </div>
    </div>
  );
}

function AssetPie({ assets }) {
  if (assets.length === 0) return <p style={{ color: "var(--color-text-secondary)", fontSize: 13, padding: "1rem 0" }}>Add assets to see allocation.</p>;
  const total = assets.reduce((s, a) => s + Number(a.value), 0);
  const grouped = {};
  assets.forEach(a => { grouped[a.type] = (grouped[a.type] || 0) + Number(a.value); });
  const colors = ["#1a6b3c", "#2d9e5f", "#4cc97a", "#9fe1c0", "#c5efd8", "#e8f5ee", "#0d4a2a", "#68d9a0"];
  const items = Object.entries(grouped).map(([k, v], i) => ({ label: k, value: v, pct: (v / total * 100).toFixed(1), color: colors[i % colors.length] }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      {items.map(item => (
        <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: item.color, flexShrink: 0 }} />
          <span style={{ flex: 1, color: "var(--color-text-secondary)" }}>{item.label}</span>
          <span style={{ fontWeight: 500 }}>{item.pct}%</span>
        </div>
      ))}
    </div>
  );
}

// ─── Money ────────────────────────────────────────────────────────────────────
function MoneyPage({ data, update, tab, setTab }) {
  const accounts = data.banks || [];
  const categories = data.categories || { expense: ["Food", "Rent", "Travel", "Shopping", "Health", "Bills", "EMI", "Other"], income: ["Salary", "Freelance", "Investment", "Business", "Gift", "Other"] };
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const h = e => setIsMobile(e.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);

  const nowTime = () => { const n = new Date(); return n.toTimeString().slice(0,5); };
  const [form, setForm] = useState({ type: "expense", amount: "", category: "", note: "", date: today(), time: nowTime(), bankId: "", accountType: "all" });
  const [period, setPeriod] = useState("12M");

  // Account form state
  const [acctForm, setAcctForm] = useState({ name: "", type: "Bank", balance: "", creditLimit: "", dueDate: "" });
  const [editAcct, setEditAcct] = useState(null); // account being edited

  // Category management
  const [newCat, setNewCat] = useState({ type: "expense", name: "" });
  const [editCat, setEditCat] = useState(null); // { type, oldName }
  const [editCatName, setEditCatName] = useState("");

  // Adjust balance modal
  const [adjusting, setAdjusting] = useState(null);
  const [adjustAmt, setAdjustAmt] = useState("");
  const [adjustNote, setAdjustNote] = useState("");

  const filterPeriod = t => {
    const d = new Date(t.date), now = new Date();
    if (period === "This Week") { const w = new Date(now); w.setDate(now.getDate() - 7); return d >= w; }
    if (period === "This Month") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    if (period === "Last Month") { const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1); return d.getMonth() === lm.getMonth() && d.getFullYear() === lm.getFullYear(); }
    if (period === "6M") { const s = new Date(now); s.setMonth(now.getMonth() - 6); return d >= s; }
    return true;
  };

  const filtered = data.transactions.filter(t =>
    filterPeriod(t) && t.type === (tab === "expenses" ? "expense" : "income") && !t.isTransfer
  );

  function addTx() {
    if (!form.amount) return;
    const type = tab === "income" ? "income" : "expense";
    update(p => ({ transactions: [...p.transactions, { id: Date.now(), ...form, amount: parseFloat(form.amount), type }] }));
    setForm(p => ({ ...p, amount: "", category: "", note: "", date: today(), time: nowTime() }));
  }

  function addAccount() {
    if (!acctForm.name.trim()) return;
    const opening = parseFloat(acctForm.balance) || 0;
    update(p => ({ banks: [...(p.banks || []), {
      id: Date.now(),
      name: acctForm.name.trim(),
      type: acctForm.type,
      openingBalance: opening,
      balance: opening,
      creditLimit: acctForm.type === "Credit Card" ? parseFloat(acctForm.creditLimit) || 0 : undefined,
      dueDate: acctForm.type === "Credit Card" ? acctForm.dueDate : undefined
    }] }));
    setAcctForm({ name: "", type: "Bank", balance: "", creditLimit: "", dueDate: "" });
  }

  function saveEditAcct() {
    if (!editAcct || !editAcct.name.trim()) return;
    update(p => ({ banks: (p.banks || []).map(b => b.id === editAcct.id ? { ...b, name: editAcct.name, openingBalance: editAcct.openingBalance ?? b.openingBalance, creditLimit: editAcct.creditLimit, dueDate: editAcct.dueDate } : b) }));
    setEditAcct(null);
  }

  function addCategory() {
    if (!newCat.name.trim()) return;
    const cats = data.categories || { expense: ["Food","Rent","Travel","Shopping","Health","Bills","EMI","Other"], income: ["Salary","Freelance","Investment","Business","Gift","Other"] };
    const list = cats[newCat.type] || [];
    if (list.includes(newCat.name.trim())) return;
    update(() => ({ categories: { ...cats, [newCat.type]: [...list, newCat.name.trim()] } }));
    setNewCat(p => ({ ...p, name: "" }));
  }

  function saveEditCat() {
    if (!editCat || !editCatName.trim()) return;
    const cats = data.categories || { expense: [], income: [] };
    const list = (cats[editCat.type] || []).map(c => c === editCat.oldName ? editCatName.trim() : c);
    update(() => ({ categories: { ...cats, [editCat.type]: list }, transactions: data.transactions.map(t => t.category === editCat.oldName ? { ...t, category: editCatName.trim() } : t) }));
    setEditCat(null); setEditCatName("");
  }

  function deleteCategory(type, name) {
    const cats = data.categories || { expense: [], income: [] };
    update(() => ({ categories: { ...cats, [type]: (cats[type] || []).filter(c => c !== name) } }));
  }

  function deleteAccount(id) {
    update(p => ({ banks: (p.banks || []).filter(b => b.id !== id) }));
  }

  function applyAdjustment(direction) {
    if (!adjustAmt || !adjusting) return;
    const amt = parseFloat(adjustAmt);
    if (isNaN(amt) || amt <= 0) return;
    const adjustingId = adjusting.id;
    const adjustingName = adjusting.name;
    const note = adjustNote;
    update(p => {
      const newTx = {
        id: Date.now(),
        type: direction === "add" ? "income" : "expense",
        amount: amt,
        category: note || (direction === "add" ? "Balance Top-up" : "Balance Adjustment"),
        note: `${adjustingName} manual adjustment`,
        date: today(),
        bankId: adjustingId
      };
      return { transactions: [...p.transactions, newTx] };
    });
    setAdjusting(null); setAdjustAmt(""); setAdjustNote("");
  }

  const [editTx, setEditTx] = useState(null); // transaction being edited

  function saveEditTx() {
    if (!editTx) return;
    update(p => ({ transactions: p.transactions.map(t => t.id === editTx.id ? { ...editTx, amount: parseFloat(editTx.amount) } : t) }));
    setEditTx(null);
  }
  const expense = data.transactions.filter(t => t.type === "expense" && filterByPeriod(t.date, period)).reduce((s, t) => s + Number(t.amount), 0);

  const pageTitle = { expenses: "Expenses", income: "Income", recent: "Recent Transactions", transactions: "Transactions", scheduled: "Scheduled Payments", liabilities: "Liabilities" }[tab];

  const banks = accounts.filter(a => a.type === "Bank");
  const cards = accounts.filter(a => a.type === "Credit Card");
  const cashAccounts = accounts.filter(a => a.type === "Cash");

  return (
    <div>
      {/* Edit Transaction Modal */}
      {editTx && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 16, padding: "1.5rem", width: "min(420px, 90vw)", border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 16 }}>✏️ Edit {editTx.type === "income" ? "Income" : "Expense"}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Date</label>
                <input type="date" value={editTx.date} onChange={e => setEditTx(p => ({ ...p, date: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Time <span style={{ fontWeight: 400, opacity: 0.6 }}>(optional)</span></label>
                <input type="time" value={editTx.time || ""} onChange={e => setEditTx(p => ({ ...p, time: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Amount (₹)</label>
                <input type="number" value={editTx.amount} onChange={e => setEditTx(p => ({ ...p, amount: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontWeight: 600 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Category</label>
                <select 
                  value={editTx.category || ""} 
                  onChange={e => setEditTx(p => ({ ...p, category: e.target.value }))} 
                  style={{ width: "100%", boxSizing: "border-box" }}
                >
                  <option value="">Select a category</option>
                  {(categories[editTx.type === "income" ? "income" : "expense"] || []).map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Account</label>
                <select value={editTx.bankId || ""} onChange={e => setEditTx(p => ({ ...p, bankId: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
                  <option value="">— None —</option>
                  
                  {/* Bank Accounts Group */}
                  {accounts.filter(a => a.type === "Bank").length > 0 && (
                    <optgroup label="🏦 Bank Accounts">
                      {accounts.filter(a => a.type === "Bank").map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </optgroup>
                  )}
                  
                  {/* Credit Card Accounts Group */}
                  {accounts.filter(a => a.type === "Credit Card").length > 0 && (
                    <optgroup label="💳 Credit Cards">
                      {accounts.filter(a => a.type === "Credit Card").map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </optgroup>
                  )}
                  
                  {/* Cash Accounts Group */}
                  {accounts.filter(a => a.type === "Cash").length > 0 && (
                    <optgroup label="💵 Cash">
                      {accounts.filter(a => a.type === "Cash").map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Notes</label>
                <input value={editTx.note || ""} onChange={e => setEditTx(p => ({ ...p, note: e.target.value }))} placeholder="Optional note" style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setEditTx(null)} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "8px 16px", cursor: "pointer", color: "var(--color-text-secondary)" }}>Cancel</button>
              <button onClick={saveEditTx} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontWeight: 600 }}>Save Changes</button>
            </div>
          </div>
        </div>
      )}
      {/* Edit Account Modal */}
      {editAcct && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 16, padding: "1.5rem", width: "min(380px, 90vw)", border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 16 }}>✏️ Edit Account</div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Account Name</label>
              <input value={editAcct.name} onChange={e => setEditAcct(p => ({ ...p, name: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
            </div>
            {editAcct.type === "Credit Card" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Outstanding Balance (₹)</label>
                  <input type="number" placeholder="e.g. 5000" value={editAcct.openingBalance ?? ""} onChange={e => setEditAcct(p => ({ ...p, openingBalance: parseFloat(e.target.value) || 0 }))} style={{ width: "100%", boxSizing: "border-box" }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Card Limit (₹)</label>
                  <input type="number" value={editAcct.creditLimit || ""} onChange={e => setEditAcct(p => ({ ...p, creditLimit: parseFloat(e.target.value) || 0 }))} style={{ width: "100%", boxSizing: "border-box" }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Due Date (day)</label>
                  <input type="number" min="1" max="31" value={editAcct.dueDate || ""} onChange={e => setEditAcct(p => ({ ...p, dueDate: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => setEditAcct(null)} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "8px 16px", cursor: "pointer", color: "var(--color-text-secondary)" }}>Cancel</button>
              <button onClick={saveEditAcct} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontWeight: 600 }}>Save</button>
            </div>
          </div>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26 }}>{pageTitle || (tab === "recent" ? "Recent Transactions" : tab)}</h1>
        {(tab === "income" || tab === "expenses") && <GreenBtn onClick={addTx} label="+ Add" />}
      </div>
      <TabBar tabs={["transactions", "expenses", "income", "transfer", "scheduled", "liabilities", "analysis"]} active={tab} setActive={setTab} labels={["Transactions", "Expenses", "Income", "Transfer", "Scheduled", "Liabilities", "Analysis"]} />

      {/* ── Transfer Tab ── */}
      {tab === "transfer" && <TransferTab data={data} update={update} accounts={accounts} />}

      {/* ── Scheduled Payments Tab ── */}
      {tab === "scheduled" && <ScheduledPaymentsTab data={data} update={update} accounts={accounts} />}

      {/* ── Income / Expense Tabs ── */}
      {(tab === "income" || tab === "expenses") && (
        <>
          <PeriodBar periods={["This Week", "This Month", "Last Month", "6M", "12M"]} active={period} setActive={setPeriod} />
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1.4fr", gap: 16, marginTop: 16 }}>
            <Card title={`Add ${tab === "income" ? "Income" : "Expense"}`}>
              <LabelInput label="Amount (INR)" placeholder="e.g. 5000" value={form.amount} onChange={v => setForm(p => ({ ...p, amount: v }))} />
              <LabelInput label="Notes" placeholder="optional" value={form.note} onChange={v => setForm(p => ({ ...p, note: v }))} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Date</label>
                  <input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Time <span style={{ fontWeight: 400, opacity: 0.6 }}>(optional)</span></label>
                  <input type="time" value={form.time || ""} onChange={e => setForm(p => ({ ...p, time: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
                </div>
              </div>

              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Category</label>
                <select 
                  value={form.category || ""} 
                  onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
                  style={{ width: "100%", boxSizing: "border-box" }}
                >
                  <option value="">Select a category</option>
                  {(categories[tab === "income" ? "income" : "expense"] || []).map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              {/* Account selector — Dropdown with grouped options */}
              {accounts.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Account</label>
                  <select 
                    value={form.bankId || ""} 
                    onChange={e => setForm(p => ({ ...p, bankId: e.target.value }))}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  >
                    <option value="">Select an account</option>
                    
                    {/* Bank Accounts Group */}
                    {accounts.filter(a => a.type === "Bank").length > 0 && (
                      <optgroup label="🏦 Bank Accounts">
                        {accounts.filter(a => a.type === "Bank").map(b => (
                          <option key={b.id} value={b.id}>{b.name}</option>
                        ))}
                      </optgroup>
                    )}
                    
                    {/* Credit Card Accounts Group */}
                    {accounts.filter(a => a.type === "Credit Card").length > 0 && (
                      <optgroup label="💳 Credit Cards">
                        {accounts.filter(a => a.type === "Credit Card").map(b => (
                          <option key={b.id} value={b.id}>{b.name}</option>
                        ))}
                      </optgroup>
                    )}
                    
                    {/* Cash Accounts Group */}
                    {accounts.filter(a => a.type === "Cash").length > 0 && (
                      <optgroup label="💵 Cash">
                        {accounts.filter(a => a.type === "Cash").map(b => (
                          <option key={b.id} value={b.id}>{b.name}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
              )}
              {accounts.length === 0 && (
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 10 }}>
                  <button onClick={() => setTab("accounts")} style={{ background: "none", border: "none", color: "#1a6b3c", cursor: "pointer", fontSize: 11, padding: 0 }}>+ Add an account</button> to link transactions
                </div>
              )}
              <GreenBtn onClick={addTx} label="+ Add Entry" />
            </Card>

            <CategoryBreakdownCard transactions={filtered} type={tab === "income" ? "income" : "expense"} period={period} />
          </div>
        </>
      )}

      {/* ── Transactions Dashboard Tab ── */}
      {tab === "transactions" && <TransactionsDashboardTab data={data} update={update} accounts={accounts} setEditTx={setEditTx} />}

      {/* ── Liabilities Tab ── */}
      {tab === "liabilities" && <LiabilitiesTab data={data} update={update} />}
      {tab === "analysis" && <AnalysisTab data={data} />}
    </div>
  );
}

// ─── Category Breakdown Card ─────────────────────────────────────────────────
const CAT_COLORS_EXP = ["#ef4444","#f97316","#eab308","#84cc16","#06b6d4","#8b5cf6","#ec4899","#14b8a6","#f59e0b","#6366f1","#10b981","#e11d48"];
const CAT_COLORS_INC = ["#1a6b3c","#2d9e5f","#4cc97a","#9fe1c0","#0d4a2a","#68d9a0","#34d399","#059669","#10b981","#6ee7b7","#a7f3d0","#d1fae5"];

function CategoryBreakdownCard({ transactions, type, period }) {
  const isIncome = type === "income";
  const COLORS = isIncome ? CAT_COLORS_INC : CAT_COLORS_EXP;
  const accentColor = isIncome ? "#1a6b3c" : "#ef4444";

  // Build category map
  const catMap = {};
  transactions.forEach(t => {
    const key = t.category || "Uncategorized";
    catMap[key] = (catMap[key] || 0) + Number(t.amount || 0);
  });
  const items = Object.entries(catMap)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
  const total = items.reduce((s, i) => s + i.value, 0);

  // SVG donut dimensions
  const SIZE = 160, CX = 80, CY = 80, R = 62, STROKE = 22;
  const circumference = 2 * Math.PI * R;

  // Build arc segments
  let offset = 0;
  const arcs = items.map((item, idx) => {
    const pct = total > 0 ? item.value / total : 0;
    const dash = pct * circumference;
    const gap = circumference - dash;
    const seg = { ...item, pct, dash, gap, offset, color: COLORS[idx % COLORS.length] };
    offset += dash;
    return seg;
  });

  const [hovered, setHovered] = useState(null);
  const hoveredItem = hovered !== null ? arcs[hovered] : null;

  if (transactions.length === 0) {
    return (
      <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "2rem 1.2rem", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 260 }}>
        <div style={{ fontSize: 36 }}>{isIncome ? "💰" : "🥧"}</div>
        <div style={{ fontWeight: 600, fontSize: 15, color: "var(--color-text-primary)" }}>{isIncome ? "Income" : "Expenses"} Breakdown</div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>No {isIncome ? "income" : "expenses"} recorded yet</div>
      </div>
    );
  }

  return (
    <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1.2rem" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <span style={{ fontSize: 18 }}>{isIncome ? "💰" : "🥧"}</span>
        <span style={{ fontWeight: 600, fontSize: 15, color: "var(--color-text-primary)" }}>{isIncome ? "Income" : "Expenses"} Breakdown</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-text-secondary)", background: "var(--color-background-secondary)", borderRadius: 6, padding: "2px 8px" }}>{transactions.length} entries</span>
      </div>

      {/* Donut chart + legend side by side */}
      <div style={{ display: "flex", gap: 20, alignItems: "center", marginBottom: 16 }}>
        {/* SVG Donut */}
        <div style={{ position: "relative", flexShrink: 0, width: SIZE, height: SIZE }}>
          <svg width={SIZE} height={SIZE} style={{ transform: "rotate(-90deg)" }}>
            {/* Background ring */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--color-background-secondary)" strokeWidth={STROKE} />
            {/* Segments */}
            {arcs.map((seg, idx) => (
              <circle key={seg.label} cx={CX} cy={CY} r={R} fill="none"
                stroke={seg.color}
                strokeWidth={hovered === idx ? STROKE + 4 : STROKE}
                strokeDasharray={`${seg.dash} ${seg.gap}`}
                strokeDashoffset={-seg.offset}
                strokeLinecap="butt"
                style={{ cursor: "pointer", transition: "stroke-width 0.15s" }}
                onMouseEnter={() => setHovered(idx)}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
          </svg>
          {/* Center label */}
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            {hoveredItem ? (
              <>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", textAlign: "center", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hoveredItem.label}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: accentColor }}>₹{hoveredItem.value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{(hoveredItem.pct * 100).toFixed(1)}%</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>Total</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: accentColor }}>₹{total.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</div>
              </>
            )}
          </div>
        </div>

        {/* Legend */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          {arcs.slice(0, 6).map((seg, idx) => (
            <div key={seg.label}
              onMouseEnter={() => setHovered(idx)}
              onMouseLeave={() => setHovered(null)}
              style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", opacity: hovered === null || hovered === idx ? 1 : 0.45, transition: "opacity 0.15s" }}>
              <div style={{ width: 10, height: 10, borderRadius: 3, background: seg.color, flexShrink: 0 }} />
              <div style={{ flex: 1, fontSize: 12, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seg.label}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: accentColor, flexShrink: 0 }}>₹{seg.value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</div>
            </div>
          ))}
          {arcs.length > 6 && (
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>+{arcs.length - 6} more categories</div>
          )}
        </div>
      </div>

      {/* Full bar breakdown */}
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {arcs.map((seg, idx) => (
          <div key={seg.label}
            onMouseEnter={() => setHovered(idx)}
            onMouseLeave={() => setHovered(null)}
            style={{ cursor: "pointer" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ fontSize: 12, color: "var(--color-text-primary)", fontWeight: hovered === idx ? 600 : 400 }}>{seg.label}</span>
              <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{(seg.pct * 100).toFixed(1)}%</span>
            </div>
            <div style={{ height: 5, borderRadius: 4, background: "var(--color-background-secondary)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${seg.pct * 100}%`, background: seg.color, borderRadius: 4, transition: "width 0.4s ease" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Transactions Dashboard Tab ──────────────────────────────────────────────
function TransactionsDashboardTab({ data, update, accounts, setEditTx }) {
  const [search, setSearch]       = useState("");
  const [filterType, setFilterType] = useState("all"); // all | expense | income
  const [sortBy, setSortBy]       = useState("date");
  const [showFilter, setShowFilter] = useState(false);
  const [showSort, setShowSort]   = useState(false);

  const allTx = (data.transactions || [])
    .filter(t => !t.isTransfer)
    .filter(t => filterType === "all" || t.type === filterType)
    .filter(t => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (t.category || "").toLowerCase().includes(q) ||
             (t.note || "").toLowerCase().includes(q) ||
             String(t.amount).includes(q);
    })
    .slice()
    .sort((a, b) => {
      if (sortBy === "amount") return Number(b.amount) - Number(a.amount);
      return new Date(b.date) - new Date(a.date);
    });

  const grouped = groupByDate(allTx);
  const totalExpense = allTx.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
  const totalIncome  = allTx.filter(t => t.type === "income").reduce((s, t) => s + Number(t.amount), 0);

  // Light-mode color for category icon background
  function getCategoryColorLight(category, type) {
    if (type === "income") return { bg: "#e8f5ee", iconColor: "#1a6b3c" };
    const cat = (category || "").toLowerCase();
    if (cat.includes("food") || cat.includes("snack") || cat.includes("juice") || cat.includes("tea") || cat.includes("shawarma") || cat.includes("restaurant")) return { bg: "#fff3e8", iconColor: "#d4711a" };
    if (cat.includes("rent") || cat.includes("home")) return { bg: "#eeefff", iconColor: "#4444cc" };
    if (cat.includes("travel") || cat.includes("cab") || cat.includes("petrol")) return { bg: "#f3e8ff", iconColor: "#8844cc" };
    if (cat.includes("health") || cat.includes("medical")) return { bg: "#ffe8e8", iconColor: "#cc2222" };
    if (cat.includes("card") || cat.includes("emi")) return { bg: "#ffe8e8", iconColor: "#cc3333" };
    if (cat.includes("shop") || cat.includes("cloth")) return { bg: "#e8f8f8", iconColor: "#2a9090" };
    return { bg: "#f0f0f0", iconColor: "#888888" };
  }

  return (
    <div style={{ marginTop: 16 }}>
      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div style={{ background: "linear-gradient(135deg, #e8f5ee 0%, #d1ead9 100%)", borderRadius: 14, padding: "14px 18px", border: "0.5px solid #b6ddc2" }}>
          <div style={{ fontSize: 11, color: "#1a6b3c", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Total Income</div>
          <div style={{ fontWeight: 800, fontSize: 20, color: "#1a6b3c" }}>+₹{totalIncome.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div>
          <div style={{ fontSize: 11, color: "#4a9a6a", marginTop: 4 }}>{allTx.filter(t => t.type === "income").length} entries</div>
        </div>
        <div style={{ background: "linear-gradient(135deg, #fef2f2 0%, #fde8e8 100%)", borderRadius: 14, padding: "14px 18px", border: "0.5px solid #f5c0c0" }}>
          <div style={{ fontSize: 11, color: "#cc2222", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Total Expenses</div>
          <div style={{ fontWeight: 800, fontSize: 20, color: "#cc2222" }}>-₹{totalExpense.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div>
          <div style={{ fontSize: 11, color: "#e05a5a", marginTop: 4 }}>{allTx.filter(t => t.type === "expense").length} entries</div>
        </div>
      </div>

      {/* Search + Filter + Sort bar */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16 }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, background: "var(--color-background-secondary)", borderRadius: 14, padding: "10px 16px", border: "0.5px solid var(--color-border-secondary)" }}>
          <span style={{ fontSize: 15, color: "var(--color-text-secondary)" }}>🔍</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search transactions"
            style={{ flex: 1, background: "none !important", border: "none !important", outline: "none", fontSize: 14, color: "var(--color-text-primary)", padding: "0 !important", boxSizing: "border-box" }}
          />
          {search && <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "var(--color-text-secondary)", padding: 0 }}>✕</button>}
        </div>
        {/* Filter */}
        <div style={{ position: "relative" }}>
          <button onClick={() => { setShowFilter(p => !p); setShowSort(false); }} style={{
            width: 42, height: 42, borderRadius: "50%", background: filterType !== "all" ? "#1a6b3c" : "var(--color-background-secondary)",
            border: "0.5px solid var(--color-border-secondary)", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", color: filterType !== "all" ? "#fff" : "var(--color-text-secondary)"
          }}>▽</button>
          {showFilter && (
            <div style={{ position: "absolute", top: 48, right: 0, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 12, zIndex: 50, minWidth: 140, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", overflow: "hidden" }}>
              {[["all","All Transactions"], ["expense","Expenses only"], ["income","Income only"]].map(([v, l]) => (
                <button key={v} onClick={() => { setFilterType(v); setShowFilter(false); }}
                  style={{ display: "block", width: "100%", padding: "10px 16px", background: filterType === v ? "#e8f5ee" : "none", border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, color: filterType === v ? "#1a6b3c" : "var(--color-text-primary)", fontWeight: filterType === v ? 600 : 400 }}>
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Sort */}
        <div style={{ position: "relative" }}>
          <button onClick={() => { setShowSort(p => !p); setShowFilter(false); }} style={{
            width: 42, height: 42, borderRadius: "50%", background: "var(--color-background-secondary)",
            border: "0.5px solid var(--color-border-secondary)", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)"
          }}>≡</button>
          {showSort && (
            <div style={{ position: "absolute", top: 48, right: 0, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 12, zIndex: 50, minWidth: 150, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", overflow: "hidden" }}>
              {[["date","By Date"], ["amount","By Amount"]].map(([v, l]) => (
                <button key={v} onClick={() => { setSortBy(v); setShowSort(false); }}
                  style={{ display: "block", width: "100%", padding: "10px 16px", background: sortBy === v ? "#e8f5ee" : "none", border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, color: sortBy === v ? "#1a6b3c" : "var(--color-text-primary)", fontWeight: sortBy === v ? 600 : 400 }}>
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Grouped list */}
      {grouped.length === 0 ? (
        <div style={{ textAlign: "center", padding: "3rem 1rem", color: "var(--color-text-secondary)", fontSize: 14 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>💸</div>
          No transactions found
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {grouped.map(group => {
            const groupNet = group.items.reduce((s, t) => t.type === "expense" ? s - Number(t.amount) : s + Number(t.amount), 0);
            return (
              <div key={group.label} style={{ background: "var(--color-background-primary)", borderRadius: 16, overflow: "hidden", border: "0.5px solid var(--color-border-secondary)", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                {/* Group header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)" }}>
                  <span style={{ fontWeight: 700, fontSize: 15, color: "var(--color-text-primary)" }}>{group.label}</span>
                  <span style={{ fontWeight: 700, fontSize: 14, color: groupNet >= 0 ? "#1a6b3c" : "#cc2222" }}>
                    {groupNet >= 0 ? "+" : "-"}₹{Math.abs(groupNet).toLocaleString("en-IN", { maximumFractionDigits: 1 })}
                  </span>
                </div>
                {/* Transaction rows — newest first within group */}
                {group.items.slice().sort((a, b) => new Date(b.date) - new Date(a.date) || (b.id - a.id)).map((t, idx, arr) => {
                  const acct = accounts.find(b => String(b.id) === String(t.bankId));
                  const { bg, iconColor } = getCategoryColorLight(t.category || t.note, t.type);
                  const emoji = getCategoryIcon(t.category || t.note);
                  const isIncome = t.type === "income";
                  return (
                    <div key={t.id}
                      onClick={() => setEditTx && setEditTx({ ...t })}
                      style={{
                        display: "flex", alignItems: "center", gap: 12,
                        padding: "13px 16px",
                        borderBottom: idx < arr.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none",
                        cursor: "pointer", transition: "background 0.12s",
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = "var(--color-background-secondary)"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                    >
                      {/* Icon */}
                      <div style={{ width: 44, height: 44, borderRadius: 13, background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0, border: `0.5px solid ${iconColor}33` }}>
                        {emoji}
                      </div>
                      {/* Category + account */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 14, color: "var(--color-text-primary)", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {t.category || t.note || "Uncategorized"}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--color-text-secondary)" }}>
                          {acct && <><span style={{ fontSize: 11 }}>🏛</span><span>{acct.name}</span></>}
                          {t.note && t.category && <span style={{ color: "var(--color-border-primary)" }}>· {t.note}</span>}
                        </div>
                      </div>
                      {/* Right side: pill + amount stacked, then delete */}
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                        <div style={{ textAlign: "right" }}>
                          {/* Type pill */}
                          <div style={{ marginBottom: 4 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, background: isIncome ? "#e8f5ee" : "#fff0f0", color: isIncome ? "#1a6b3c" : "#cc2222", borderRadius: 5, padding: "2px 7px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                              {isIncome ? "Income" : "Expense"}
                            </span>
                          </div>
                          {/* Amount */}
                          <div style={{ fontWeight: 700, fontSize: 15, color: isIncome ? "#1a6b3c" : "var(--color-text-primary)" }}>
                            ₹{Number(t.amount).toLocaleString("en-IN", { maximumFractionDigits: 1 })}
                          </div>
                          {/* Time */}
                          {t.time && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{t.time}</div>}
                        </div>
                        {/* Delete */}
                        <button
                          onClick={e => { e.stopPropagation(); update(p => ({ transactions: p.transactions.filter(x => x.id !== t.id) })); }}
                          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, color: "var(--color-border-primary)", padding: "4px", borderRadius: 6, flexShrink: 0, opacity: 0.4 }}
                          title="Delete"
                          onMouseEnter={e => { e.currentTarget.style.color = "#cc2222"; e.currentTarget.style.opacity = "1"; }}
                          onMouseLeave={e => { e.currentTarget.style.color = "var(--color-border-primary)"; e.currentTarget.style.opacity = "0.4"; }}
                        >🗑</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Recent Transactions Tab ─────────────────────────────────────────────────
const CATEGORY_ICONS = {
  // Expense
  "Food": "🍽️", "Snacks": "🧃", "Drinks": "🥤", "Coffee": "☕", "Restaurant": "🍽️",
  "Rent": "🏠", "Home": "🏠", "Travel": "✈️", "Transport": "🚌", "Cab": "🚕", "Petrol": "⛽",
  "Shopping": "🛍️", "Clothes": "👕", "Health": "💊", "Medical": "🏥", "Gym": "💪",
  "Bills": "📋", "Electricity": "⚡", "Water": "💧", "Internet": "📶", "EMI": "💳",
  "Entertainment": "🎬", "Movies": "🎬", "Games": "🎮", "Subscriptions": "📺",
  "Education": "📚", "Salary": "💰", "Freelance": "💼", "Investment": "📈",
  "Business": "🏢", "Gift": "🎁", "Transfer": "↔️", "Other": "📌",
  "Sbi card": "💳", "Credit Card": "💳",
};

function getCategoryIcon(category) {
  if (!category) return "📌";
  for (const [key, icon] of Object.entries(CATEGORY_ICONS)) {
    if (category.toLowerCase().includes(key.toLowerCase())) return icon;
  }
  return "📌";
}

function getCategoryColor(category, type) {
  if (type === "income") return { bg: "#1a3d2b", icon: "#4cc97a" };
  const cat = (category || "").toLowerCase();
  if (cat.includes("food") || cat.includes("snack") || cat.includes("restaurant") || cat.includes("juice") || cat.includes("tea") || cat.includes("shawarma")) return { bg: "#3d2a1a", icon: "#e8945a" };
  if (cat.includes("rent") || cat.includes("home")) return { bg: "#1a1a3d", icon: "#8888ff" };
  if (cat.includes("travel") || cat.includes("cab") || cat.includes("petrol")) return { bg: "#2a1a3d", icon: "#cc88ff" };
  if (cat.includes("health") || cat.includes("medical")) return { bg: "#3d1a1a", icon: "#ff8888" };
  if (cat.includes("card") || cat.includes("emi") || cat.includes("sbi card")) return { bg: "#3d1a1a", icon: "#ff6b6b" };
  if (cat.includes("shop") || cat.includes("cloth")) return { bg: "#1a3030", icon: "#4cc9c9" };
  return { bg: "#2a2a2a", icon: "#aaaaaa" };
}

function groupByDate(transactions) {
  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const groups = {};
  transactions.forEach(t => {
    const d = new Date(t.date); d.setHours(0,0,0,0);
    let label;
    if (d.getTime() === today.getTime()) label = "Today";
    else if (d.getTime() === yesterday.getTime()) label = "Yesterday";
    else label = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
    if (!groups[label]) groups[label] = { label, date: d, items: [] };
    groups[label].items.push(t);
  });
  return Object.values(groups).sort((a, b) => b.date - a.date);
}

function RecentTransactionsTab({ data, update, accounts, setEditTx }) {
  const [search, setSearch]         = useState("");
  const [sortBy, setSortBy]         = useState("date");
  const [showFilter, setShowFilter] = useState(false);
  const [showSort, setShowSort]     = useState(false);

  // ── Filter state ─────────────────────────────────────────────────────────
  const now = new Date();
  const [filterYearMonth, setFilterYearMonth] = useState("all"); // "all" | "YYYY" | "YYYY-MM"
  const [filterDateMode, setFilterDateMode]   = useState("ym");  // "ym" | "range"
  const [filterDateFrom, setFilterDateFrom]   = useState("");
  const [filterDateTo, setFilterDateTo]       = useState("");
  const [filterCatType, setFilterCatType]     = useState("All"); // "All"|"Spending"|"Income"
  const [filterCats, setFilterCats]           = useState([]);    // [] = all
  const [filterAccounts, setFilterAccounts]   = useState([]);    // [] = all

  // Derive available year/months from transactions
  const allTransactions = data.transactions || [];
  const yearMonthOptions = React.useMemo(() => {
    const years = new Set(), months = new Set();
    allTransactions.forEach(t => {
      if (!t.date) return;
      const y = t.date.slice(0,4), ym = t.date.slice(0,7);
      years.add(y); months.add(ym);
    });
    const sortedYears = [...years].sort((a,b) => b.localeCompare(a));
    const sortedMonths = [...months].sort((a,b) => b.localeCompare(a)).slice(0,12);
    return { years: sortedYears, months: sortedMonths };
  }, [allTransactions]);

  // All categories in data
  const allCategories = React.useMemo(() => {
    const cats = new Set();
    allTransactions.forEach(t => { if (t.category) cats.add(t.category); });
    return [...cats].sort();
  }, [allTransactions]);

  // Filtered categories based on type
  const displayedCats = React.useMemo(() => {
    if (filterCatType === "Spending") return allCategories.filter(c => allTransactions.some(t => t.category === c && t.type === "expense"));
    if (filterCatType === "Income")   return allCategories.filter(c => allTransactions.some(t => t.category === c && t.type === "income"));
    return allCategories;
  }, [allCategories, filterCatType, allTransactions]);

  // Count active filters
  const activeFilterCount = [
    filterYearMonth !== "all" || (filterDateMode === "range" && (filterDateFrom || filterDateTo)),
    filterCats.length > 0,
    filterAccounts.length > 0,
    filterCatType !== "All",
  ].filter(Boolean).length;

  function resetFilters() {
    setFilterYearMonth("all"); setFilterDateMode("ym");
    setFilterDateFrom(""); setFilterDateTo("");
    setFilterCatType("All"); setFilterCats([]); setFilterAccounts([]);
  }

  function toggleCat(cat) {
    setFilterCats(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
  }
  function toggleAccount(id) {
    setFilterAccounts(prev => prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]);
  }

  const allTx = React.useMemo(() => {
    return allTransactions
      .filter(t => !t.isTransfer)
      .filter(t => {
        // Date filter
        if (filterDateMode === "range") {
          if (filterDateFrom && t.date < filterDateFrom) return false;
          if (filterDateTo   && t.date > filterDateTo)   return false;
        } else if (filterYearMonth !== "all") {
          if (!t.date?.startsWith(filterYearMonth)) return false;
        }
        // Category type filter
        if (filterCatType === "Spending" && t.type !== "expense") return false;
        if (filterCatType === "Income"   && t.type !== "income")  return false;
        // Category chips
        if (filterCats.length > 0 && !filterCats.includes(t.category)) return false;
        // Account chips
        if (filterAccounts.length > 0 && !filterAccounts.includes(String(t.bankId))) return false;
        // Search
        if (search.trim()) {
          const q = search.toLowerCase();
          return (t.category||"").toLowerCase().includes(q) ||
                 (t.note||"").toLowerCase().includes(q) ||
                 String(t.amount).includes(q);
        }
        return true;
      })
      .slice()
      .sort((a, b) => sortBy === "amount" ? Number(b.amount) - Number(a.amount) : new Date(b.date) - new Date(a.date));
  }, [allTransactions, filterDateMode, filterYearMonth, filterDateFrom, filterDateTo, filterCatType, filterCats, filterAccounts, search, sortBy]);

  const grouped      = groupByDate(allTx);
  const totalExpense = allTx.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
  const totalIncome  = allTx.filter(t => t.type === "income").reduce((s, t) => s + Number(t.amount), 0);

  // Month label helper
  function fmtYM(ym) {
    const [y, m] = ym.split("-");
    const d = new Date(+y, +m - 1, 1);
    return d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
  }

  const BG  = "var(--color-background-primary)";
  const BG2 = "var(--color-background-secondary)";
  const BORDER = "var(--color-border-tertiary)";
  const GREEN = "#1a6b3c";

  // Chip style helper
  function chip(active, extra = {}) {
    return {
      padding: "5px 14px", borderRadius: 20, fontSize: 13, cursor: "pointer", border: "none",
      fontWeight: active ? 600 : 400,
      background: active ? GREEN : BG2,
      color: active ? "#fff" : "var(--color-text-secondary)",
      ...extra,
    };
  }

  return (
    <div style={{ marginTop: 16 }}>
      {/* ── Search + Filter + Sort bar ── */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: BG2, borderRadius: 14, padding: "10px 14px", border: `0.5px solid ${BORDER}` }}>
          <span style={{ fontSize: 15, color: "var(--color-text-secondary)" }}>🔍</span>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search transactions"
            style={{ flex: 1, background: "none !important", border: "none !important", outline: "none", fontSize: 14, color: "var(--color-text-primary)", padding: "0 !important" }}
          />
          {search && <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)", padding: 0 }}>✕</button>}
        </div>
        {/* Filter icon button */}
        <button onClick={() => { setShowFilter(p => !p); setShowSort(false); }} style={{
          width: 44, height: 44, borderRadius: "50%", border: `0.5px solid ${BORDER}`,
          background: activeFilterCount > 0 ? GREEN : BG2,
          cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
          color: activeFilterCount > 0 ? "#fff" : "var(--color-text-secondary)", position: "relative", flexShrink: 0,
        }}>
          {activeFilterCount > 0 && (
            <span style={{ position: "absolute", top: -3, right: -3, background: "#ef4444", color: "#fff", borderRadius: "50%", width: 16, height: 16, fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{activeFilterCount}</span>
          )}
          ≡
        </button>
        {/* Sort icon */}
        <div style={{ position: "relative", flexShrink: 0 }}>
          <button onClick={() => { setShowSort(p => !p); setShowFilter(false); }} style={{
            width: 44, height: 44, borderRadius: "50%", background: BG2, border: `0.5px solid ${BORDER}`,
            cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)",
          }}>↕</button>
          {showSort && (
            <>
              <div onClick={() => setShowSort(false)} style={{ position: "fixed", inset: 0, zIndex: 498 }} />
              <div style={{ position: "absolute", top: 50, right: 0, background: BG, border: `0.5px solid ${BORDER}`, borderRadius: 12, zIndex: 499, minWidth: 150, boxShadow: "0 6px 24px rgba(0,0,0,0.12)", overflow: "hidden" }}>
                {[["date","By Date"], ["amount","By Amount"]].map(([v, l]) => (
                  <button key={v} onClick={() => { setSortBy(v); setShowSort(false); }}
                    style={{ display: "block", width: "100%", padding: "10px 16px", background: sortBy === v ? "#e8f5ee" : "none", border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, color: sortBy === v ? GREEN : "var(--color-text-primary)", fontWeight: sortBy === v ? 600 : 400 }}>
                    {l}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Active filter chips (quick preview) ── */}
      {activeFilterCount > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {filterYearMonth !== "all" && filterDateMode === "ym" && (
            <span style={{ ...chip(true), fontSize: 11, padding: "3px 10px", display:"flex", alignItems:"center", gap:4 }}>
              📅 {filterYearMonth.length === 4 ? filterYearMonth : fmtYM(filterYearMonth)}
              <button onClick={() => setFilterYearMonth("all")} style={{ background:"none", border:"none", cursor:"pointer", color:"#fff", fontSize:12, padding:0, lineHeight:1 }}>✕</button>
            </span>
          )}
          {filterCatType !== "All" && (
            <span style={{ ...chip(true), fontSize: 11, padding: "3px 10px", display:"flex", alignItems:"center", gap:4 }}>
              {filterCatType}
              <button onClick={() => setFilterCatType("All")} style={{ background:"none", border:"none", cursor:"pointer", color:"#fff", fontSize:12, padding:0, lineHeight:1 }}>✕</button>
            </span>
          )}
          {filterCats.map(c => (
            <span key={c} style={{ ...chip(true), fontSize: 11, padding: "3px 10px", display:"flex", alignItems:"center", gap:4 }}>
              {c}
              <button onClick={() => toggleCat(c)} style={{ background:"none", border:"none", cursor:"pointer", color:"#fff", fontSize:12, padding:0, lineHeight:1 }}>✕</button>
            </span>
          ))}
          {filterAccounts.map(id => {
            const a = accounts.find(ac => String(ac.id) === id);
            return a ? (
              <span key={id} style={{ ...chip(true), fontSize: 11, padding: "3px 10px", display:"flex", alignItems:"center", gap:4 }}>
                {a.name}
                <button onClick={() => toggleAccount(id)} style={{ background:"none", border:"none", cursor:"pointer", color:"#fff", fontSize:12, padding:0, lineHeight:1 }}>✕</button>
              </span>
            ) : null;
          })}
          <button onClick={resetFilters} style={{ padding:"3px 10px", borderRadius:20, fontSize:11, cursor:"pointer", border:`0.5px solid var(--color-border-secondary)`, background:"none", color:"var(--color-text-secondary)" }}>
            Clear all
          </button>
        </div>
      )}

      {/* ── Summary strip ── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <div style={{ flex: 1, background: "linear-gradient(135deg,#e8f5ee,#d1ead9)", borderRadius: 12, padding: "10px 14px", border: "0.5px solid #b6ddc2" }}>
          <div style={{ fontSize: 11, color: GREEN, fontWeight: 600, marginBottom: 2 }}>INCOME</div>
          <div style={{ fontWeight: 800, fontSize: 16, color: GREEN }}>+₹{totalIncome.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div>
        </div>
        <div style={{ flex: 1, background: "linear-gradient(135deg,#fef2f2,#fde8e8)", borderRadius: 12, padding: "10px 14px", border: "0.5px solid #f5c0c0" }}>
          <div style={{ fontSize: 11, color: "#cc2222", fontWeight: 600, marginBottom: 2 }}>SPENDING</div>
          <div style={{ fontWeight: 800, fontSize: 16, color: "#cc2222" }}>-₹{totalExpense.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div>
        </div>
      </div>

      {/* ── Grouped transaction list ── */}
      {grouped.length === 0 ? (
        <div style={{ textAlign: "center", padding: "3rem 1rem", color: "var(--color-text-secondary)", fontSize: 14 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
          No transactions found
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {grouped.map(group => {
            const groupTotal = group.items.reduce((s, t) => t.type === "expense" ? s - Number(t.amount) : s + Number(t.amount), 0);
            return (
              <div key={group.label} style={{ background: BG, borderRadius: 16, overflow: "hidden", border: `0.5px solid ${BORDER}`, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: `0.5px solid ${BORDER}`, background: BG2 }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{group.label}</span>
                  <span style={{ fontWeight: 700, fontSize: 14, color: groupTotal >= 0 ? GREEN : "#cc2222" }}>
                    {groupTotal >= 0 ? "+" : ""}₹{Math.abs(groupTotal).toLocaleString("en-IN", { maximumFractionDigits: 1 })}
                  </span>
                </div>
                {group.items.map((t, idx) => {
                  const acct = accounts.find(b => String(b.id) === String(t.bankId));
                  const { bg, icon: iconColor } = getCategoryColor(t.category || t.note, t.type);
                  const emoji = getCategoryIcon(t.category || t.note);
                  return (
                    <div key={t.id} onClick={() => setEditTx && setEditTx({ ...t })}
                      style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderBottom: idx < group.items.length - 1 ? `0.5px solid ${BORDER}` : "none", cursor: "pointer", transition: "background 0.15s" }}
                      onMouseEnter={e => e.currentTarget.style.background = BG2}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                    >
                      <div style={{ width: 46, height: 46, borderRadius: 14, background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0, border: `0.5px solid ${iconColor}33` }}>{emoji}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.category || t.note || "Uncategorized"}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--color-text-secondary)" }}>
                          {acct && <><span>🏛</span><span>{acct.name}</span></>}
                          {t.note && t.category && <span>· {t.note}</span>}
                        </div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 15, color: t.type === "income" ? GREEN : "var(--color-text-primary)", marginBottom: 3 }}>
                          {t.type === "income" ? "+" : ""}₹{Number(t.amount).toLocaleString("en-IN", { maximumFractionDigits: 1 })}
                        </div>
                        {t.time && <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{t.time}</div>}
                      </div>
                      <button onClick={e => { e.stopPropagation(); update(p => ({ transactions: p.transactions.filter(x => x.id !== t.id) })); }}
                        style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, color: "var(--color-border-primary)", padding: "4px", borderRadius: 6, flexShrink: 0, opacity: 0.4 }}
                        title="Delete"
                        onMouseEnter={e => { e.currentTarget.style.color = "#cc2222"; e.currentTarget.style.opacity = "1"; }}
                        onMouseLeave={e => { e.currentTarget.style.color = "var(--color-border-primary)"; e.currentTarget.style.opacity = "0.4"; }}
                      >🗑</button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          FILTER BOTTOM SHEET
      ══════════════════════════════════════════════════════════════════ */}
      {showFilter && (
        <>
          {/* Backdrop */}
          <div onClick={() => setShowFilter(false)} style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.4)", backdropFilter: "blur(2px)" }} />
          
          {/* Sheet */}
          <div style={{
            position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 501,
            background: "var(--color-background-primary)", borderRadius: "24px 24px 0 0",
            boxShadow: "0 -8px 40px rgba(0,0,0,0.18)",
            maxHeight: "88vh", overflowY: "auto",
            borderTop: "1px solid var(--color-border-tertiary)",
            WebkitOverflowScrolling: "touch",
            paddingBottom: "env(safe-area-inset-bottom)",
            display: "flex", flexDirection: "column"
          }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px 16px", position: "sticky", top: 0, background: "var(--color-background-primary)", zIndex: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 22, color: "var(--color-text-primary)" }}>Filter</span>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={resetFilters} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 24, border: "none", background: "var(--color-background-secondary)", cursor: "pointer", fontSize: 14, color: "var(--color-text-primary)", fontWeight: 600 }}>
                  ↺ Reset
                </button>
                <button onClick={() => setShowFilter(false)} style={{ width: 36, height: 36, borderRadius: "50%", border: "none", background: "var(--color-background-secondary)", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-primary)" }}>✕</button>
              </div>
            </div>

            <div style={{ padding: "8px 24px 32px", display: "flex", flexDirection: "column", gap: 32 }}>

              {/* ── Section 1: Date ── */}
              <div>
                <div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
                  <button onClick={() => setFilterDateMode("ym")} style={{ fontSize: 15, fontWeight: filterDateMode === "ym" ? 700 : 500, color: filterDateMode === "ym" ? "var(--color-text-primary)" : "var(--color-text-secondary)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                    Year/month
                  </button>
                  <button onClick={() => setFilterDateMode("range")} style={{ fontSize: 15, fontWeight: filterDateMode === "range" ? 700 : 500, color: filterDateMode === "range" ? "var(--color-text-primary)" : "var(--color-text-secondary)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                    Date range
                  </button>
                </div>

                {filterDateMode === "ym" ? (
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button onClick={() => setFilterYearMonth("all")} style={{ padding: "8px 18px", borderRadius: 24, fontSize: 14, cursor: "pointer", border: filterYearMonth === "all" ? "1px solid var(--color-text-primary)" : "1px solid var(--color-border-primary)", fontWeight: filterYearMonth === "all" ? 600 : 500, background: filterYearMonth === "all" ? "var(--color-text-primary)" : "transparent", color: filterYearMonth === "all" ? "var(--color-background-primary)" : "var(--color-text-primary)", transition: "all 0.2s" }}>All</button>
                    {yearMonthOptions.years.map(y => (
                      <button key={y} onClick={() => setFilterYearMonth(filterYearMonth === y ? "all" : y)} style={{ padding: "8px 18px", borderRadius: 24, fontSize: 14, cursor: "pointer", border: filterYearMonth === y ? "1px solid var(--color-text-primary)" : "1px solid var(--color-border-primary)", fontWeight: filterYearMonth === y ? 600 : 500, background: filterYearMonth === y ? "var(--color-text-primary)" : "transparent", color: filterYearMonth === y ? "var(--color-background-primary)" : "var(--color-text-primary)", transition: "all 0.2s" }}>{y}</button>
                    ))}
                    {yearMonthOptions.months.map(ym => (
                      <button key={ym} onClick={() => setFilterYearMonth(filterYearMonth === ym ? "all" : ym)} style={{ padding: "8px 18px", borderRadius: 24, fontSize: 14, cursor: "pointer", border: filterYearMonth === ym ? "1px solid var(--color-text-primary)" : "1px solid var(--color-border-primary)", fontWeight: filterYearMonth === ym ? 600 : 500, background: filterYearMonth === ym ? "var(--color-text-primary)" : "transparent", color: filterYearMonth === ym ? "var(--color-background-primary)" : "var(--color-text-primary)", transition: "all 0.2s" }}>{fmtYM(ym)}</button>
                    ))}
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>From</label>
                      <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} style={{ width: "100%", boxSizing: "border-box", borderRadius: 12, padding: "10px 14px", border: "1px solid var(--color-border-secondary)" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>To</label>
                      <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} style={{ width: "100%", boxSizing: "border-box", borderRadius: 12, padding: "10px 14px", border: "1px solid var(--color-border-secondary)" }} />
                    </div>
                  </div>
                )}
              </div>

              {/* ── Section 2: Category ── */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <span style={{ fontWeight: 700, fontSize: 16, color: "var(--color-text-primary)" }}>Category</span>
                  <button onClick={() => setFilterCats([])} style={{ fontSize: 14, color: "var(--color-text-primary)", background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 14, height: 14, borderRadius: "50%", border: "1.5px solid var(--color-text-secondary)", display: "inline-block" }} /> Select all
                  </button>
                </div>

                {/* All / Spending / Income toggle */}
                <div style={{ display: "flex", background: "var(--color-background-secondary)", borderRadius: 24, padding: 4, gap: 2, marginBottom: 20 }}>
                  {["All", "Spending", "Income"].map(v => (
                    <button key={v} onClick={() => { setFilterCatType(v); setFilterCats([]); }}
                      style={{ flex: 1, padding: "10px 0", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 14, fontWeight: filterCatType === v ? 600 : 500, background: filterCatType === v ? "var(--color-background-primary)" : "transparent", color: filterCatType === v ? "var(--color-text-primary)" : "var(--color-text-secondary)", boxShadow: filterCatType === v ? "0 2px 8px rgba(0,0,0,0.06)" : "none", transition: "all 0.2s ease" }}>
                      {v}
                    </button>
                  ))}
                </div>

                {/* Category chips */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {displayedCats.length === 0 ? (
                    <span style={{ fontSize: 14, color: "var(--color-text-secondary)" }}>No categories yet</span>
                  ) : displayedCats.map(cat => (
                    <button key={cat} onClick={() => toggleCat(cat)}
                      style={{ padding: "8px 18px", borderRadius: 24, fontSize: 14, cursor: "pointer", border: filterCats.includes(cat) ? "1px solid var(--color-text-primary)" : "1px solid var(--color-border-primary)", fontWeight: filterCats.includes(cat) ? 600 : 500, background: filterCats.includes(cat) ? "var(--color-text-primary)" : "transparent", color: filterCats.includes(cat) ? "var(--color-background-primary)" : "var(--color-text-primary)", transition: "all 0.2s" }}>
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Section 3: Payment Mode ── */}
              {accounts.length > 0 && (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                    <span style={{ fontWeight: 700, fontSize: 16, color: "var(--color-text-primary)" }}>Payment mode</span>
                    <button onClick={() => setFilterAccounts([])} style={{ fontSize: 14, color: "var(--color-text-primary)", background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 14, height: 14, borderRadius: "50%", border: "1.5px solid var(--color-text-secondary)", display: "inline-block" }} /> Select all
                    </button>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    {accounts.map(a => {
                      const active = filterAccounts.includes(String(a.id));
                      return (
                        <button key={a.id} onClick={() => toggleAccount(String(a.id))}
                          style={{ padding: "8px 18px", borderRadius: 24, fontSize: 14, cursor: "pointer", border: active ? "1px solid var(--color-text-primary)" : "1px solid var(--color-border-primary)", fontWeight: active ? 600 : 500, background: active ? "var(--color-text-primary)" : "transparent", color: active ? "var(--color-background-primary)" : "var(--color-text-primary)", transition: "all 0.2s" }}>
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* ── Apply button (Sticky at Bottom) ── */}
            <div style={{ position: "sticky", bottom: 0, padding: "16px 24px", background: "var(--color-background-primary)", borderTop: "1px solid var(--color-border-tertiary)" }}>
              <button onClick={() => setShowFilter(false)} style={{ width: "100%", background: "var(--color-text-primary)", color: "var(--color-background-primary)", border: "none", borderRadius: 24, padding: "16px 0", fontSize: 16, fontWeight: 700, cursor: "pointer", letterSpacing: "0.02em" }}>
                Show {allTx.length} Transaction{allTx.length !== 1 ? "s" : ""}
              </button>
            </div>

          </div>
        </>
      )}
    </div>
  );
}

// ─── F&O Page ─────────────────────────────────────────────────────────────────

const INDEX_OPTIONS_SUBS = ["Nifty 50", "Bank Nifty", "Sensex", "Others"];
const COMMODITIES_SUBS   = ["Crude Oil", "Crude Oil M", "Natural Gas", "Natural Gas M", "Gold", "Gold M", "Others"];

const DEFAULT_LOT_SIZES = {
  "Nifty 50": 65, "Bank Nifty": 30, "Sensex": 20,
  "Crude Oil": 100, "Crude Oil M": 10,
  "Natural Gas": 1250, "Natural Gas M": 250,
  "Gold": 100, "Gold M": 10,
};

function FOPage({ data, update, tab, setTab, calcCharges, foNetPnl }) {
  const lotSizes = { ...DEFAULT_LOT_SIZES, ...(data.lotSizes || {}) };
  const brokerProfiles = data.brokerProfiles || [];

  function getLotSize(instrument, subInstrument) {
    if (instrument === "Index Options" || instrument === "Commodities")
      return lotSizes[subInstrument] ?? "";
    return "";
  }

  const defaultBroker = brokerProfiles[0] || null;
  const [form, setForm] = useState({ date: today(), instrument: "Index Options", subInstrument: "Nifty 50", stockName: "", strategy: "Call", strikePrice: "", expiry: "", buyPremium: "", sellPremium: "", lots: 1, lotSize: lotSizes["Nifty 50"] || 65, notes: "", brokerId: defaultBroker?.id ?? "" });
  const [chargesForm, setChargesForm] = useState({ name: "", brokerage: 20, stt: 0.05, exchangeFee: 0.05, sebi: 0.0001, gst: 18, stampDuty: 0.003 });
  const [editingBroker, setEditingBroker] = useState(null);
  const [period, setPeriod] = useState("12M");
  const [capital, setCapital] = useState(() => data.foCapital || "");
  const [editTrade, setEditTrade] = useState(null);

  function saveEditTrade() {
    if (!editTrade) return;
    update(p => ({ foTrades: p.foTrades.map(t => t.id === editTrade.id ? { ...editTrade, lots: Number(editTrade.lots), lotSize: Number(editTrade.lotSize), buyPremium: Number(editTrade.buyPremium), sellPremium: Number(editTrade.sellPremium) } : t) }));
    setEditTrade(null);
  }

  const selectedBrokerCharges = brokerProfiles.find(b => b.id === form.brokerId)?.charges || data.foCharges;

  const filtered = data.foTrades.filter(t => filterByPeriod(t.date, period));
  const filteredPnl = filtered.reduce((s, t) => {
    const gross = (Number(t.sellPremium || 0) - Number(t.buyPremium || 0)) * Number(t.lots || 1) * Number(t.lotSize || 50);
    return s + gross - calcCharges(t, t.brokerCharges || data.foCharges);
  }, 0);
  const winners = filtered.filter(t => (Number(t.sellPremium) - Number(t.buyPremium)) > 0).length;
  const losers = filtered.length - winners;

  function handleInstrumentChange(instrument) {
    let subInstrument = "";
    let lotSize = "";
    if (instrument === "Index Options") { subInstrument = "Nifty 50"; lotSize = 75; }
    else if (instrument === "Commodities") { subInstrument = "Crude Oil"; lotSize = 100; }
    setForm(p => ({ ...p, instrument, subInstrument, stockName: "", lotSize }));
  }

  function handleSubInstrumentChange(subInstrument) {
    const lotSize = getLotSize(form.instrument, subInstrument);
    setForm(p => ({ ...p, subInstrument, lotSize: lotSize !== "" ? lotSize : p.lotSize }));
  }

  function addTrade() {
    if (!form.strikePrice || !form.buyPremium) return;
    const displayName = form.instrument === "Stock Options" ? form.stockName : form.subInstrument;
    const broker = brokerProfiles.find(b => b.id === form.brokerId);
    update(p => ({ foTrades: [...p.foTrades, { id: Date.now(), ...form, subInstrument: displayName, brokerName: broker?.name || "—", brokerCharges: broker?.charges || data.foCharges }] }));
    setForm(p => ({ ...p, date: today(), strikePrice: "", expiry: "", buyPremium: "", sellPremium: "", lots: 1, notes: "" }));
  }

  function saveBroker() {
    if (!chargesForm.name.trim()) return;
    if (editingBroker) {
      update(p => ({ brokerProfiles: p.brokerProfiles.map(b => b.id === editingBroker ? { ...b, name: chargesForm.name, charges: { brokerage: chargesForm.brokerage, stt: chargesForm.stt, exchangeFee: chargesForm.exchangeFee, sebi: chargesForm.sebi, gst: chargesForm.gst, stampDuty: chargesForm.stampDuty } } : b) }));
      setEditingBroker(null);
    } else {
      update(p => ({ brokerProfiles: [...(p.brokerProfiles || []), { id: Date.now(), name: chargesForm.name, charges: { brokerage: chargesForm.brokerage, stt: chargesForm.stt, exchangeFee: chargesForm.exchangeFee, sebi: chargesForm.sebi, gst: chargesForm.gst, stampDuty: chargesForm.stampDuty } }] }));
    }
    setChargesForm({ name: "", brokerage: 20, stt: 0.05, exchangeFee: 0.05, sebi: 0.0001, gst: 18, stampDuty: 0.003 });
  }

  function editBroker(broker) {
    setEditingBroker(broker.id);
    setChargesForm({ name: broker.name, ...broker.charges });
  }

  function deleteBroker(id) {
    update(p => ({ brokerProfiles: p.brokerProfiles.filter(b => b.id !== id) }));
    if (editingBroker === id) { setEditingBroker(null); setChargesForm({ name: "", brokerage: 20, stt: 0.05, exchangeFee: 0.05, sebi: 0.0001, gst: 18, stampDuty: 0.003 }); }
  }

  const custom = data.customInstruments || { "Index Options": [], "Stock Options": [], "Commodities": [] };
  const indexSubs = [...["Nifty 50", "Bank Nifty", "Sensex"], ...(custom["Index Options"] || []), "Others"];
  const commoditySubs = [...["Crude Oil", "Crude Oil M", "Natural Gas", "Natural Gas M", "Gold", "Gold M"], ...(custom["Commodities"] || []), "Others"];

  const subOptions = form.instrument === "Index Options" ? indexSubs
    : form.instrument === "Commodities" ? commoditySubs : [];

  const lotSizeIsAuto = form.instrument !== "Stock Options" && form.subInstrument !== "Others" && getLotSize(form.instrument, form.subInstrument) !== "";

  return (
    <div>
      {/* Edit Trade Modal */}
      {editTrade && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 16, padding: "1.5rem", width: "min(480px, 90vw)", border: "0.5px solid var(--color-border-tertiary)", maxHeight: "90vh", overflowY: "auto" }}>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 16 }}>✏️ Edit Trade</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Date</label>
                <input type="date" value={editTrade.date} onChange={e => setEditTrade(p => ({ ...p, date: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Strategy</label>
                <select value={editTrade.strategy} onChange={e => setEditTrade(p => ({ ...p, strategy: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
                  <option>Call</option><option>Put</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Strike Price</label>
                <input type="number" value={editTrade.strikePrice} onChange={e => setEditTrade(p => ({ ...p, strikePrice: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Expiry</label>
                <input type="date" value={editTrade.expiry || ""} onChange={e => setEditTrade(p => ({ ...p, expiry: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Buy Premium (₹)</label>
                <input type="number" value={editTrade.buyPremium} onChange={e => setEditTrade(p => ({ ...p, buyPremium: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Sell Premium (₹)</label>
                <input type="number" value={editTrade.sellPremium || ""} onChange={e => setEditTrade(p => ({ ...p, sellPremium: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Lots</label>
                <input type="number" value={editTrade.lots} onChange={e => setEditTrade(p => ({ ...p, lots: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Lot Size</label>
                <input type="number" value={editTrade.lotSize} onChange={e => setEditTrade(p => ({ ...p, lotSize: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Notes</label>
                <input value={editTrade.notes || ""} onChange={e => setEditTrade(p => ({ ...p, notes: e.target.value }))} placeholder="Optional notes" style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setEditTrade(null)} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "8px 16px", cursor: "pointer", color: "var(--color-text-secondary)" }}>Cancel</button>
              <button onClick={saveEditTrade} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontWeight: 600 }}>Save Changes</button>
            </div>
          </div>
        </div>
      )}
      <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26, marginBottom: 8 }}>F&O Tracker</h1>
      <TabBar tabs={["trades", "pnl", "charges"]} active={tab} setActive={setTab} labels={["Trades", "P&L Report", "Charges"]} />

      {tab === "trades" && (
        <>
          <PeriodBar periods={["This Week", "This Month", "Last Month", "6M", "12M"]} active={period} setActive={setPeriod} />

          {/* Capital block */}
          {(() => {
            const cap = parseFloat(capital) || 0;
            const effective = cap + filteredPnl;
            const roi = cap > 0 ? ((filteredPnl / cap) * 100) : 0;
            return (
              <div style={{ margin: "12px 0 0", background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "12px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: cap > 0 ? 12 : 0 }}>
                  <span style={{ fontSize: 13, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>💰 Trading Capital (₹)</span>
                  <input
                    type="number"
                    placeholder="e.g. 2,00,000"
                    value={capital}
                    onChange={e => { setCapital(e.target.value); update(() => ({ foCapital: parseFloat(e.target.value) || 0 })); }}
                    style={{ flex: 1, border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: "5px 10px", fontSize: 14, fontWeight: 500, background: "var(--color-background-secondary)" }}
                  />
                </div>
                {cap > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <div style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "7px 14px", fontSize: 13 }}>
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 2 }}>Capital</div>
                      <div style={{ fontWeight: 600 }}>{fmtCur(cap)}</div>
                    </div>
                    <span style={{ fontSize: 18, color: "var(--color-text-secondary)" }}>{filteredPnl >= 0 ? "+" : "−"}</span>
                    <div style={{ background: filteredPnl >= 0 ? "#f0fdf4" : "#fff0f0", borderRadius: 8, padding: "7px 14px", fontSize: 13, border: `0.5px solid ${filteredPnl >= 0 ? "#bbf7d0" : "#fecaca"}` }}>
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 2 }}>{filteredPnl >= 0 ? "Profit" : "Loss"}</div>
                      <div style={{ fontWeight: 600, color: filteredPnl >= 0 ? "#1a6b3c" : "#d44" }}>{fmtCur(Math.abs(filteredPnl))}</div>
                    </div>
                    <span style={{ fontSize: 18, color: "var(--color-text-secondary)" }}>=</span>
                    <div style={{ background: effective >= cap ? "#f0fdf4" : "#fff0f0", borderRadius: 8, padding: "7px 14px", fontSize: 13, border: `0.5px solid ${effective >= cap ? "#1a6b3c" : "#d44"}` }}>
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 2 }}>Effective Capital</div>
                      <div style={{ fontWeight: 700, fontSize: 15, color: effective >= cap ? "#1a6b3c" : "#d44" }}>{fmtCur(effective)}</div>
                    </div>
                    {cap > 0 && (
                      <div style={{ marginLeft: "auto", textAlign: "right" }}>
                        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 2 }}>ROI</div>
                        <div style={{ fontWeight: 700, fontSize: 15, color: roi >= 0 ? "#1a6b3c" : "#d44" }}>{roi >= 0 ? "+" : ""}{roi.toFixed(2)}%</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(140px, 100%), 1fr))", gap: 10, margin: "10px 0" }}>
            <StatCard label="Total Trades" value={filtered.length} />
            <StatCard label="Winners" value={winners} />
            <StatCard label="Losers" value={losers} />
            <StatCard label="Win Rate" value={filtered.length > 0 ? ((winners / filtered.length) * 100).toFixed(1) + "%" : "—"} />
            <StatCard label="Net P&L (after charges)" value={fmtCur(filteredPnl)} pnl={filteredPnl} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))", gap: 16 }}>
            <Card title="Log New Trade">
              {/* Row 1: Date */}
              <div style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Date</label>
                <input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>

              {/* Instrument — Dropdown */}
              <div style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Instrument</label>
                <select 
                  value={form.instrument} 
                  onChange={e => handleInstrumentChange(e.target.value)}
                  style={{ width: "100%", boxSizing: "border-box" }}
                >
                  {INSTRUMENTS.map(i => (
                    <option key={i} value={i}>{i}</option>
                  ))}
                </select>
              </div>

              {/* Row 2: Sub-instrument (conditional) */}
              {form.instrument === "Index Options" && (
                <div style={{ marginTop: 8 }}>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Index</label>
                  <select 
                    value={form.subInstrument} 
                    onChange={e => handleSubInstrumentChange(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  >
                    {indexSubs.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              )}

              {form.instrument === "Stock Options" && (
                <div style={{ marginTop: 8 }}>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Stock Name</label>
                  <input placeholder="e.g. RELIANCE, TCS" value={form.stockName} onChange={e => setForm(p => ({ ...p, stockName: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
                </div>
              )}

              {form.instrument === "Commodities" && (
                <div style={{ marginTop: 8 }}>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Commodity</label>
                  <select 
                    value={form.subInstrument} 
                    onChange={e => handleSubInstrumentChange(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  >
                    {commoditySubs.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Strategy */}
              <div style={{ marginTop: 8 }}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Strategy</label>
                <div style={{ display: "flex", gap: 8 }}>
                  {STRATEGIES.map(s => (
                    <button key={s} onClick={() => setForm(p => ({ ...p, strategy: s }))} style={{ flex: 1, padding: "6px", borderRadius: 6, border: "0.5px solid", borderColor: form.strategy === s ? "#1a6b3c" : "var(--color-border-secondary)", background: form.strategy === s ? "#e8f5ee" : "transparent", fontSize: 13, cursor: "pointer", color: form.strategy === s ? "#1a6b3c" : "var(--color-text-secondary)", fontWeight: form.strategy === s ? 600 : 400 }}>{s}</button>
                  ))}
                </div>
              </div>

              {/* Broker selector */}
              {brokerProfiles.length > 0 ? (
                <div style={{ marginTop: 8 }}>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Broker / Charges Template</label>
                  <select 
                    value={form.brokerId} 
                    onChange={e => setForm(p => ({ ...p, brokerId: e.target.value }))}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  >
                    <option value="">Default</option>
                    {brokerProfiles.map(b => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-secondary)" }}>
                  <button onClick={() => setTab("charges")} style={{ background: "none", border: "none", color: "#1a6b3c", cursor: "pointer", fontSize: 11, padding: 0 }}>+ Add broker template</button> in Charges tab
                </div>
              )}

              {/* Strike, Expiry, Premiums, Lots, Lot Size */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>

              {/* Strike, Expiry, Premiums, Lots, Lot Size */}
                <LabelInput label="Strike Price" placeholder="e.g. 22500" value={form.strikePrice} onChange={v => setForm(p => ({ ...p, strikePrice: v }))} />
                <LabelInput label="Expiry Date" type="date" value={form.expiry} onChange={v => setForm(p => ({ ...p, expiry: v }))} />
                <LabelInput label="Buy Premium (₹)" placeholder="e.g. 120" value={form.buyPremium} onChange={v => setForm(p => ({ ...p, buyPremium: v }))} />
                <LabelInput label="Sell Premium (₹)" placeholder="e.g. 150" value={form.sellPremium} onChange={v => setForm(p => ({ ...p, sellPremium: v }))} />
                <LabelInput label="Lots" placeholder="1" value={form.lots} onChange={v => setForm(p => ({ ...p, lots: v }))} />
                <div>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>
                    Lot Size {lotSizeIsAuto && <span style={{ color: "#1a6b3c", fontSize: 10 }}>● auto</span>}
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 75"
                    value={form.lotSize}
                    readOnly={lotSizeIsAuto}
                    onChange={e => !lotSizeIsAuto && setForm(p => ({ ...p, lotSize: e.target.value }))}
                    style={{ width: "100%", boxSizing: "border-box", background: lotSizeIsAuto ? "var(--color-background-secondary)" : undefined, color: lotSizeIsAuto ? "#1a6b3c" : undefined, fontWeight: lotSizeIsAuto ? 600 : 400 }}
                  />
                </div>
              </div>
              <LabelInput label="Notes" placeholder="optional" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} />
              {form.buyPremium && form.sellPremium && (
                <div style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "8px 12px", marginTop: 8, fontSize: 12 }}>
                  {form.brokerId && brokerProfiles.find(b => b.id === form.brokerId) && (
                    <div style={{ fontSize: 11, color: "#1a6b3c", marginBottom: 6, fontWeight: 500 }}>
                      Using: {brokerProfiles.find(b => b.id === form.brokerId).name} charges
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ color: "var(--color-text-secondary)" }}>Gross P&L</span>
                    <span style={{ fontWeight: 500, color: (Number(form.sellPremium) - Number(form.buyPremium)) >= 0 ? "#1a6b3c" : "#d44" }}>
                      {fmtCur((Number(form.sellPremium) - Number(form.buyPremium)) * Number(form.lots) * Number(form.lotSize))}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ color: "var(--color-text-secondary)" }}>Est. Charges</span>
                    <span>- {fmtCur(calcCharges(form, selectedBrokerCharges))}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 4 }}>
                    <span style={{ fontWeight: 500 }}>Net P&L</span>
                    <span style={{ fontWeight: 500, color: ((Number(form.sellPremium) - Number(form.buyPremium)) * Number(form.lots) * Number(form.lotSize) - calcCharges(form, selectedBrokerCharges)) >= 0 ? "#1a6b3c" : "#d44" }}>
                      {fmtCur((Number(form.sellPremium) - Number(form.buyPremium)) * Number(form.lots) * Number(form.lotSize) - calcCharges(form, selectedBrokerCharges))}
                    </span>
                  </div>
                </div>
              )}
              <GreenBtn onClick={addTrade} label="+ Log Trade" />
            </Card>

            <Card title={`Trade Log (${filtered.length})`}>
              {filtered.length === 0 ? <EmptyState msg="No trades logged yet. Add your first trade." /> : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", minWidth: 500 }}>
                    <thead><tr>{["Date", "Instrument", "Type", "Strategy", "Strike", "Buy", "Sell", "Lots", "Broker", "Net P&L", ""].map(h => <th key={h} style={{ textAlign: "left", padding: "4px 6px", color: "var(--color-text-secondary)", fontWeight: 500, borderBottom: "0.5px solid var(--color-border-tertiary)", whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
                    <tbody>{filtered.slice().reverse().map(t => {
                      const gross = (Number(t.sellPremium) - Number(t.buyPremium)) * Number(t.lots) * Number(t.lotSize);
                      const charges = calcCharges(t, t.brokerCharges || data.foCharges);
                      const net = gross - charges;
                      return (
                        <tr key={t.id} style={{ borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                          <td style={{ padding: "5px 6px", color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>{t.date}</td>
                          <td style={{ padding: "5px 6px", fontWeight: 500 }}>{t.instrument}</td>
                          <td style={{ padding: "5px 6px", color: "var(--color-text-secondary)" }}>{t.subInstrument || "—"}</td>
                          <td style={{ padding: "5px 6px" }}>{t.strategy}</td>
                          <td style={{ padding: "5px 6px" }}>{t.strikePrice}</td>
                          <td style={{ padding: "5px 6px" }}>₹{t.buyPremium}</td>
                          <td style={{ padding: "5px 6px" }}>₹{t.sellPremium || "—"}</td>
                          <td style={{ padding: "5px 6px" }}>{t.lots}×{t.lotSize}</td>
                          <td style={{ padding: "5px 6px" }}>
                            {t.brokerName ? <span style={{ background: "#e8f5ee", color: "#1a6b3c", borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 500 }}>{t.brokerName}</span> : <span style={{ color: "var(--color-text-secondary)" }}>—</span>}
                          </td>
                          <td style={{ padding: "5px 6px", fontWeight: 500, color: net >= 0 ? "#1a6b3c" : "#d44" }}>{fmtCur(net)}</td>
                          <td style={{ padding: "2px 4px" }}>
                            <ThreeDotMenu
                              onEdit={() => setEditTrade({ ...t })}
                              onDelete={() => update(p => ({ foTrades: p.foTrades.filter(x => x.id !== t.id) }))}
                            />
                          </td>
                        </tr>
                      );
                    })}</tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </>
      )}

      {tab === "pnl" && (
        <FOCalendarPnl trades={data.foTrades} calcCharges={calcCharges} foCharges={data.foCharges} />
      )}

      {tab === "charges" && (
        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16 }}>

          {/* Left: Add / Edit broker form */}
          <Card title={editingBroker ? "Edit Broker Template" : "Add Broker Template"}>
            <LabelInput label="Broker Name *" placeholder="e.g. Zerodha, Groww, Angel One" value={chargesForm.name} onChange={v => setChargesForm(p => ({ ...p, name: v }))} />
            {[
              ["brokerage", "Brokerage (₹ per order)", "Flat fee per order"],
              ["stt", "STT (%)", "Securities Transaction Tax"],
              ["exchangeFee", "Exchange Fee (%)", "NSE/BSE transaction fee"],
              ["sebi", "SEBI Charges (%)", "SEBI turnover fee"],
              ["gst", "GST (%)", "On brokerage + exchange fee"],
              ["stampDuty", "Stamp Duty (%)", "On buy side only"],
            ].map(([key, label, hint]) => (
              <div key={key} style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 2 }}>{label}</label>
                <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginBottom: 3 }}>{hint}</div>
                <input type="number" step="any" value={chargesForm[key] ?? ""} onChange={e => setChargesForm(p => ({ ...p, [key]: parseFloat(e.target.value) }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <GreenBtn onClick={saveBroker} label={editingBroker ? "Update Template" : "+ Save Template"} />
              {editingBroker && (
                <button onClick={() => { setEditingBroker(null); setChargesForm({ name: "", brokerage: 20, stt: 0.05, exchangeFee: 0.05, sebi: 0.0001, gst: 18, stampDuty: 0.003 }); }}
                  style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)" }}>
                  Cancel
                </button>
              )}
            </div>
          </Card>

          {/* Right: Saved broker templates */}
          <Card title={`Broker Templates (${(data.brokerProfiles || []).length})`}>
            {(data.brokerProfiles || []).length === 0 ? (
              <EmptyState msg="No broker templates saved yet. Add one on the left." />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {(data.brokerProfiles || []).map(b => (
                  <div key={b.id} style={{ background: "var(--color-background-secondary)", borderRadius: 10, padding: "10px 12px", border: editingBroker === b.id ? "1px solid #1a6b3c" : "0.5px solid var(--color-border-tertiary)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{b.name}</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => editBroker(b)} style={{ background: "#e8f5ee", border: "none", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12, color: "#1a6b3c", fontWeight: 500 }}>Edit</button>
                        <button onClick={() => deleteBroker(b.id)} style={{ background: "none", border: "none", color: "#d44", cursor: "pointer", fontSize: 14 }}>✕</button>
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, fontSize: 11, color: "var(--color-text-secondary)" }}>
                      <span>Brokerage: ₹{b.charges.brokerage}</span>
                      <span>STT: {b.charges.stt}%</span>
                      <span>Exch: {b.charges.exchangeFee}%</span>
                      <span>SEBI: {b.charges.sebi}%</span>
                      <span>GST: {b.charges.gst}%</span>
                      <span>Stamp: {b.charges.stampDuty}%</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

// ─── F&O Calendar P&L ────────────────────────────────────────────────────────
function FOCalendarPnl({ trades, calcCharges, foCharges }) {
  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth()); // 0-indexed
  const [selectedDay, setSelectedDay] = useState(null);

  // Build a map of date -> { net, gross, charges, trades[] }
  const dayMap = {};
  trades.forEach(t => {
    if (!t.date) return;
    const gross = (Number(t.sellPremium || 0) - Number(t.buyPremium || 0)) * Number(t.lots || 1) * Number(t.lotSize || 50);
    const ch = calcCharges(t, t.brokerCharges || foCharges);
    const net = gross - ch;
    if (!dayMap[t.date]) dayMap[t.date] = { net: 0, gross: 0, charges: 0, trades: [] };
    dayMap[t.date].net += net;
    dayMap[t.date].gross += gross;
    dayMap[t.date].charges += ch;
    dayMap[t.date].trades.push(t);
  });

  const monthName = new Date(calYear, calMonth, 1).toLocaleString("en-IN", { month: "long", year: "numeric" });
  const firstDay = new Date(calYear, calMonth, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  // Month-level stats
  const monthTrades = trades.filter(t => {
    if (!t.date) return false;
    const d = new Date(t.date);
    return d.getMonth() === calMonth && d.getFullYear() === calYear;
  });
  const monthNet = monthTrades.reduce((s, t) => {
    const gross = (Number(t.sellPremium || 0) - Number(t.buyPremium || 0)) * Number(t.lots || 1) * Number(t.lotSize || 50);
    return s + gross - calcCharges(t, t.brokerCharges || foCharges);
  }, 0);
  const monthGross = monthTrades.reduce((s, t) =>
    s + (Number(t.sellPremium || 0) - Number(t.buyPremium || 0)) * Number(t.lots || 1) * Number(t.lotSize || 50), 0);
  const monthCharges = monthTrades.reduce((s, t) => s + calcCharges(t, t.brokerCharges || foCharges), 0);

  function prevMonth() {
    if (calMonth === 0) { setCalYear(y => y - 1); setCalMonth(11); }
    else setCalMonth(m => m - 1);
    setSelectedDay(null);
  }
  function nextMonth() {
    if (calMonth === 11) { setCalYear(y => y + 1); setCalMonth(0); }
    else setCalMonth(m => m + 1);
    setSelectedDay(null);
  }

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const pad = n => String(n).padStart(2, "0");
  const selectedKey = selectedDay ? `${calYear}-${pad(calMonth + 1)}-${pad(selectedDay)}` : null;
  const selectedData = selectedKey ? dayMap[selectedKey] : null;

  return (
    <div style={{ marginTop: 16 }}>
      {/* Month summary stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(130px, 100%), 1fr))", gap: 10, marginBottom: 16 }}>
        <StatCard label="Trades This Month" value={monthTrades.length} />
        <StatCard label="Gross P&L" value={fmtCur(monthGross)} pnl={monthGross} />
        <StatCard label="Total Charges" value={"- " + fmtCur(monthCharges)} />
        <StatCard label="Net P&L" value={fmtCur(monthNet)} pnl={monthNet} big />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: selectedDay ? "1fr min(320px,100%)" : "1fr", gap: 16 }}>
        {/* Calendar */}
        <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", overflow: "hidden" }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "1rem 1.2rem", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
            <button onClick={prevMonth} style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 16, color: "var(--color-text-primary)", display: "flex", alignItems: "center", justifyContent: "center" }}>‹</button>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 20, fontWeight: 400 }}>{monthName}</div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{monthTrades.length} TRADE{monthTrades.length !== 1 ? "S" : ""}</div>
            </div>
            <button onClick={nextMonth} style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 16, color: "var(--color-text-primary)", display: "flex", alignItems: "center", justifyContent: "center" }}>›</button>
          </div>

          {/* Day labels */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
              <div key={i} style={{ textAlign: "center", padding: "8px 0", fontSize: 12, color: "var(--color-text-secondary)", fontWeight: 500 }}>{d}</div>
            ))}
          </div>

          {/* Calendar grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
            {cells.map((day, idx) => {
              if (!day) return <div key={"e" + idx} style={{ minHeight: 80, borderRight: "0.5px solid var(--color-border-tertiary)", borderBottom: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-tertiary)", opacity: 0.4 }} />;
              const key = `${calYear}-${pad(calMonth + 1)}-${pad(day)}`;
              const info = dayMap[key];
              const isSelected = selectedDay === day;
              const isToday = day === now.getDate() && calMonth === now.getMonth() && calYear === now.getFullYear();
              return (
                <div key={day} onClick={() => setSelectedDay(isSelected ? null : day)} style={{
                  minHeight: 80, borderRight: "0.5px solid var(--color-border-tertiary)",
                  borderBottom: "0.5px solid var(--color-border-tertiary)",
                  padding: "6px 8px",
                  background: isSelected ? "var(--color-background-secondary)" : "var(--color-background-primary)",
                  cursor: info ? "pointer" : "default",
                  position: "relative"
                }}>
                  <div style={{
                    fontWeight: isToday ? 600 : 400,
                    fontSize: 14,
                    color: isToday ? "#1a6b3c" : "var(--color-text-primary)",
                    width: isToday ? 24 : "auto",
                    height: isToday ? 24 : "auto",
                    background: isToday ? "#e8f5ee" : "transparent",
                    borderRadius: isToday ? "50%" : 0,
                    display: "flex", alignItems: "center", justifyContent: isToday ? "center" : "flex-start",
                    marginBottom: 4
                  }}>{day}</div>
                  {info && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      {info.trades.length > 0 && (
                        <div style={{
                          fontSize: 10, fontWeight: 500, color: "#888",
                          background: "var(--color-background-secondary)",
                          borderRadius: 4, padding: "1px 5px", display: "inline-block"
                        }}>₹{fmt(Math.abs(info.gross))}</div>
                      )}
                      <div style={{
                        fontSize: 11, fontWeight: 600,
                        color: "#fff",
                        background: info.net >= 0 ? "#1a6b3c" : "#c0392b",
                        borderRadius: 5, padding: "2px 6px",
                        display: "inline-block",
                        boxShadow: info.net >= 0 ? "0 1px 4px #1a6b3c44" : "0 1px 4px #c0392b44"
                      }}>₹{fmt(info.net)}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Day detail panel */}
        {selectedDay && (
          <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1.2rem", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 18 }}>
                  {new Date(calYear, calMonth, selectedDay).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}
                </div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{selectedData ? selectedData.trades.length + " trade(s)" : "No trades"}</div>
              </div>
              <button onClick={() => setSelectedDay(null)} style={{ background: "none", border: "none", color: "var(--color-text-secondary)", cursor: "pointer", fontSize: 18 }}>✕</button>
            </div>

            {!selectedData ? (
              <EmptyState msg="No trades on this day." />
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>Gross P&L</div>
                    <div style={{ fontWeight: 600, fontSize: 15, color: selectedData.gross >= 0 ? "#1a6b3c" : "#c0392b" }}>{fmtCur(selectedData.gross)}</div>
                  </div>
                  <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>Charges</div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>- {fmtCur(selectedData.charges)}</div>
                  </div>
                </div>
                <div style={{ background: selectedData.net >= 0 ? "#e8f5ee" : "#fdf0f0", borderRadius: 10, padding: "12px 14px", border: `0.5px solid ${selectedData.net >= 0 ? "#1a6b3c44" : "#c0392b44"}` }}>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>Net P&L</div>
                  <div style={{ fontWeight: 700, fontSize: 22, color: selectedData.net >= 0 ? "#1a6b3c" : "#c0392b" }}>{fmtCur(selectedData.net)}</div>
                </div>
                <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 10 }}>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8, fontWeight: 500 }}>Trades</div>
                  {selectedData.trades.map((t, i) => {
                    const g = (Number(t.sellPremium || 0) - Number(t.buyPremium || 0)) * Number(t.lots || 1) * Number(t.lotSize || 50);
                    const ch = calcCharges(t, t.brokerCharges || foCharges);
                    const n = g - ch;
                    return (
                      <div key={t.id} style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "8px 10px", marginBottom: 6, fontSize: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                          <span style={{ fontWeight: 500 }}>{t.instrument} {t.strikePrice}</span>
                          <span style={{ fontWeight: 600, color: n >= 0 ? "#1a6b3c" : "#c0392b" }}>{fmtCur(n)}</span>
                        </div>
                        <div style={{ color: "var(--color-text-secondary)" }}>{t.strategy} · {t.lots}×{t.lotSize} · Buy ₹{t.buyPremium} → Sell ₹{t.sellPremium || "—"}</div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Essentials ───────────────────────────────────────────────────────────────
function EssentialsPage({ data, update, tab, setTab }) {
  const [profileForm, setProfileForm] = useState({ ...data.profile });
  const [goalForm, setGoalForm] = useState({ name: "", target: "", currency: "INR", targetDate: "", trackBy: "Net Worth (all assets)" });

  const savingsRate = data.profile.income ? ((Number(data.profile.savings) / Number(data.profile.income)) * 100).toFixed(1) : null;
  const expenseRatio = data.profile.income ? ((Number(data.profile.expense) / Number(data.profile.income)) * 100).toFixed(1) : null;

  function addGoal() {
    if (!goalForm.name || !goalForm.target) return;
    update(p => ({ goals: [...p.goals, { id: Date.now(), ...goalForm, created: today() }] }));
    setGoalForm({ name: "", target: "", currency: "INR", targetDate: "", trackBy: "Net Worth (all assets)" });
  }

  const netWorth = data.assets.reduce((s, a) => s + Number(a.value), 0) - data.liabilities.reduce((s, l) => s + Number(l.value), 0);

  return (
    <div>
      <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26, marginBottom: 8 }}>Essentials</h1>
      <p style={{ color: "var(--color-text-secondary)", fontSize: 14, marginBottom: 12 }}>Financial health check</p>
      <TabBar tabs={["essentials", "goals"]} active={tab} setActive={setTab} labels={["Essentials", "Goals"]} />

      {tab === "essentials" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
          <Card title="Financial Profile">
            <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>Used for health scores and personalised guidance. All fields are optional.</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <LabelInput label="Age" placeholder="Your age" value={profileForm.age} onChange={v => setProfileForm(p => ({ ...p, age: v }))} />
              <LabelInput label="Monthly Income" placeholder="Monthly income" value={profileForm.income} onChange={v => setProfileForm(p => ({ ...p, income: v }))} />
              <LabelInput label="Monthly Expense" placeholder="Monthly expense" value={profileForm.expense} onChange={v => setProfileForm(p => ({ ...p, expense: v }))} />
              <LabelInput label="Monthly Savings" placeholder="Monthly savings" value={profileForm.savings} onChange={v => setProfileForm(p => ({ ...p, savings: v }))} />
            </div>
            <GreenBtn onClick={() => update(() => ({ profile: profileForm }))} label="Save" />
          </Card>
          <Card title="Health Scores">
            {!data.profile.income ? (
              <div style={{ background: "#fef9e7", border: "0.5px solid #f0c040", borderRadius: 8, padding: "1rem", textAlign: "center" }}>
                <div style={{ fontSize: 20, marginBottom: 6 }}>⚠</div>
                <div style={{ fontWeight: 500, marginBottom: 4, fontSize: 14 }}>Monthly Expense Data Required</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Fill in your financial profile to see health scores.</div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <HealthBar label="Savings Rate" value={parseFloat(savingsRate)} target={30} unit="%" hint="Target: >30%" />
                <HealthBar label="Expense Ratio" value={parseFloat(expenseRatio)} target={50} invert unit="%" hint="Target: <50%" />
                <HealthBar label="Emergency Fund" value={Math.min((netWorth / (Number(data.profile.expense) * 6)) * 100, 100)} target={100} unit="%" hint="Target: 6 months expenses" />
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "goals" && (
        <div style={{ marginTop: 16 }}>
          {data.goals.length === 0 && (
            <div style={{ textAlign: "center", padding: "2rem", color: "var(--color-text-secondary)", marginBottom: 20 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>◎</div>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>No goals yet</div>
              <div style={{ fontSize: 13 }}>Set financial goals to track your progress toward milestones like retirement, home purchase, or emergency funds.</div>
            </div>
          )}
          {data.goals.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, marginBottom: 20 }}>
              {data.goals.map(g => {
                const progress = Math.min((netWorth / Number(g.target)) * 100, 100);
                return (
                  <Card key={g.id} title={g.name}>
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6 }}>Target: {fmtCur(g.target)}</div>
                    <div style={{ background: "var(--color-background-secondary)", borderRadius: 4, height: 6, marginBottom: 6, overflow: "hidden" }}>
                      <div style={{ width: progress + "%", height: "100%", background: "#1a6b3c", borderRadius: 4 }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--color-text-secondary)" }}>
                      <span>{progress.toFixed(1)}% achieved</span>
                      {g.targetDate && <span>By {g.targetDate}</span>}
                    </div>
                    <button onClick={() => update(p => ({ goals: p.goals.filter(x => x.id !== g.id) }))} style={{ marginTop: 8, background: "none", border: "none", color: "#d44", cursor: "pointer", fontSize: 12 }}>Remove</button>
                  </Card>
                );
              })}
            </div>
          )}
          <Card title="Create New Goal">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <LabelInput label="Goal Name *" placeholder="Goal name" value={goalForm.name} onChange={v => setGoalForm(p => ({ ...p, name: v }))} />
              <LabelInput label="Target Amount *" placeholder="Target amount" value={goalForm.target} onChange={v => setGoalForm(p => ({ ...p, target: v }))} />
              <LabelInput label="Target Date *" type="date" value={goalForm.targetDate} onChange={v => setGoalForm(p => ({ ...p, targetDate: v }))} />
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Track Progress By</label>
                <select value={goalForm.trackBy} onChange={e => setGoalForm(p => ({ ...p, trackBy: e.target.value }))} style={{ width: "100%" }}>
                  <option>Net Worth (all assets)</option>
                  <option>Specific assets</option>
                  <option>Savings only</option>
                </select>
              </div>
            </div>
            <GreenBtn onClick={addGoal} label="Create Goal" />
          </Card>
        </div>
      )}
    </div>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function SettingsPage({ data, update, tab, setTab, navItems, navEditMode, setNavEditMode, onNavDragStart, onNavDragOver, onNavDrop, navDragOver, navDragIdx, setNavDragOver }) {
  const foOn = (data.featureToggles || { fo: true }).fo !== false;
  const cardStyle = { background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "1.2rem 1.4rem", marginBottom: 16 };
  const sectionTitle = (icon, label, sub) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{label}</span>
      </div>
      {sub && <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginLeft: 24 }}>{sub}</p>}
    </div>
  );

  // If current tab is "trading" but FO is off, redirect to accounts
  const effectiveTab = (!foOn && tab === "trading") ? "profile" : tab;

  const settingsTabs = foOn
    ? ["profile", "trading", "accounts", "categories", "projects", "documents", "features"]
    : ["profile", "accounts", "categories", "projects", "documents", "features"];
  const settingsLabels = foOn
    ? ["Profile", "Trading Settings", "Account Settings", "Categories", "Projects", "Documents", "Features"]
    :  ["Profile", "Account Settings", "Categories", "Projects", "Documents", "Features"];

  return (
    <div>
      <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26, marginBottom: 4 }}>Settings</h1>
      <p style={{ color: "var(--color-text-secondary)", fontSize: 14, marginBottom: 16 }}>Manage your app preferences, accounts and categories.</p>
      <TabBar
        tabs={settingsTabs}
        active={effectiveTab}
        setActive={setTab}
        labels={settingsLabels}
      />

      {/* ── Profile Settings ── */}
      {effectiveTab === "profile" && <ProfilePage data={data} update={update} />}

      {/* ── Trading Settings — only shown when F&O is on ── */}
      {foOn && effectiveTab === "trading" && <TradingSettings data={data} update={update} cardStyle={cardStyle} sectionTitle={sectionTitle} />}

      {/* ── Account Settings ── */}
      {effectiveTab === "accounts" && <AccountSettings data={data} update={update} cardStyle={cardStyle} sectionTitle={sectionTitle} />}

      {/* ── Categories ── */}
      {effectiveTab === "categories" && <CategoriesSettings data={data} update={update} cardStyle={cardStyle} sectionTitle={sectionTitle} navItems={navItems} navEditMode={navEditMode} setNavEditMode={setNavEditMode} onNavDragStart={onNavDragStart} onNavDragOver={onNavDragOver} onNavDrop={onNavDrop} navDragOver={navDragOver} navDragIdx={navDragIdx} setNavDragOver={setNavDragOver} />}

      {/* ── Projects ── */}
      {effectiveTab === "projects" && <ProjectSettings data={data} update={update} cardStyle={cardStyle} sectionTitle={sectionTitle} />}

      {/* ── Feature Toggles ── */}
      {effectiveTab === "documents" && <DocumentsSettings data={data} update={update} cardStyle={cardStyle} sectionTitle={sectionTitle} />}

      {effectiveTab === "features" && <FeatureToggles data={data} update={update} cardStyle={cardStyle} sectionTitle={sectionTitle} />}
    </div>
  );
}

function FeatureToggles({ data, update, cardStyle, sectionTitle }) {
  const toggles = data.featureToggles || { fo: true };
  const defaultPeriod = data.overviewDefaultPeriod || "all";

  function toggle(key) {
    update(p => ({ featureToggles: { ...(p.featureToggles || { fo: true }), [key]: !(p.featureToggles || { fo: true })[key] } }));
  }

  function setDefaultPeriod(val) {
    update(() => ({ overviewDefaultPeriod: val }));
  }

  const features = [
    {
      key: "fo",
      icon: "◉",
      label: "F&O Tracker",
      sub: "Futures & Options trade journal, P&L calculator, broker charge breakdown and charge profiles.",
    },
    {
      key: "portfolio",
      icon: "📈",
      label: "Portfolio",
      sub: "Track your demat holdings, live LTP prices, P&L, day change and auto-merge duplicate entries.",
    },
  ];

  const PERIODS = [
    { key: "all",   label: "All Time",   icon: "∞" },
    { key: "year",  label: "This Year",  icon: "📅" },
    { key: "month", label: "This Month", icon: "🗓" },
  ];

  const drive = useDrive();
  const [clientInput, setClientInput] = React.useState(data.driveClientId || "");

  return (
    <div style={{ marginTop: 16 }}>

      {/* Google Drive Connect */}
      <div style={{ ...cardStyle, marginBottom: 16, background: drive?.connected?"#f0fdf4":"var(--color-background-primary)", border: drive?.connected?"1px solid #bbf7d0":"0.5px solid var(--color-border-tertiary)" }}>
        {sectionTitle("☁", "Google Drive", "Connect once — all file uploads (Documents, Bills, Project files) go straight to your Drive.")}
        <div style={{ display:"flex", alignItems:"flex-start", gap:14, flexWrap:"wrap", marginTop: 4 }}>
          <img src="https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png" alt="" style={{ width:36, height:36, marginTop:2, flexShrink:0 }} onError={e=>e.target.style.display="none"} />
          <div style={{ flex:1, minWidth:200 }}>
            <div style={{ fontWeight:600, fontSize:14, marginBottom:4 }}>
              {drive?.connected ? `✅ Connected — ${drive.email||"Google Drive"}` : "Connect Google Drive"}
            </div>
            <div style={{ fontSize:12, color:"var(--color-text-secondary)", marginBottom: drive?.connected?0:10 }}>
              {drive?.connected
                ? "All uploads go directly to your Google Drive. Token saved — no re-login needed."
                : "One-time sign-in. Token is saved so you won't be asked again."}
            </div>
            {!drive?.connected && (
              <>
                <div style={{ display:"flex", gap:8, marginBottom:6, flexWrap:"wrap" }}>
                  <input value={clientInput} onChange={e=>setClientInput(e.target.value)}
                    placeholder="Google OAuth Client ID  (xxxx.apps.googleusercontent.com)"
                    style={{ flex:1, minWidth:240, border:"0.5px solid var(--color-border-secondary)", borderRadius:7, padding:"7px 11px", fontSize:12, outline:"none", fontFamily:"inherit", background:"var(--color-background-primary)", color:"var(--color-text-primary)" }} />
                </div>
                <div style={{ fontSize:11, color:"var(--color-text-secondary)" }}>
                  📌 <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" style={{ color:"#1a6b3c" }}>Google Cloud Console</a> → Credentials → Create OAuth 2.0 Client ID → add your app URL to Authorized JS origins.
                </div>
                {drive?.error && <div style={{ fontSize:12, color:"#dc2626", marginTop:6 }}>⚠ {drive.error}</div>}
              </>
            )}
          </div>
          <div style={{ flexShrink:0 }}>
            {drive?.connected
              ? <button onClick={drive.clearDrive} style={{ background:"none", border:"0.5px solid #ccc", borderRadius:8, padding:"7px 14px", cursor:"pointer", fontSize:12, color:"var(--color-text-secondary)" }}>Disconnect</button>
              : <button onClick={()=>drive?.signIn(clientInput)} disabled={drive?.loading}
                  style={{ background:"#1a6b3c", color:"#fff", border:"none", borderRadius:8, padding:"8px 18px", cursor:drive?.loading?"not-allowed":"pointer", fontSize:13, fontWeight:500, opacity:drive?.loading?0.7:1, whiteSpace:"nowrap" }}>
                  {drive?.loading?"Signing in…":"Sign in with Google"}
                </button>
            }
          </div>
        </div>
      </div>

      {/* Default Period preference */}
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        {sectionTitle("📊", "Overview Default Period", "Choose which period Income & Expenses show by default on the Overview page.")}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
          {PERIODS.map(p => (
            <button key={p.key} onClick={() => setDefaultPeriod(p.key)}
              style={{
                flex: 1, minWidth: 100, padding: "14px 10px", borderRadius: 12,
                border: defaultPeriod === p.key ? "2px solid #1a6b3c" : "0.5px solid var(--color-border-secondary)",
                background: defaultPeriod === p.key ? "#e8f5ee" : "var(--color-background-secondary)",
                cursor: "pointer", textAlign: "center",
              }}>
              <div style={{ fontSize: 22, marginBottom: 4 }}>{p.icon}</div>
              <div style={{ fontWeight: defaultPeriod === p.key ? 700 : 500, fontSize: 13, color: defaultPeriod === p.key ? "#1a6b3c" : "var(--color-text-primary)" }}>{p.label}</div>
              {defaultPeriod === p.key && <div style={{ fontSize: 10, color: "#1a6b3c", marginTop: 3, fontWeight: 600 }}>✓ Default</div>}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 10, lineHeight: 1.5 }}>
          💡 This sets what Income & Expenses cards show when you first open Overview. You can still switch periods on the fly.
        </p>
      </div>

      <div style={cardStyle}>
        {sectionTitle("🔧", "Feature Toggles", "Turn features on or off. Your data is always preserved — just hidden until you switch back on.")}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {features.map(f => {
            const isOn = toggles[f.key] !== false;
            return (
              <div key={f.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--color-background-secondary)", borderRadius: 10, padding: "14px 16px", border: "0.5px solid var(--color-border-tertiary)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 20 }}>{f.icon}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{f.label}</div>
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{f.sub}</div>
                  </div>
                </div>
                <button
                  onClick={() => toggle(f.key)}
                  style={{
                    width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
                    background: isOn ? "#1a6b3c" : "var(--color-border-primary)",
                    position: "relative", transition: "background 0.2s", flexShrink: 0,
                  }}
                  title={isOn ? "Turn off" : "Turn on"}
                >
                  <span style={{
                    position: "absolute", top: 3, left: isOn ? 23 : 3,
                    width: 18, height: 18, borderRadius: "50%", background: "#fff",
                    transition: "left 0.2s", display: "block",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.25)"
                  }} />
                </button>
              </div>
            );
          })}
        </div>
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 14, lineHeight: 1.6 }}>
          💡 Toggling a feature off hides it from the sidebar. All data (trades, records, history) is kept safe and will reappear the moment you turn it back on.
        </p>
      </div>
    </div>
  );
}

function ProjectSettings({ data, update, cardStyle, sectionTitle }) {
  const taskTypes = data.projectTaskTypes && data.projectTaskTypes.length > 0
    ? data.projectTaskTypes
    : ["Design", "Development", "Research", "Review", "Testing", "Meeting", "Documentation", "Bug Fix", "Marketing", "Other"];
  const [newType, setNewType] = useState("");
  const [saved, setSaved] = useState(false);

  function addType() {
    const val = newType.trim();
    if (!val || taskTypes.includes(val)) return;
    update(() => ({ projectTaskTypes: [...taskTypes, val] }));
    setNewType("");
    setSaved(true); setTimeout(() => setSaved(false), 1500);
  }

  function deleteType(t) {
    if (taskTypes.length <= 1) return;
    update(() => ({ projectTaskTypes: taskTypes.filter(x => x !== t) }));
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={cardStyle}>
        {sectionTitle("📋", "Project Task Types", "Customize the task type labels used across all your projects.")}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
          {taskTypes.map(t => (
            <I seem to be encountering an error. Can I try something else for you?
