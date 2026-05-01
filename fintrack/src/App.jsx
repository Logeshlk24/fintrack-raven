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
  featureToggles: { fo: true },
  businessData: [],
  projectsData: [],
  projectTaskTypes: ["Design", "Development", "Research", "Review", "Testing", "Meeting", "Documentation", "Bug Fix", "Marketing", "Other"],
};



const ASSET_TYPES = ["Stocks & Equity", "Equity Funds", "Gold & Silver", "FD & RD", "EPF / PPF / NPS", "Real Estate", "Crypto", "Cash", "Other"];
const STRATEGIES = ["Call", "Put"];
const INSTRUMENTS = ["Index Options", "Stock Options", "Commodities"];

const fmt = (n) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n || 0);
const fmtCur = (n) => "₹" + fmt(n);
const fmtPct = (n) => (n >= 0 ? "+" : "") + (n || 0).toFixed(2) + "%";


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
  const [moneyTab, setMoneyTab]         = useState("expenses");
  const [essentialsTab, setEssentialsTab] = useState("essentials");
  const [settingsTab, setSettingsTab]   = useState("trading");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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

  const toggles = data.featureToggles || { fo: true };
  const navItems = [
    { id: "overview", label: "Overview", icon: "⊞" },
    { id: "money", label: "Money", icon: "⊕" },
    ...(toggles.fo ? [{ id: "fo", label: "F&O", icon: "◉" }] : []),
    { id: "portfolio", label: "Portfolio", icon: "📈" },
    { id: "goals", label: "Goals", icon: "◎" },
    { id: "business", label: "Business", icon: "🏢" },
    { id: "projects", label: "Projects", icon: "📋" },
  ];

  return (
    <DriveProvider data={data} update={update}>
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "'DM Sans', sans-serif", background: "var(--color-background-tertiary)", color: "var(--color-text-primary)" }}>
      <style>{LIGHT_MODE_STYLE}</style>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Serif+Display&display=swap" rel="stylesheet" />

      {/* Sidebar */}
      <aside style={{
        width: sidebarCollapsed ? 56 : 200,
        background: "var(--color-background-primary)",
        borderRight: "0.5px solid var(--color-border-tertiary)",
        display: "flex", flexDirection: "column",
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

        {navItems.map(item => (
          <button key={item.id} onClick={() => setPage(item.id)} title={sidebarCollapsed ? item.label : undefined} style={{
            display: "flex", alignItems: "center",
            gap: sidebarCollapsed ? 0 : 10,
            justifyContent: sidebarCollapsed ? "center" : "flex-start",
            padding: sidebarCollapsed ? "0.6rem 0" : "0.6rem 1rem",
            background: page === item.id ? "var(--color-background-secondary)" : "transparent",
            border: "none", cursor: "pointer",
            color: page === item.id ? "var(--color-text-primary)" : "var(--color-text-secondary)",
            fontWeight: page === item.id ? 500 : 400, fontSize: 14,
            borderLeft: page === item.id ? "2px solid #1a6b3c" : "2px solid transparent",
            width: "100%", textAlign: "left", whiteSpace: "nowrap", overflow: "hidden"
          }}>
            <span style={{ fontSize: 16, flexShrink: 0 }}>{item.icon}</span>
            {!sidebarCollapsed && item.label}
          </button>
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
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.user?.email || ""}</div>
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
      <main style={{ flex: 1, padding: "1.5rem", overflowY: "auto" }}>
        {page === "overview" && <Overview data={data} netWorth={netWorth} foNetPnl={foNetPnl} setPage={setPage} toggles={toggles} update={update} />}
        {page === "money" && <MoneyPage data={data} update={update} tab={moneyTab} setTab={setMoneyTab} />}
        {page === "fo" && <FOPage data={data} update={update} tab={foTab} setTab={setFoTab} calcCharges={calcCharges} foNetPnl={foNetPnl} />}
        {page === "portfolio" && <PortfolioPage data={data} update={update} />}
        {page === "goals" && <GoalsPage data={data} update={update} />}
        {page === "business" && <BusinessPage data={data} update={update} />}
        {page === "projects" && <ProjectsPage data={data} update={update} />}
        {page === "settings" && <SettingsPage data={data} update={update} tab={settingsTab} setTab={setSettingsTab} />}
      </main>
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

// ─── Overview ─────────────────────────────────────────────────────────────────
function Overview({ data, netWorth, foNetPnl, setPage, toggles, update }) {
  const foOn = toggles?.fo !== false;
  const todayStr = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const [period, setPeriod] = useState(data.overviewDefaultPeriod || "all");

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
      <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26, marginBottom: 20 }}>Overview</h1>

      {/* Top stat row — F&O card hidden when toggle is off */}
      <div style={{ display: "grid", gridTemplateColumns: foOn ? "1fr 1fr 1fr 1fr" : "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
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

      {/* To-Do list + F&O summary */}
      <div style={{ display: "grid", gridTemplateColumns: foOn ? "1fr 1fr" : "1fr", gap: 12, marginBottom: 12 }}>

        {/* ── Quick To-Do ── */}
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

        {foOn && (
          <Card title="F&O Summary" action={<button onClick={() => setPage("fo")} style={{ fontSize: 12, color: "#1a6b3c", background: "none", border: "none", cursor: "pointer" }}>View all →</button>}>
            <FOSummaryMini trades={data.foTrades} netPnl={foNetPnl} />
          </Card>
        )}
      </div>

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

  const [form, setForm] = useState({ type: "expense", amount: "", category: "", note: "", date: today(), bankId: "", accountType: "all" });
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
    filterPeriod(t) && t.type === (tab === "expenses" ? "expense" : "income")
  );

  function addTx() {
    if (!form.amount) return;
    const type = tab === "income" ? "income" : "expense";
    update(p => ({ transactions: [...p.transactions, { id: Date.now(), ...form, amount: parseFloat(form.amount), type }] }));
    setForm(p => ({ ...p, amount: "", category: "", note: "", date: today() }));
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

  const pageTitle = { expenses: "Expenses", income: "Income", scheduled: "Scheduled Payments", liabilities: "Liabilities" }[tab];

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
        <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26 }}>{pageTitle}</h1>
        {(tab === "income" || tab === "expenses") && <GreenBtn onClick={addTx} label="+ Add" />}
      </div>
      <TabBar tabs={["expenses", "income", "scheduled", "liabilities", "analysis"]} active={tab} setActive={setTab} labels={["Expenses", "Income", "Scheduled", "Liabilities", "Analysis"]} />

      {/* ── Scheduled Payments Tab ── */}
      {tab === "scheduled" && <ScheduledPaymentsTab data={data} update={update} accounts={accounts} />}

      {/* ── Income / Expense Tabs ── */}
      {(tab === "income" || tab === "expenses") && (
        <>
          <PeriodBar periods={["This Week", "This Month", "Last Month", "6M", "12M"]} active={period} setActive={setPeriod} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16, marginTop: 16 }}>
            <Card title={`Add ${tab === "income" ? "Income" : "Expense"}`}>
              <LabelInput label="Amount (INR)" placeholder="e.g. 5000" value={form.amount} onChange={v => setForm(p => ({ ...p, amount: v }))} />
              <LabelInput label="Notes" placeholder="optional" value={form.note} onChange={v => setForm(p => ({ ...p, note: v }))} />
              <LabelInput label="Date" type="date" value={form.date} onChange={v => setForm(p => ({ ...p, date: v }))} />

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

            <Card title={`${filtered.length} entries`}>
              {filtered.length === 0 ? <EmptyState msg={`No ${tab} recorded yet.`} /> : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                    <thead>
                      <tr>{["Date", "Category", "Account", "Notes", "Amount", ""].map(h => (
                        <th key={h} style={{ textAlign: "left", padding: "4px 6px", color: "var(--color-text-secondary)", fontWeight: 500, borderBottom: "0.5px solid var(--color-border-tertiary)", whiteSpace: "nowrap" }}>{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>{filtered.slice().reverse().map(t => {
                      const acct = accounts.find(b => String(b.id) === String(t.bankId));
                      return (
                        <tr key={t.id} style={{ borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                          <td style={{ padding: "5px 6px", color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>{t.date}</td>
                          <td style={{ padding: "5px 6px" }}>{t.category || "—"}</td>
                          <td style={{ padding: "5px 6px" }}>
                            {acct ? <span style={{ background: acct.type === "Credit Card" ? "#fff3e0" : acct.type === "Cash" ? "#f0fdf4" : "#e8f5ee", color: acct.type === "Credit Card" ? "#e65100" : "#1a6b3c", borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 500 }}>{acct.name}</span> : <span style={{ color: "var(--color-text-secondary)" }}>—</span>}
                          </td>
                          <td style={{ padding: "5px 6px", color: "var(--color-text-secondary)" }}>{t.note || "—"}</td>
                          <td style={{ padding: "5px 6px", fontWeight: 500, color: t.type === "income" ? "#1a6b3c" : "#d44" }}>{fmtCur(t.amount)}</td>
                          <td style={{ padding: "2px 4px" }}>
                            <ThreeDotMenu
                              onEdit={() => setEditTx({ ...t })}
                              onDelete={() => update(p => ({ transactions: p.transactions.filter(x => x.id !== t.id) }))}
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

      {/* ── Liabilities Tab ── */}
      {tab === "liabilities" && <LiabilitiesTab data={data} update={update} />}
      {tab === "analysis" && <AnalysisTab data={data} />}
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

          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, margin: "10px 0" }}>
            <StatCard label="Total Trades" value={filtered.length} />
            <StatCard label="Winners" value={winners} />
            <StatCard label="Losers" value={losers} />
            <StatCard label="Win Rate" value={filtered.length > 0 ? ((winners / filtered.length) * 100).toFixed(1) + "%" : "—"} />
            <StatCard label="Net P&L (after charges)" value={fmtCur(filteredPnl)} pnl={filteredPnl} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 16 }}>
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
        <StatCard label="Trades This Month" value={monthTrades.length} />
        <StatCard label="Gross P&L" value={fmtCur(monthGross)} pnl={monthGross} />
        <StatCard label="Total Charges" value={"- " + fmtCur(monthCharges)} />
        <StatCard label="Net P&L" value={fmtCur(monthNet)} pnl={monthNet} big />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: selectedDay ? "1fr 320px" : "1fr", gap: 16 }}>
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
function SettingsPage({ data, update, tab, setTab }) {
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
  const effectiveTab = (!foOn && tab === "trading") ? "accounts" : tab;

  const settingsTabs = foOn
    ? ["trading", "accounts", "categories", "projects", "documents", "features"]
    : ["accounts", "categories", "projects", "documents", "features"];
  const settingsLabels = foOn
    ? ["Trading Settings", "Account Settings", "Categories", "Projects", "Documents", "Features"]
    :  ["Account Settings", "Categories", "Projects", "Documents", "Features"];

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

      {/* ── Trading Settings — only shown when F&O is on ── */}
      {foOn && effectiveTab === "trading" && <TradingSettings data={data} update={update} cardStyle={cardStyle} sectionTitle={sectionTitle} />}

      {/* ── Account Settings ── */}
      {effectiveTab === "accounts" && <AccountSettings data={data} update={update} cardStyle={cardStyle} sectionTitle={sectionTitle} />}

      {/* ── Categories ── */}
      {effectiveTab === "categories" && <CategoriesSettings data={data} update={update} cardStyle={cardStyle} sectionTitle={sectionTitle} />}

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
            <div key={t} style={{ display: "flex", alignItems: "center", gap: 6, background: "#e8f5ee", border: "0.5px solid #1a6b3c33", borderRadius: 8, padding: "5px 10px 5px 12px", fontSize: 13 }}>
              <span style={{ fontWeight: 500, color: "#1a6b3c" }}>{t}</span>
              <button onClick={() => deleteType(t)} style={{ background: "none", border: "none", color: "#d44", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 2px", marginLeft: 2, opacity: 0.7 }} title="Remove">✕</button>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>New Task Type</label>
            <input
              placeholder="e.g. QA, Deployment, Client Call…"
              value={newType}
              onChange={e => setNewType(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addType()}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </div>
          <button onClick={addType} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 500, whiteSpace: "nowrap" }}>+ Add</button>
          {saved && <span style={{ color: "#1a6b3c", fontSize: 13, fontWeight: 500 }}>✓ Saved</span>}
        </div>
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 14, lineHeight: 1.6 }}>
          💡 These types appear in the task type dropdown when adding or editing tasks in any project. Deleting a type won't remove it from existing tasks.
        </p>
      </div>
    </div>
  );
}


// ── BillUploadBtn — used in Business monthly table ────────────────────────────
function BillUploadBtn({ onUploaded }) {
  const drive = useDrive();
  const [busy, setBusy] = useState(false);
  async function handleFile(ev) {
    const file = ev.target.files[0]; if (!file) return;
    setBusy(true);
    if (drive?.connected) {
      const result = await drive.uploadToDrive(file, null);
      if (result) { onUploaded(result); setBusy(false); return; }
    }
    // fallback local
    const reader = new FileReader();
    reader.onload = re => { onUploaded({ url: re.target.result, previewUrl: re.target.result }); setBusy(false); };
    reader.readAsDataURL(file);
  }
  return (
    <label title={drive?.connected ? "Upload bill to Google Drive" : "Upload bill"} style={{ cursor: busy?"not-allowed":"pointer", display:"flex", alignItems:"center", justifyContent:"center", width:36, height:36, borderRadius:6, border: drive?.connected?"1px dashed #1a6b3c":"1px dashed #ccc", color: drive?.connected?"#1a6b3c":"#aaa", fontSize:16, opacity: busy?0.5:1 }}>
      {busy ? "⏳" : drive?.connected ? "☁" : "📎"}
      <input type="file" accept="image/*,application/pdf" style={{ display:"none" }} onChange={handleFile} disabled={busy} />
    </label>
  );
}

// ── DocumentsSettings — full rewrite with Drive, nested folders, preview ──────
function DocumentsSettings({ data, update, cardStyle, sectionTitle }) {
  const drive = useDrive();
  const [folders,      setFoldersState] = useState(data.documentFolders || []);
  const [newName,      setNewName]      = useState("");
  const [openId,       setOpenId]       = useState(null);
  const [preview,      setPreview]      = useState(null);
  const [uploading,    setUploading]    = useState({});
  const [clientInput,  setClientInput]  = useState(data.driveClientId || "");
  const [newSubName,   setNewSubName]   = useState({});

  function setFolders(fn) {
    setFoldersState(prev => {
      const next = typeof fn === "function" ? fn(prev) : fn;
      update(p => ({ documentFolders: next }));
      return next;
    });
  }

  function addFolder(parentId = null) {
    const name = parentId ? (newSubName[parentId]||"").trim() : newName.trim();
    if (!name) return;
    const folder = { id:"f"+Date.now(), name, files:[], subFolders:[], driveFolderId:"" };
    if (!parentId) {
      setFolders(p => [...p, folder]);
      setNewName("");
    } else {
      setFolders(p => p.map(f => f.id===parentId ? { ...f, subFolders:[...(f.subFolders||[]),folder] } : f));
      setNewSubName(p => ({ ...p, [parentId]:"" }));
    }
  }
  function deleteFolder(id, parentId=null) {
    if (!parentId) { setFolders(p => p.filter(f => f.id!==id)); if (openId===id) setOpenId(null); }
    else setFolders(p => p.map(f => f.id===parentId ? { ...f, subFolders:(f.subFolders||[]).filter(s=>s.id!==id) } : f));
  }
  function deleteFile(folderId, fileId, parentId=null) {
    setFolders(p => p.map(f => {
      if (!parentId && f.id===folderId) return { ...f, files:(f.files||[]).filter(d=>d.id!==fileId) };
      if (parentId && f.id===parentId) return { ...f, subFolders:(f.subFolders||[]).map(s => s.id===folderId ? { ...s, files:(s.files||[]).filter(d=>d.id!==fileId) } : s) };
      return f;
    }));
  }
  function setDriveFId(folderId, val, parentId=null) {
    setFolders(p => p.map(f => {
      if (!parentId && f.id===folderId) return { ...f, driveFolderId:val };
      if (parentId && f.id===parentId) return { ...f, subFolders:(f.subFolders||[]).map(s => s.id===folderId ? { ...s, driveFolderId:val } : s) };
      return f;
    }));
  }
  async function uploadFile(folderId, file, driveFId, parentId=null) {
    setUploading(p => ({ ...p, [folderId]:true }));
    let rec;
    if (drive?.connected) {
      const r = await drive.uploadToDrive(file, driveFId||null);
      if (r) rec = { id:r.id, name:r.name, type:r.mimeType, size:r.size, previewUrl:r.previewUrl, webViewLink:r.webViewLink, downloadUrl:r.downloadUrl, source:"gdrive", uploadedAt:new Date().toISOString() };
    }
    if (!rec) {
      const dataUrl = await new Promise(res => { const rd=new FileReader(); rd.onload=e=>res(e.target.result); rd.readAsDataURL(file); });
      rec = { id:"d"+Date.now(), name:file.name, type:file.type, size:file.size, dataUrl, source:"local", uploadedAt:new Date().toISOString() };
    }
    setFolders(p => p.map(f => {
      if (!parentId && f.id===folderId) return { ...f, files:[...(f.files||[]),rec] };
      if (parentId && f.id===parentId) return { ...f, subFolders:(f.subFolders||[]).map(s => s.id===folderId ? { ...s, files:[...(s.files||[]),rec] } : s) };
      return f;
    }));
    setUploading(p => ({ ...p, [folderId]:false }));
  }

  function fmtSize(b){if(!b)return"";if(b<1024)return b+" B";if(b<1048576)return(b/1024).toFixed(1)+" KB";return(b/1048576).toFixed(1)+" MB";}
  function fileIcon(t){if(!t)return"📄";if(t.startsWith("image/"))return"🖼";if(t==="application/pdf")return"📕";if(t.includes("word"))return"📝";if(t.includes("sheet")||t.includes("excel")||t.includes("csv"))return"📊";return"📄";}

  function FileRow({ file, folderId, parentId }) {
    return (
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 10px", borderRadius:8, background:"var(--color-background-secondary)", border:"0.5px solid var(--color-border-tertiary)" }}>
        <div onClick={() => file.previewUrl||file.webViewLink ? setPreview(file) : file.dataUrl && setPreview(file)}
          style={{ width:36, height:36, borderRadius:6, overflow:"hidden", border:"0.5px solid var(--color-border-secondary)", cursor:"pointer", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", background:"#f9fafb", fontSize:20 }}>
          {file.source==="gdrive"
            ? <span style={{ fontSize:18 }}>☁</span>
            : file.type?.startsWith("image/") && file.dataUrl
              ? <img src={file.dataUrl} alt={file.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} />
              : <span>{fileIcon(file.type)}</span>
          }
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div onClick={() => setPreview(file)} style={{ fontSize:13, fontWeight:500, color:"var(--color-text-primary)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", cursor:"pointer" }} title={file.name}>{file.name}</div>
          <div style={{ fontSize:10, color:"var(--color-text-secondary)", display:"flex", gap:6, alignItems:"center" }}>
            {fmtSize(file.size)}
            <span style={{ background:file.source==="gdrive"?"#dbeafe":"#f1f5f9", color:file.source==="gdrive"?"#1d4ed8":"#64748b", borderRadius:3, padding:"0 4px", fontSize:9 }}>
              {file.source==="gdrive"?"☁ Drive":"💾 Local"}
            </span>
            {new Date(file.uploadedAt).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"})}
          </div>
        </div>
        {file.webViewLink
          ? <a href={file.webViewLink} target="_blank" rel="noreferrer" style={{ fontSize:11, color:"#1a6b3c", textDecoration:"none", padding:"3px 9px", border:"0.5px solid #1a6b3c", borderRadius:6, whiteSpace:"nowrap", flexShrink:0 }}>☁ Open</a>
          : file.dataUrl && <a href={file.dataUrl} download={file.name} style={{ fontSize:11, color:"#1a6b3c", textDecoration:"none", padding:"3px 9px", border:"0.5px solid #1a6b3c", borderRadius:6, flexShrink:0 }}>⬇</a>
        }
        <button onClick={() => deleteFile(folderId, file.id, parentId)} style={{ background:"none", border:"0.5px solid #d44", borderRadius:6, padding:"3px 8px", cursor:"pointer", fontSize:11, color:"#d44", flexShrink:0 }}>🗑</button>
      </div>
    );
  }

  function FolderBody({ folder, parentId=null }) {
    const isUp = uploading[folder.id];
    const files = folder.files || [];
    const subs  = folder.subFolders || [];
    const [openSubId, setOpenSubId] = useState(null); // independent from parent openId
    return (
      <div style={{ padding:"12px 14px" }}>
        {/* Drive folder ID */}
        {drive?.connected && (
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10, flexWrap:"wrap" }}>
            <span style={{ fontSize:11, color:"var(--color-text-secondary)", whiteSpace:"nowrap", flexShrink:0 }}>Drive Folder ID:</span>
            <input 
              defaultValue={folder.driveFolderId||""}
              onBlur={e => setDriveFId(folder.id, e.target.value.trim(), parentId)}
              onKeyDown={e => { if (e.key === "Enter") { e.target.blur(); } }}
              placeholder="Paste folder ID here (press Enter or click away to save)"
              style={{ flex:1, minWidth:160, border:"0.5px solid var(--color-border-secondary)", borderRadius:6, padding:"4px 9px", fontSize:11, outline:"none", fontFamily:"inherit", color:"var(--color-text-primary)" }} />
            <a href="https://drive.google.com" target="_blank" rel="noreferrer" style={{ fontSize:11, color:"#1a6b3c", textDecoration:"none", whiteSpace:"nowrap" }}>Open Drive ↗</a>
          </div>
        )}
        {/* Toolbar: upload + add sub-folder */}
        <div style={{ display:"flex", gap:8, marginBottom:12, flexWrap:"wrap", alignItems:"center" }}>
          <label style={{ display:"inline-flex", alignItems:"center", gap:5, background:drive?.connected?"#f0fdf4":"#f9fafb", border:drive?.connected?"1px dashed #1a6b3c":"1px dashed #ccc", borderRadius:7, padding:"6px 12px", cursor:isUp?"not-allowed":"pointer", fontSize:12, color:drive?.connected?"#1a6b3c":"var(--color-text-secondary)", fontWeight:500, opacity:isUp?0.6:1, whiteSpace:"nowrap" }}>
            {isUp?"⏳ Uploading…": drive?.connected?"☁ Upload to Drive":"📎 Upload File"}
            <input type="file" multiple style={{ display:"none" }} disabled={isUp} onChange={e=>Array.from(e.target.files).forEach(f=>uploadFile(folder.id,f,folder.driveFolderId,parentId))} />
          </label>
          {/* Add sub-folder (only top-level folders can have sub-folders) */}
          {!parentId && (
            <div style={{ display:"flex", gap:5, alignItems:"center" }}>
              <input value={newSubName[folder.id]||""} onChange={e=>setNewSubName(p=>({...p,[folder.id]:e.target.value}))}
                onKeyDown={e=>e.key==="Enter"&&addFolder(folder.id)}
                placeholder="Sub-folder name…"
                style={{ border:"0.5px solid var(--color-border-secondary)", borderRadius:7, padding:"5px 9px", fontSize:12, outline:"none", fontFamily:"inherit", width:140 }} />
              <button onClick={()=>addFolder(folder.id)} style={{ background:"var(--color-background-secondary)", border:"0.5px solid var(--color-border-secondary)", borderRadius:7, padding:"5px 10px", cursor:"pointer", fontSize:11, fontWeight:500, whiteSpace:"nowrap" }}>+ Sub-folder</button>
            </div>
          )}
        </div>
        {/* Sub-folders — card grid like main folders */}
        {subs.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", fontWeight: 500, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Sub-folders</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, marginBottom: openSubId ? 12 : 0 }}>
              {subs.map(sub => {
                const fcount = (sub.files || []).length;
                const isOpen = openSubId === sub.id;
                return (
                  <div key={sub.id}
                    onClick={() => setOpenSubId(isOpen ? null : sub.id)}
                    onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 18px rgba(0,0,0,0.10)"}
                    onMouseLeave={e => e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.05)"}
                    style={{ background: "var(--color-background-primary)", borderRadius: 12, border: isOpen ? "2px solid #1a6b3c" : "0.5px solid var(--color-border-secondary)", borderTop: "3px solid #1a6b3c", padding: "0.9rem 1rem 0.75rem", cursor: "pointer", position: "relative", boxShadow: "0 1px 4px rgba(0,0,0,0.05)", transition: "box-shadow 0.15s" }}>
                    <button onClick={e => { e.stopPropagation(); deleteFolder(sub.id, folder.id); }}
                      style={{ position: "absolute", top: 7, right: 7, background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#d44", opacity: 0.5, padding: "2px 4px" }}>🗑</button>
                    <div style={{ fontSize: 26, marginBottom: 5 }}>{isOpen ? "📂" : "📁"}</div>
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 3, paddingRight: 16, wordBreak: "break-word" }}>{sub.name}</div>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                      {fcount} file{fcount !== 1 ? "s" : ""}
                      {fcount === 0 && <span style={{ marginLeft: 4, fontSize: 10, background: "#f1f5f9", color: "#94a3b8", borderRadius: 4, padding: "1px 5px" }}>Empty</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Expanded sub-folder content inline */}
            {openSubId && (() => {
              const sub = subs.find(s => s.id === openSubId);
              if (!sub) return null;
              return (
                <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-secondary)", overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)" }}>
                    <span style={{ fontSize: 18 }}>📂</span>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{sub.name}</span>
                    <button onClick={() => setOpenSubId(null)} style={{ marginLeft: "auto", background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: "2px 10px", cursor: "pointer", fontSize: 11, color: "var(--color-text-secondary)" }}>✕ Close</button>
                  </div>
                  <FolderBody folder={sub} parentId={folder.id} uploading={uploading} drive={drive} setDriveFId={setDriveFId} addFolder={addFolder} deleteFolder={deleteFolder} deleteFile={deleteFile} uploadFile={uploadFile} setPreview={setPreview} newSubName={newSubName} setNewSubName={setNewSubName} />
                </div>
              );
            })()}
          </div>
        )}
        {/* Files */}
        {files.length===0 && subs.length===0 && <div style={{ fontSize:12, color:"var(--color-text-secondary)", padding:"4px 0" }}>Empty folder.</div>}
        {files.length>0 && (
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {files.map(file => <FileRow key={file.id} file={file} folderId={folder.id} parentId={parentId} />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {sectionTitle("🗂", "Documents", "Organise files into folders. Connect Google Drive to store all uploads directly in your Drive.")}

      {/* Add root folder */}
      <div style={cardStyle}>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <input value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addFolder()}
            placeholder="New folder name…"
            style={{ flex:1, border:"0.5px solid var(--color-border-secondary)", borderRadius:8, padding:"8px 12px", fontSize:13, outline:"none", fontFamily:"inherit", background:"var(--color-background-primary)", color:"var(--color-text-primary)" }} />
          <button onClick={()=>addFolder()} style={{ background:"#1a6b3c", color:"#fff", border:"none", borderRadius:8, padding:"8px 18px", cursor:"pointer", fontSize:13, fontWeight:500, whiteSpace:"nowrap" }}>+ New Folder</button>
        </div>
      </div>

      {/* ── Folder grid — like Business year folders ── */}
      {folders.length === 0
        ? <div style={{ textAlign:"center", color:"var(--color-text-secondary)", fontSize:13, padding:"3rem 1rem" }}>
            <div style={{ fontSize:40, marginBottom:8 }}>🗂</div>
            <div>No folders yet. Create one above.</div>
          </div>
        : <>
          {/* Grid of folder cards */}
          {!openId && (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(200px, 1fr))", gap:12, marginTop:4 }}>
              {folders.map(folder => {
                const fcount = (folder.files||[]).length + (folder.subFolders||[]).reduce((s,sf)=>s+(sf.files||[]).length,0);
                const sfCount = (folder.subFolders||[]).length;
                return (
                  <div key={folder.id}
                    onClick={() => setOpenId(folder.id)}
                    onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 18px rgba(0,0,0,0.10)"}
                    onMouseLeave={e => e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.05)"}
                    style={{ background:"var(--color-background-primary)", borderRadius:14, border:"0.5px solid var(--color-border-secondary)", borderTop:"3px solid #1a6b3c", padding:"1.1rem 1.1rem 0.9rem", cursor:"pointer", position:"relative", boxShadow:"0 1px 4px rgba(0,0,0,0.05)", transition:"box-shadow 0.15s" }}>
                    {/* Delete button */}
                    <button onClick={e=>{e.stopPropagation(); deleteFolder(folder.id);}}
                      style={{ position:"absolute", top:8, right:8, background:"none", border:"none", cursor:"pointer", fontSize:13, color:"#d44", opacity:0.5, padding:"2px 4px" }}
                      title="Delete folder">🗑</button>
                    <div style={{ fontSize:32, marginBottom:6 }}>📁</div>
                    <div style={{ fontWeight:700, fontSize:17, marginBottom:4, paddingRight:20, wordBreak:"break-word" }}>{folder.name}</div>
                    <div style={{ fontSize:11, color:"var(--color-text-secondary)", marginBottom:6 }}>
                      {fcount} file{fcount!==1?"s":""}
                      {sfCount>0 && ` · ${sfCount} sub-folder${sfCount!==1?"s":""}`}
                    </div>
                    <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                      {folder.driveFolderId && <span style={{ fontSize:10, background:"#dbeafe", color:"#1d4ed8", borderRadius:4, padding:"1px 6px" }}>☁ Drive</span>}
                      {fcount === 0 && <span style={{ fontSize:10, background:"#f1f5f9", color:"#94a3b8", borderRadius:4, padding:"1px 6px" }}>Empty</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Expanded folder detail view */}
          {openId && (() => {
            const folder = folders.find(f => f.id === openId);
            if (!folder) { setOpenId(null); return null; }
            return (
              <div style={{ marginTop:4 }}>
                {/* Back + header */}
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
                  <button onClick={()=>setOpenId(null)} style={{ background:"none", border:"0.5px solid var(--color-border-secondary)", borderRadius:7, padding:"4px 12px", cursor:"pointer", fontSize:12, color:"var(--color-text-secondary)", display:"flex", alignItems:"center", gap:5 }}>
                    ← Back
                  </button>
                  <span style={{ fontSize:22 }}>📂</span>
                  <span style={{ fontWeight:700, fontSize:18 }}>{folder.name}</span>
                  {folder.driveFolderId && <span style={{ fontSize:11, background:"#dbeafe", color:"#1d4ed8", borderRadius:5, padding:"2px 8px" }}>☁ Drive</span>}
                </div>
                <FolderBody folder={folder} />
              </div>
            );
          })()}
        </>
      }

      {/* Preview modal */}
      {preview && (
        <div onClick={()=>setPreview(null)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.78)", zIndex:9999, display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
          <div onClick={e=>e.stopPropagation()} style={{ background:"#fff", borderRadius:14, overflow:"hidden", maxWidth:"92vw", maxHeight:"92vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,0.4)", minWidth:340 }}>
            <div style={{ padding:"10px 16px", borderBottom:"0.5px solid #e5e7eb", display:"flex", alignItems:"center", justifyContent:"space-between", background:"#f9fafb" }}>
              <span style={{ fontWeight:600, fontSize:13, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:400 }}>{preview.name}</span>
              <div style={{ display:"flex", gap:8, flexShrink:0, marginLeft:12 }}>
                {preview.webViewLink && <a href={preview.webViewLink} target="_blank" rel="noreferrer" style={{ fontSize:12, color:"#1a6b3c", textDecoration:"none", padding:"3px 10px", border:"0.5px solid #1a6b3c", borderRadius:6 }}>☁ Open in Drive</a>}
                {preview.dataUrl && <a href={preview.dataUrl} download={preview.name} style={{ fontSize:12, color:"#1a6b3c", textDecoration:"none", padding:"3px 10px", border:"0.5px solid #1a6b3c", borderRadius:6 }}>⬇</a>}
                <button onClick={()=>setPreview(null)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:20, color:"#6b7280", lineHeight:1 }}>✕</button>
              </div>
            </div>
            <div style={{ overflow:"auto", flex:1, display:"flex", alignItems:"center", justifyContent:"center", padding:8 }}>
              {preview.previewUrl
                ? <iframe src={preview.previewUrl} style={{ width:"82vw", height:"78vh", border:"none" }} title="Preview" allow="autoplay" />
                : preview.dataUrl?.startsWith("data:image")
                  ? <img src={preview.dataUrl} alt={preview.name} style={{ maxWidth:"82vw", maxHeight:"78vh", objectFit:"contain", borderRadius:6 }} />
                  : (preview.dataUrl?.startsWith("data:application/pdf") || preview.type === "application/pdf") && preview.dataUrl
                    ? <object data={preview.dataUrl} type="application/pdf" style={{ width:"82vw", height:"78vh", border:"none" }}>
                        <div style={{ padding:40, textAlign:"center", color:"#6b7280" }}>
                          <div style={{ fontSize:48, marginBottom:12 }}>📕</div>
                          <div style={{ marginBottom:12 }}>PDF preview not supported in this browser.</div>
                          <a href={preview.dataUrl} download={preview.name} style={{ color:"#1a6b3c", fontWeight:500 }}>⬇ Download PDF</a>
                        </div>
                      </object>
                  : preview.dataUrl
                    ? <iframe src={preview.dataUrl} style={{ width:"82vw", height:"78vh", border:"none" }} title="Preview" />
                    : <div style={{ padding:40, textAlign:"center", color:"#6b7280" }}><div style={{ fontSize:48, marginBottom:12 }}>📄</div><div>No preview available</div></div>
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TradingSettings({ data, update, cardStyle, sectionTitle }) {
  const lotSizes = { ...DEFAULT_LOT_SIZES, ...(data.lotSizes || {}) };
  const [form, setForm] = useState({ ...lotSizes });
  const [saved, setSaved] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const custom = data.customInstruments || { "Index Options": [], "Stock Options": [], "Commodities": [] };
  const [newInstrument, setNewInstrument] = useState({ category: "Index Options", name: "", lotSize: "" });
  const indexItems = ["Nifty 50", "Bank Nifty", "Sensex"];
  const commodityItems = ["Crude Oil", "Crude Oil M", "Natural Gas", "Natural Gas M", "Gold", "Gold M"];

  function showSaved(msg) { setSavedMsg(msg); setSaved(true); setTimeout(() => setSaved(false), 2000); }
  function handleSaveLotSizes() {
    const parsed = {};
    Object.entries(form).forEach(([k, v]) => { parsed[k] = Number(v) || 0; });
    update(() => ({ lotSizes: parsed })); showSaved("Lot sizes saved!");
  }
  function handleReset() { setForm({ ...DEFAULT_LOT_SIZES }); update(() => ({ lotSizes: { ...DEFAULT_LOT_SIZES } })); showSaved("Reset to defaults!"); }
  function handleAddInstrument() {
    const name = newInstrument.name.trim(); if (!name) return;
    const cat = newInstrument.category;
    const already = [...(cat === "Index Options" ? indexItems : []), ...(cat === "Commodities" ? commodityItems : []), ...(custom[cat] || [])];
    if (already.includes(name)) return;
    const updatedCustom = { ...custom, [cat]: [...(custom[cat] || []), name] };
    const updatedLotSizes = { ...lotSizes };
    if (newInstrument.lotSize) updatedLotSizes[name] = Number(newInstrument.lotSize);
    setForm(p => ({ ...p, [name]: newInstrument.lotSize || "" }));
    update(() => ({ customInstruments: updatedCustom, lotSizes: updatedLotSizes }));
    setNewInstrument({ category: cat, name: "", lotSize: "" }); showSaved(`"${name}" added!`);
  }
  function handleRemoveInstrument(cat, name) {
    const updatedCustom = { ...custom, [cat]: (custom[cat] || []).filter(x => x !== name) };
    const updatedLotSizes = { ...lotSizes }; delete updatedLotSizes[name];
    setForm(p => { const next = { ...p }; delete next[name]; return next; });
    update(() => ({ customInstruments: updatedCustom, lotSizes: updatedLotSizes })); showSaved(`"${name}" removed!`);
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={cardStyle}>
        {sectionTitle("◉", "Index Options — Lot Sizes", "Default lot sizes for index contracts.")}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
          {[...indexItems, ...(custom["Index Options"] || [])].map(name => (
            <div key={name}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 5, fontWeight: 500 }}>{name}</label>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="number" value={form[name] ?? ""} onChange={e => setForm(p => ({ ...p, [name]: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontWeight: 600, fontSize: 15 }} />
                <span style={{ fontSize: 11, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>/ lot</span>
              </div>
              {DEFAULT_LOT_SIZES[name] !== undefined && Number(form[name]) !== DEFAULT_LOT_SIZES[name] && (
                <div style={{ fontSize: 11, color: "#f0a020", marginTop: 3 }}>Default: {DEFAULT_LOT_SIZES[name]}</div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div style={cardStyle}>
        {sectionTitle("◈", "Commodities — Lot Sizes", "Default lot sizes for commodity contracts on MCX.")}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
          {[...commodityItems, ...(custom["Commodities"] || [])].map(name => (
            <div key={name}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 5, fontWeight: 500 }}>{name}</label>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="number" value={form[name] ?? ""} onChange={e => setForm(p => ({ ...p, [name]: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontWeight: 600, fontSize: 15 }} />
                <span style={{ fontSize: 11, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>/ lot</span>
              </div>
              {DEFAULT_LOT_SIZES[name] !== undefined && Number(form[name]) !== DEFAULT_LOT_SIZES[name] && (
                <div style={{ fontSize: 11, color: "#f0a020", marginTop: 3 }}>Default: {DEFAULT_LOT_SIZES[name]}</div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 24 }}>
        <button onClick={handleSaveLotSizes} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "9px 24px", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>Save Lot Sizes</button>
        <button onClick={handleReset} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "9px 20px", cursor: "pointer", fontSize: 14, color: "var(--color-text-secondary)" }}>Reset to Defaults</button>
        {saved && <span style={{ color: "#1a6b3c", fontSize: 13, fontWeight: 500 }}>✓ {savedMsg}</span>}
      </div>
      <div style={cardStyle}>
        {sectionTitle("⊕", "Manage Instruments", "Add custom instruments to any category.")}
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.5fr 1fr auto", gap: 10, alignItems: "flex-end", marginBottom: 20 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Category</label>
            <select value={newInstrument.category} onChange={e => setNewInstrument(p => ({ ...p, category: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
              <option>Index Options</option><option>Stock Options</option><option>Commodities</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Instrument Name</label>
            <input placeholder="e.g. MIDCPNIFTY, SilverM" value={newInstrument.name} onChange={e => setNewInstrument(p => ({ ...p, name: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Lot Size <span style={{ color: "#aaa" }}>(optional)</span></label>
            <input type="number" placeholder="e.g. 75" value={newInstrument.lotSize} onChange={e => setNewInstrument(p => ({ ...p, lotSize: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
          <button onClick={handleAddInstrument} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13, fontWeight: 500, whiteSpace: "nowrap" }}>+ Add</button>
        </div>
        {["Index Options", "Stock Options", "Commodities"].map(cat => {
          const items = custom[cat] || []; if (items.length === 0) return null;
          return (
            <div key={cat} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>{cat}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {items.map(name => (
                  <div key={name} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "5px 10px", fontSize: 13 }}>
                    <span style={{ fontWeight: 500 }}>{name}</span>
                    {lotSizes[name] && <span style={{ fontSize: 11, color: "#1a6b3c", fontWeight: 600 }}>· {lotSizes[name]}/lot</span>}
                    <button onClick={() => handleRemoveInstrument(cat, name)} style={{ background: "none", border: "none", color: "#d44", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 2px", marginLeft: 2 }}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {["Index Options", "Stock Options", "Commodities"].every(cat => (custom[cat] || []).length === 0) && (
          <p style={{ fontSize: 13, color: "var(--color-text-secondary)", fontStyle: "italic" }}>No custom instruments added yet.</p>
        )}
      </div>
      <div style={{ background: "#fef9e7", border: "0.5px solid #f0c040", borderRadius: 10, padding: "0.8rem 1rem", fontSize: 13, color: "#7a5a00" }}>
        ⚠ Lot size changes affect all future P&L calculations. Existing trades will recalculate automatically.
      </div>
    </div>
  );
}

function AccountSettings({ data, update, cardStyle, sectionTitle }) {
  const accounts = data.banks || [];
  const [acctForm, setAcctForm] = useState({ name: "", type: "Bank", balance: "", creditLimit: "", dueDate: "" });
  const [editAcct, setEditAcct] = useState(null);
  const [adjusting, setAdjusting] = useState(null);
  const [adjustAmt, setAdjustAmt] = useState("");
  const [adjustNote, setAdjustNote] = useState("");

  function addAccount() {
    if (!acctForm.name.trim()) return;
    const opening = parseFloat(acctForm.balance) || 0;
    update(p => ({ banks: [...(p.banks || []), { id: Date.now(), name: acctForm.name.trim(), type: acctForm.type, openingBalance: opening, balance: opening, creditLimit: acctForm.type === "Credit Card" ? parseFloat(acctForm.creditLimit) || 0 : undefined, dueDate: acctForm.type === "Credit Card" ? acctForm.dueDate : undefined }] }));
    setAcctForm({ name: "", type: "Bank", balance: "", creditLimit: "", dueDate: "" });
  }

  function saveEditAcct() {
    if (!editAcct || !editAcct.name.trim()) return;
    update(p => ({ banks: (p.banks || []).map(b => b.id === editAcct.id ? { ...b, name: editAcct.name, openingBalance: editAcct.openingBalance ?? b.openingBalance, creditLimit: editAcct.creditLimit, dueDate: editAcct.dueDate } : b) }));
    setEditAcct(null);
  }

  function deleteAccount(id) { update(p => ({ banks: (p.banks || []).filter(b => b.id !== id) })); }

  function reorderAccounts(newList) { update(p => ({ banks: newList })); }

  function applyAdjustment(direction) {
    if (!adjustAmt || !adjusting) return;
    const amt = parseFloat(adjustAmt); if (isNaN(amt) || amt <= 0) return;
    update(p => ({ transactions: [...p.transactions, { id: Date.now(), type: direction === "add" ? "income" : "expense", amount: amt, category: adjustNote || (direction === "add" ? "Balance Top-up" : "Balance Adjustment"), note: `${adjusting.name} manual adjustment`, date: new Date().toISOString().split("T")[0], bankId: adjusting.id }] }));
    setAdjusting(null); setAdjustAmt(""); setAdjustNote("");
  }

  return (
    <div style={{ marginTop: 16 }}>
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
                  <input type="number" value={editAcct.openingBalance ?? ""} onChange={e => setEditAcct(p => ({ ...p, openingBalance: parseFloat(e.target.value) || 0 }))} style={{ width: "100%", boxSizing: "border-box" }} />
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
      {/* Adjust Balance Modal */}
      {adjusting && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 16, padding: "1.5rem", width: "min(380px, 90vw)", border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>Adjust Balance</div>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 16 }}>{adjusting.name}</div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Amount (₹)</label>
              <input type="number" placeholder="e.g. 5000" value={adjustAmt} onChange={e => setAdjustAmt(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 16, fontWeight: 600 }} autoFocus />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Note (optional)</label>
              <input placeholder="e.g. Salary credit" value={adjustNote} onChange={e => setAdjustNote(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => applyAdjustment("add")} style={{ flex: 1, background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "10px", cursor: "pointer", fontWeight: 600, fontSize: 14 }}>+ Add Money</button>
              <button onClick={() => applyAdjustment("subtract")} style={{ flex: 1, background: "#d44", color: "#fff", border: "none", borderRadius: 8, padding: "10px", cursor: "pointer", fontWeight: 600, fontSize: 14 }}>− Deduct</button>
              <button onClick={() => { setAdjusting(null); setAdjustAmt(""); setAdjustNote(""); }} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "10px 14px", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Add Account */}
      <div style={cardStyle}>
        {sectionTitle("🏦", "Add Account", "Add bank accounts, credit cards or cash wallets.")}
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr auto", gap: 10, alignItems: "flex-end" }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Account Name</label>
            <input placeholder="e.g. HDFC Savings, SBI, Axis CC" value={acctForm.name} onChange={e => setAcctForm(p => ({ ...p, name: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} onKeyDown={e => e.key === "Enter" && addAccount()} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Type</label>
            <select value={acctForm.type} onChange={e => setAcctForm(p => ({ ...p, type: e.target.value }))} style={{ boxSizing: "border-box" }}>
              <option>Bank</option><option>Credit Card</option><option>Cash</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Opening Balance (₹)</label>
            <input type="number" placeholder="e.g. 10000" value={acctForm.balance} onChange={e => setAcctForm(p => ({ ...p, balance: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
          <GreenBtn onClick={addAccount} label="+ Add" />
        </div>
        {acctForm.type === "Credit Card" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
            <div>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Card Limit (₹)</label>
              <input type="number" placeholder="e.g. 1,00,000" value={acctForm.creditLimit} onChange={e => setAcctForm(p => ({ ...p, creditLimit: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Due Date (day of month)</label>
              <input type="number" min="1" max="31" placeholder="e.g. 15" value={acctForm.dueDate} onChange={e => setAcctForm(p => ({ ...p, dueDate: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
            </div>
          </div>
        )}
      </div>

      {/* All Accounts — draggable list */}
      {accounts.length > 0 && (
        <div style={cardStyle}>
          {sectionTitle("🏦", "Accounts", "Drag ⠿ to reorder")}
          <DraggableList
            items={accounts}
            keyFn={a => a.id}
            onReorder={reorderAccounts}
            renderItem={acct => {
              const txInc = data.transactions.filter(t => t.type === "income" && String(t.bankId) === String(acct.id)).reduce((s, t) => s + Number(t.amount), 0);
              const txExp = data.transactions.filter(t => t.type === "expense" && String(t.bankId) === String(acct.id)).reduce((s, t) => s + Number(t.amount), 0);
              let bal;
              if (acct.type === "Credit Card") bal = (acct.openingBalance || 0) + txExp - txInc;
              else bal = (acct.openingBalance || 0) + txInc - txExp;
              const typeBadge = acct.type === "Credit Card"
                ? <span style={{ fontSize: 10, background: "#fff3e0", color: "#e65100", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>CC</span>
                : acct.type === "Cash"
                ? <span style={{ fontSize: 10, background: "#f0fdf4", color: "#1a6b3c", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>CASH</span>
                : <span style={{ fontSize: 10, background: "#f1f5f9", color: "#64748b", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>BANK</span>;
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px 9px 0" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{acct.name}</span>
                      {typeBadge}
                    </div>
                    <div style={{ display: "flex", gap: 10, fontSize: 12, alignItems: "center" }}>
                      <span style={{ fontWeight: 600, color: bal >= 0 ? "var(--color-text-primary)" : "#d44" }}>{fmtCur(bal)}</span>
                      {acct.type !== "Credit Card" && (
                        <>
                          <span style={{ color: "#1a6b3c", fontSize: 11 }}>↑{fmtCur(txInc)}</span>
                          <span style={{ color: "#d44", fontSize: 11 }}>↓{fmtCur(txExp)}</span>
                        </>
                      )}
                      {acct.type === "Credit Card" && acct.creditLimit > 0 && (
                        <span style={{ color: "var(--color-text-secondary)", fontSize: 11 }}>Limit: {fmtCur(acct.creditLimit)}</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button onClick={() => { setAdjusting(acct); setAdjustAmt(""); setAdjustNote(""); }}
                      style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontSize: 11, color: "var(--color-text-secondary)" }}>± Adjust</button>
                    <ThreeDotMenu onEdit={() => setEditAcct({ ...acct })} onDelete={() => deleteAccount(acct.id)} />
                  </div>
                </div>
              );
            }}
          />
        </div>
      )}
      {accounts.length === 0 && <EmptyState msg="No accounts yet. Add your first account above." />}
    </div>
  );
}

function CategoriesSettings({ data, update, cardStyle, sectionTitle }) {
  const categories = data.categories || { expense: ["Food", "Rent", "Travel", "Shopping", "Health", "Bills", "EMI", "Other"], income: ["Salary", "Freelance", "Investment", "Business", "Gift", "Other"] };
  const [newCat, setNewCat] = useState({ type: "expense", name: "" });
  const [editCat, setEditCat] = useState(null);
  const [editCatName, setEditCatName] = useState("");

  function addCategory() {
    if (!newCat.name.trim()) return;
    const cats = data.categories || { expense: [], income: [] };
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

  function reorderCategories(type, newList) {
    const cats = data.categories || { expense: [], income: [] };
    update(() => ({ categories: { ...cats, [type]: newList } }));
  }

  return (
    <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      {editCat && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 16, padding: "1.5rem", width: "min(340px, 90vw)", border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 12 }}>✏️ Rename Category</div>
            <input value={editCatName} onChange={e => setEditCatName(e.target.value)} onKeyDown={e => e.key === "Enter" && saveEditCat()} style={{ width: "100%", boxSizing: "border-box", marginBottom: 14, fontSize: 14 }} autoFocus />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => { setEditCat(null); setEditCatName(""); }} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "8px 16px", cursor: "pointer", color: "var(--color-text-secondary)" }}>Cancel</button>
              <button onClick={saveEditCat} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontWeight: 600 }}>Save</button>
            </div>
          </div>
        </div>
      )}
      {["expense", "income"].map(type => (
        <Card key={type} title={type === "expense" ? "🔴 Expense Categories" : "🟢 Income Categories"}>
          <div style={{ marginBottom: 12 }}>
            {(categories[type] || []).length === 0
              ? <EmptyState msg="No categories yet." />
              : <DraggableList
                  items={categories[type] || []}
                  keyFn={cat => cat}
                  onReorder={newList => reorderCategories(type, newList)}
                  renderItem={cat => (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 10px 7px 0" }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{cat}</span>
                      <ThreeDotMenu onEdit={() => { setEditCat({ type, oldName: cat }); setEditCatName(cat); }} onDelete={() => deleteCategory(type, cat)} />
                    </div>
                  )}
                />
            }
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder={`New ${type} category`} value={newCat.type === type ? newCat.name : ""} onFocus={() => setNewCat(p => ({ ...p, type }))} onChange={e => setNewCat({ type, name: e.target.value })} onKeyDown={e => e.key === "Enter" && addCategory()} style={{ flex: 1, boxSizing: "border-box" }} />
            <button onClick={addCategory} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 500, whiteSpace: "nowrap" }}>+ Add</button>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─── Scheduled Payments Tab ──────────────────────────────────────────────────

// ═══════════════════════════ ANALYSIS TAB ═══════════════════════════════════
function AnalysisTab({ data }) {
  const [view,     setView]     = useState("graph");
  const [period,   setPeriod]   = useState("6M");
  const [calYear,  setCalYear]  = useState(new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [calDay,   setCalDay]   = useState(null);

  const txns = data.transactions || [];
  const fmtCur = n => "₹" + Math.abs(Number(n)||0).toLocaleString("en-IN", {maximumFractionDigits:0});
  const COLORS = ["#6d28d9","#1a6b3c","#f59e0b","#ef4444","#3b82f6","#10b981","#f97316","#8b5cf6","#ec4899","#14b8a6","#a78bfa","#84cc16"];

  function inPeriod(t) {
    const d = new Date(t.date), now = new Date(); now.setHours(0,0,0,0);
    const s = new Date(now);
    if (period==="1M") s.setMonth(s.getMonth()-1);
    else if (period==="3M") s.setMonth(s.getMonth()-3);
    else if (period==="6M") s.setMonth(s.getMonth()-6);
    else if (period==="1Y") s.setFullYear(s.getFullYear()-1);
    else return true;
    return d >= s;
  }
  const filtered = txns.filter(inPeriod);

  // ── GRAPH VIEW with mouse-tracking tooltip ──────────────────────────────
  function GraphView() {
    const [hovered, setHovered] = useState(null); // index
    const [mouse,   setMouse]   = useState({x:0,y:0});
    const svgRef = React.useRef(null);

    // Build monthly buckets
    const buckets = {};
    filtered.forEach(t => {
      const d = new Date(t.date);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
      if (!buckets[key]) buckets[key] = {income:0,expense:0,label:""};
      buckets[key].label = d.toLocaleString("en-IN",{month:"short"})+" '"+String(d.getFullYear()).slice(2);
      if (t.type==="income")  buckets[key].income  += Number(t.amount||0);
      if (t.type==="expense") buckets[key].expense += Number(t.amount||0);
    });
    const months = Object.keys(buckets).sort();
    const pts = months.map(k => buckets[k]);

    if (!pts.length) return (
      <div style={{textAlign:"center",padding:"4rem",color:"var(--color-text-secondary)"}}>
        <div style={{fontSize:40,marginBottom:8}}>📊</div>No data in this period.
      </div>
    );

    const W=680, H=220, PL=52, PR=20, PT=16, PB=40;
    const cw = W-PL-PR, ch = H-PT-PB;
    const n = pts.length;
    const maxVal = Math.max(...pts.map(p=>Math.max(p.income,p.expense)),1);
    const xOf = i => PL + (n>1 ? (i/(n-1))*cw : cw/2);
    const yOf = v => PT + ch - (v/maxVal)*ch;

    function mkPath(key) {
      return pts.map((p,i)=>`${i===0?"M":"L"}${xOf(i).toFixed(1)},${yOf(p[key]).toFixed(1)}`).join(" ");
    }
    function mkArea(key) {
      const base = PT+ch;
      return `M${xOf(0)},${base} ${pts.map((p,i)=>`L${xOf(i).toFixed(1)},${yOf(p[key]).toFixed(1)}`).join(" ")} L${xOf(n-1)},${base} Z`;
    }

    function onSvgMouseMove(e) {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const svgX = (e.clientX - rect.left) * (W / rect.width);
      // Find closest data point
      let closest = 0, minDist = Infinity;
      for (let i=0;i<n;i++) {
        const d = Math.abs(svgX - xOf(i));
        if (d < minDist) { minDist=d; closest=i; }
      }
      setHovered(closest);
      setMouse({x: e.clientX - rect.left, y: e.clientY - rect.top});
    }

    const gridVals = [0,0.25,0.5,0.75,1].map(f=>({y:yOf(maxVal*f),v:maxVal*f}));
    const p = hovered!==null ? pts[hovered] : null;

    return (
      <div style={{position:"relative"}}>
        <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H+PB}`}
          style={{display:"block",overflow:"visible",cursor:"crosshair"}}
          onMouseMove={onSvgMouseMove}
          onMouseLeave={()=>setHovered(null)}>
          <defs>
            <linearGradient id="gInc" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1a6b3c" stopOpacity="0.2"/>
              <stop offset="100%" stopColor="#1a6b3c" stopOpacity="0.01"/>
            </linearGradient>
            <linearGradient id="gExp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ef4444" stopOpacity="0.15"/>
              <stop offset="100%" stopColor="#ef4444" stopOpacity="0.01"/>
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {gridVals.map((g,i)=>(
            <g key={i}>
              <line x1={PL} x2={W-PR} y1={g.y} y2={g.y} stroke="#e5e7eb" strokeWidth={0.8}/>
              <text x={PL-6} y={g.y+4} textAnchor="end" fontSize={9} fill="#9ca3af">
                {g.v>=1e7?(g.v/1e7).toFixed(1)+"Cr":g.v>=1e5?(g.v/1e5).toFixed(1)+"L":g.v>=1e3?(g.v/1e3).toFixed(0)+"K":g.v.toFixed(0)}
              </text>
            </g>
          ))}

          {/* Area fills */}
          <path d={mkArea("income")}  fill="url(#gInc)"/>
          <path d={mkArea("expense")} fill="url(#gExp)"/>

          {/* Lines */}
          <path d={mkPath("income")}  fill="none" stroke="#1a6b3c" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round"/>
          <path d={mkPath("expense")} fill="none" stroke="#ef4444" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round"/>

          {/* Hover vertical line */}
          {hovered!==null && (
            <line x1={xOf(hovered)} x2={xOf(hovered)} y1={PT} y2={PT+ch}
              stroke="#6b7280" strokeWidth={1} strokeDasharray="4,3" opacity={0.6}/>
          )}

          {/* Dots */}
          {pts.map((p,i)=>(
            <g key={i}>
              {/* Invisible wide hit target */}
              <rect x={xOf(i)-(n>1?cw/(n-1)/2:30)} y={PT} width={n>1?cw/(n-1):60} height={ch} fill="transparent"/>
              <circle cx={xOf(i)} cy={yOf(p.income)}  r={hovered===i?6:3.5} fill="#1a6b3c" stroke="#fff" strokeWidth={hovered===i?2:0} style={{transition:"r 0.1s"}}/>
              <circle cx={xOf(i)} cy={yOf(p.expense)} r={hovered===i?6:3.5} fill="#ef4444" stroke="#fff" strokeWidth={hovered===i?2:0} style={{transition:"r 0.1s"}}/>
              <text x={xOf(i)} y={PT+ch+16} textAnchor="middle" fontSize={9}
                fill={hovered===i?"#111":"#9ca3af"} fontWeight={hovered===i?"700":"400"}>
                {p.label}
              </text>
            </g>
          ))}

          {/* Legend */}
          {[["Income","#1a6b3c",0],["Expense","#ef4444",70]].map(([l,c,off])=>(
            <g key={l}>
              <circle cx={W/2-60+off} cy={PT+ch+34} r={4} fill={c}/>
              <text x={W/2-54+off} y={PT+ch+38} fontSize={10} fill="#6b7280">{l}</text>
            </g>
          ))}
        </svg>

        {/* Tooltip — follows mouse */}
        {hovered!==null && p && (
          <div style={{
            position:"absolute",
            left: mouse.x + 14,
            top:  Math.max(0, mouse.y - 80),
            background:"#1e293b",
            color:"#f8fafc",
            borderRadius:10,
            padding:"10px 14px",
            pointerEvents:"none",
            zIndex:50,
            minWidth:160,
            boxShadow:"0 8px 24px rgba(0,0,0,0.25)",
            fontSize:12,
          }}>
            <div style={{fontWeight:700,fontSize:13,marginBottom:8,borderBottom:"0.5px solid rgba(255,255,255,0.15)",paddingBottom:6}}>
              {pts[hovered].label}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
              <span style={{width:8,height:8,borderRadius:"50%",background:"#1a6b3c",display:"inline-block"}}/>
              <span style={{color:"#94a3b8",flex:1}}>Income</span>
              <span style={{fontWeight:700,color:"#4ade80"}}>{fmtCur(pts[hovered].income)}</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
              <span style={{width:8,height:8,borderRadius:"50%",background:"#ef4444",display:"inline-block"}}/>
              <span style={{color:"#94a3b8",flex:1}}>Expense</span>
              <span style={{fontWeight:700,color:"#f87171"}}>{fmtCur(pts[hovered].expense)}</span>
            </div>
            <div style={{borderTop:"0.5px solid rgba(255,255,255,0.15)",paddingTop:6,display:"flex",alignItems:"center",gap:8}}>
              <span style={{width:8,height:8,borderRadius:"50%",background: pts[hovered].income-pts[hovered].expense>=0?"#4ade80":"#f87171",display:"inline-block"}}/>
              <span style={{color:"#94a3b8",flex:1}}>Net</span>
              <span style={{fontWeight:700,color:pts[hovered].income-pts[hovered].expense>=0?"#4ade80":"#f87171"}}>
                {pts[hovered].income-pts[hovered].expense>=0?"+":""}{fmtCur(pts[hovered].income-pts[hovered].expense)}
              </span>
            </div>
          </div>
        )}

        {/* Summary table */}
        <div style={{marginTop:12,overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead>
              <tr style={{background:"var(--color-background-secondary)"}}>
                {["Month","Income","Expense","Net"].map(h=>(
                  <th key={h} style={{padding:"6px 12px",textAlign:"left",fontSize:11,color:"var(--color-text-secondary)",fontWeight:500}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pts.map((p,i)=>(
                <tr key={i} style={{borderTop:"0.5px solid var(--color-border-tertiary)",background:hovered===i?"#f0fdf4":"transparent",transition:"background 0.1s"}}>
                  <td style={{padding:"7px 12px",fontWeight:hovered===i?600:400}}>{p.label}</td>
                  <td style={{padding:"7px 12px",color:"#1a6b3c",fontWeight:600}}>{fmtCur(p.income)}</td>
                  <td style={{padding:"7px 12px",color:"#ef4444",fontWeight:600}}>{fmtCur(p.expense)}</td>
                  <td style={{padding:"7px 12px",color:(p.income-p.expense)>=0?"#1a6b3c":"#ef4444",fontWeight:600}}>
                    {(p.income-p.expense)>=0?"+":""}{fmtCur(p.income-p.expense)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── PIE CHART ──────────────────────────────────────────────────────────────
  function PieView() {
    const [pieType, setPieType] = useState("expense");
    const [hovSlice, setHovSlice] = useState(null);
    const relevant = filtered.filter(t=>t.type===pieType);
    const catMap = {};
    relevant.forEach(t=>{ const c=t.category||"Other"; catMap[c]=(catMap[c]||0)+Number(t.amount||0); });
    const entries = Object.entries(catMap).sort((a,b)=>b[1]-a[1]);
    const total = entries.reduce((s,[,v])=>s+v,0);
    if (!entries.length) return (
      <div style={{textAlign:"center",padding:"4rem",color:"var(--color-text-secondary)"}}>
        <div style={{fontSize:40,marginBottom:8}}>🥧</div>No {pieType} data in this period.
      </div>
    );
    const R=90, CX=120, CY=110;
    let angle=-Math.PI/2;
    const slices = entries.map(([cat,val],i)=>{
      const sweep=val/total*2*Math.PI;
      const x1=CX+R*Math.cos(angle), y1=CY+R*Math.sin(angle);
      angle+=sweep;
      const x2=CX+R*Math.cos(angle), y2=CY+R*Math.sin(angle);
      return {cat,val,frac:val/total,color:COLORS[i%COLORS.length],x1,y1,x2,y2,large:sweep>Math.PI?1:0};
    });
    return (
      <div>
        <div style={{display:"flex",gap:0,background:"var(--color-background-secondary)",borderRadius:8,padding:3,width:"fit-content",marginBottom:20}}>
          {["expense","income"].map(t=>(
            <button key={t} onClick={()=>setPieType(t)}
              style={{padding:"5px 18px",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:500,
                background:pieType===t?"#fff":"transparent",
                color:pieType===t?(t==="expense"?"#ef4444":"#1a6b3c"):"var(--color-text-secondary)",
                boxShadow:pieType===t?"0 1px 3px rgba(0,0,0,0.1)":"none"}}>
              {t==="expense"?"Expenses":"Income"}
            </button>
          ))}
        </div>
        <div style={{display:"flex",gap:32,alignItems:"flex-start",flexWrap:"wrap"}}>
          <svg width={240} height={220} style={{flexShrink:0}}>
            {slices.map((s,i)=>(
              <path key={i}
                d={`M${CX},${CY} L${s.x1},${s.y1} A${R},${R} 0 ${s.large},1 ${s.x2},${s.y2} Z`}
                fill={s.color} stroke="#fff" strokeWidth={hovSlice===i?3:2}
                opacity={hovSlice===null||hovSlice===i?1:0.6}
                style={{cursor:"pointer",transition:"opacity 0.15s"}}
                onMouseEnter={()=>setHovSlice(i)} onMouseLeave={()=>setHovSlice(null)}
              />
            ))}
            <text x={CX} y={CY-6} textAnchor="middle" fontSize={11} fill="#6b7280">Total</text>
            <text x={CX} y={CY+14} textAnchor="middle" fontSize={14} fontWeight="700" fill="var(--color-text-primary)">
              {hovSlice!==null ? fmtCur(slices[hovSlice].val) : fmtCur(total)}
            </text>
            {hovSlice!==null && (
              <text x={CX} y={CY+30} textAnchor="middle" fontSize={10} fill="#6b7280">
                {slices[hovSlice].cat} · {(slices[hovSlice].frac*100).toFixed(1)}%
              </text>
            )}
          </svg>
          <div style={{flex:1,minWidth:180}}>
            {entries.map(([cat,val],i)=>(
              <div key={cat}
                onMouseEnter={()=>setHovSlice(i)} onMouseLeave={()=>setHovSlice(null)}
                style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,padding:"6px 8px",borderRadius:7,
                  background:hovSlice===i?"var(--color-background-secondary)":"transparent",cursor:"default",transition:"background 0.1s"}}>
                <span style={{width:12,height:12,borderRadius:3,background:COLORS[i%COLORS.length],flexShrink:0}}/>
                <span style={{flex:1,fontSize:13,fontWeight:500}}>{cat}</span>
                <span style={{fontSize:13,color:pieType==="expense"?"#ef4444":"#1a6b3c",fontWeight:600}}>{fmtCur(val)}</span>
                <span style={{fontSize:11,color:"var(--color-text-secondary)",minWidth:36,textAlign:"right"}}>
                  {(val/total*100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── CALENDAR VIEW ─────────────────────────────────────────────────────────
  function CalendarView() {
    const DAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
    const dayMap={};
    txns.forEach(t=>{
      const d=new Date(t.date);
      if(d.getFullYear()!==calYear||d.getMonth()!==calMonth) return;
      const k=d.getDate();
      if(!dayMap[k]) dayMap[k]={income:0,expense:0,txns:[]};
      if(t.type==="income") dayMap[k].income+=Number(t.amount||0);
      if(t.type==="expense") dayMap[k].expense+=Number(t.amount||0);
      dayMap[k].txns.push(t);
    });
    const firstDay=new Date(calYear,calMonth,1).getDay();
    const daysCount=new Date(calYear,calMonth+1,0).getDate();
    const cells=[];
    for(let i=0;i<firstDay;i++) cells.push(null);
    for(let d=1;d<=daysCount;d++) cells.push(d);
    const selTxns=calDay?(dayMap[calDay]?.txns||[]):[];
    const today=new Date();
    function prev(){if(calMonth===0){setCalMonth(11);setCalYear(y=>y-1);}else setCalMonth(m=>m-1);setCalDay(null);}
    function next(){if(calMonth===11){setCalMonth(0);setCalYear(y=>y+1);}else setCalMonth(m=>m+1);setCalDay(null);}
    const mIncome=Object.values(dayMap).reduce((s,d)=>s+d.income,0);
    const mExpense=Object.values(dayMap).reduce((s,d)=>s+d.expense,0);
    return (
      <div style={{display:"flex",gap:24,flexWrap:"wrap",alignItems:"flex-start"}}>
        <div style={{flex:"0 0 auto",minWidth:320}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <button onClick={prev} style={{background:"none",border:"none",cursor:"pointer",fontSize:20,color:"var(--color-text-secondary)",padding:"0 8px"}}>‹</button>
            <span style={{fontWeight:700,fontSize:15}}>{MONTHS[calMonth]} {calYear}</span>
            <button onClick={next} style={{background:"none",border:"none",cursor:"pointer",fontSize:20,color:"var(--color-text-secondary)",padding:"0 8px"}}>›</button>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2,marginBottom:4}}>
            {DAYS.map(d=><div key={d} style={{textAlign:"center",fontSize:10,color:"var(--color-text-secondary)",fontWeight:600,padding:"4px 0"}}>{d}</div>)}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2}}>
            {cells.map((day,i)=>{
              if(!day) return <div key={i}/>;
              const info=dayMap[day];
              const isToday=day===today.getDate()&&calMonth===today.getMonth()&&calYear===today.getFullYear();
              const isSel=day===calDay;
              return (
                <div key={day} onClick={()=>setCalDay(isSel?null:day)}
                  style={{borderRadius:8,padding:"5px 3px",minHeight:52,cursor:info?"pointer":"default",
                    background:isSel?"#1a6b3c":isToday?"#f0fdf4":"var(--color-background-secondary)",
                    border:isSel?"2px solid #1a6b3c":isToday?"1.5px solid #bbf7d0":"1px solid var(--color-border-tertiary)",
                    display:"flex",flexDirection:"column",alignItems:"center",gap:2,transition:"background 0.1s"}}>
                  <span style={{fontSize:12,fontWeight:isToday||isSel?700:400,color:isSel?"#fff":isToday?"#1a6b3c":"var(--color-text-primary)"}}>{day}</span>
                  {info?.income>0&&<span style={{fontSize:8,background:isSel?"rgba(255,255,255,0.2)":"#dcfce7",color:isSel?"#fff":"#166534",borderRadius:3,padding:"0 3px",lineHeight:"14px"}}>+{fmtCur(info.income)}</span>}
                  {info?.expense>0&&<span style={{fontSize:8,background:isSel?"rgba(255,255,255,0.2)":"#fee2e2",color:isSel?"#fff":"#991b1b",borderRadius:3,padding:"0 3px",lineHeight:"14px"}}>-{fmtCur(info.expense)}</span>}
                </div>
              );
            })}
          </div>
          <div style={{marginTop:10,display:"flex",gap:16,fontSize:12,borderTop:"0.5px solid var(--color-border-tertiary)",paddingTop:10}}>
            <span style={{color:"#1a6b3c",fontWeight:600}}>Income: {fmtCur(mIncome)}</span>
            <span style={{color:"#ef4444",fontWeight:600}}>Expense: {fmtCur(mExpense)}</span>
            <span style={{color:(mIncome-mExpense)>=0?"#1a6b3c":"#ef4444",fontWeight:600}}>Net: {(mIncome-mExpense)>=0?"+":""}{fmtCur(mIncome-mExpense)}</span>
          </div>
        </div>
        <div style={{flex:1,minWidth:220}}>
          {calDay ? (
            <>
              <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>
                {calDay} {MONTHS[calMonth]} {calYear}
                <span style={{fontSize:11,fontWeight:400,color:"var(--color-text-secondary)",marginLeft:8}}>{selTxns.length} transaction{selTxns.length!==1?"s":""}</span>
              </div>
              {selTxns.length===0
                ? <div style={{color:"var(--color-text-secondary)",fontSize:13}}>No transactions.</div>
                : selTxns.map(t=>(
                    <div key={t.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:8,marginBottom:6,background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-tertiary)"}}>
                      <span style={{width:8,height:8,borderRadius:"50%",background:t.type==="income"?"#1a6b3c":"#ef4444",flexShrink:0}}/>
                      <div style={{flex:1}}>
                        <div style={{fontSize:13,fontWeight:500}}>{t.category||"—"}</div>
                        {t.note&&<div style={{fontSize:11,color:"var(--color-text-secondary)"}}>{t.note}</div>}
                      </div>
                      <span style={{fontWeight:700,color:t.type==="income"?"#1a6b3c":"#ef4444",fontSize:13}}>
                        {t.type==="income"?"+":"-"}{fmtCur(t.amount)}
                      </span>
                    </div>
                  ))
              }
            </>
          ) : (
            <div style={{color:"var(--color-text-secondary)",fontSize:13,paddingTop:8,display:"flex",flexDirection:"column",gap:6}}>
              <div style={{fontSize:28,marginBottom:4}}>📅</div>
              Click any day with transactions to see details.
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────
  const views=[
    {id:"graph",   label:"📈 Income vs Expense"},
    {id:"pie",     label:"🥧 Category Breakdown"},
    {id:"calendar",label:"📅 Calendar"},
  ];
  return (
    <div style={{marginTop:16}}>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        {views.map(v=>(
          <button key={v.id} onClick={()=>setView(v.id)}
            style={{padding:"7px 16px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:500,
              background:view===v.id?"#1a6b3c":"var(--color-background-secondary)",
              color:view===v.id?"#fff":"var(--color-text-secondary)",
              boxShadow:view===v.id?"0 2px 8px rgba(26,107,60,0.2)":"none",transition:"all 0.15s"}}>
            {v.label}
          </button>
        ))}
        {view!=="calendar" && (
          <div style={{marginLeft:"auto",display:"flex",gap:4}}>
            {["1M","3M","6M","1Y","All"].map(p=>(
              <button key={p} onClick={()=>setPeriod(p)}
                style={{padding:"5px 10px",borderRadius:6,border:"0.5px solid var(--color-border-secondary)",cursor:"pointer",fontSize:11,fontWeight:500,
                  background:period===p?"#1a6b3c":"none",color:period===p?"#fff":"var(--color-text-secondary)"}}>
                {p}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{background:"var(--color-background-primary)",borderRadius:14,border:"0.5px solid var(--color-border-tertiary)",padding:"20px 24px"}}>
        {view==="graph"    && <GraphView/>}
        {view==="pie"      && <PieView/>}
        {view==="calendar" && <CalendarView/>}
      </div>
    </div>
  );
}
// ═══════════════════════════════════════════════════════════════════════════

function ScheduledPaymentsTab({ data, update, accounts }) {
  const payments = data.scheduledPayments || [];
  const categories = data.categories || { expense: ["Food","Rent","Travel","Shopping","Health","Bills","EMI","Other"], income: ["Salary","Freelance","Investment","Business","Gift","Other"] };
  const [form, setForm] = useState({ name: "", flowType: "expense", type: "EMI", amount: "", day: "", startMonth: new Date().toISOString().slice(0, 7), freq: "monthly", customEveryN: "1", customUnit: "months", tenure: "", notes: "", accountId: "" });
  const [view, setView] = useState("list");
  const [editingPayment, setEditingPayment] = useState(null); // holds the payment being edited
  const [editForm, setEditForm] = useState(null);

  function startEdit(p) {
    setEditingPayment(p.id);
    setEditForm({ name: p.name, flowType: p.flowType, type: p.type, amount: String(p.amount), day: String(p.day), startMonth: p.startMonth, freq: p.freq, customEveryN: p.customEveryN || "1", customUnit: p.customUnit || "months", tenure: p.tenure ? String(p.tenure) : "", notes: p.notes || "", accountId: p.accountId || "" });
  }

  function saveEdit() {
    if (!editForm.name.trim() || !editForm.amount || !editForm.day) return;
    update(p => ({ scheduledPayments: (p.scheduledPayments || []).map(x => x.id === editingPayment
      ? { ...x, ...editForm, amount: parseFloat(editForm.amount), day: parseInt(editForm.day), tenure: editForm.tenure ? parseInt(editForm.tenure) : null }
      : x
    )}));
    setEditingPayment(null);
    setEditForm(null);
  }

  function addPayment() {
    if (!form.name.trim() || !form.amount || !form.day) return;
    update(p => ({ scheduledPayments: [...(p.scheduledPayments || []), { id: Date.now(), ...form, amount: parseFloat(form.amount), day: parseInt(form.day), tenure: form.tenure ? parseInt(form.tenure) : null, paid: [] }] }));
    setForm(p => ({ ...p, name: "", amount: "", day: "", notes: "", tenure: "" }));
  }

  // ── Auto-pay: mark due/overdue payments as paid and log transactions ────────
  useEffect(() => {
    if (!payments.length) return;
    const now = new Date(); now.setHours(0, 0, 0, 0);

    const updates = [];
    payments.forEach(pay => {
      const key = getNextDueKey(pay);
      if (!key) return;
      const [ky, km] = key.split("-").map(Number);
      const dueDate = new Date(ky, km - 1, pay.day);
      // Auto-pay if due date is today or in the past AND not already paid
      if (dueDate <= now && !pay.paid.includes(key)) {
        updates.push({ pay, key });
      }
    });

    if (!updates.length) return;

    update(p => {
      let scheduledPayments = p.scheduledPayments || [];
      let transactions = p.transactions || [];

      updates.forEach(({ pay, key }) => {
        // Skip if already paid (check current state inside update)
        const current = scheduledPayments.find(x => x.id === pay.id);
        if (!current || current.paid.includes(key)) return;

        const [ky, km] = key.split("-").map(Number);
        const txDate = `${ky}-${String(km).padStart(2,"0")}-${String(pay.day).padStart(2,"0")}`;
        const txType = pay.flowType === "income" ? "income" : "expense";

        // Check no duplicate transaction already exists for this period
        const alreadyLogged = transactions.some(t => t.scheduledPaymentId === pay.id && t.scheduledPeriodKey === key);
        if (!alreadyLogged) {
          transactions = [...transactions, {
            id: Date.now() + Math.random(),
            type: txType,
            amount: pay.amount,
            category: pay.type || (txType === "income" ? "Income" : "EMI"),
            note: pay.name + (pay.notes ? ` — ${pay.notes}` : "") + " (auto)",
            date: txDate,
            bankId: pay.accountId || "",
            scheduledPaymentId: pay.id,
            scheduledPeriodKey: key,
          }];
        }

        scheduledPayments = scheduledPayments.map(x =>
          x.id === pay.id ? { ...x, paid: [...x.paid, key] } : x
        );
      });

      return { scheduledPayments, transactions };
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Run once on mount — catches any overdue/today payments immediately

  function deletePayment(id) {
    // Keep all past transactions including current month — only drop strictly future ones
    const now = new Date();
    const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextMonthKey = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, "0")}`;
    update(p => ({
      scheduledPayments: (p.scheduledPayments || []).filter(x => x.id !== id),
      // Only remove transactions from NEXT month onwards — keep all past + current month data
      transactions: (p.transactions || []).filter(t =>
        !(t.scheduledPaymentId === id && t.scheduledPeriodKey && t.scheduledPeriodKey >= nextMonthKey)
      ),
    }));
  }

  function togglePaid(id) {
    update(p => {
      const payments = (p.scheduledPayments || []);
      const pay = payments.find(x => x.id === id);
      if (!pay) return {};
      const key = getNextDueKey(pay);
      if (!key) return {};
      const wasAlreadyPaid = pay.paid.includes(key);

      // Build [year, month] from key "YYYY-MM"
      const [kyear, kmonth] = key.split("-").map(Number);
      // Transaction date = due day of that month
      const txDate = `${kyear}-${String(kmonth).padStart(2,"0")}-${String(pay.day).padStart(2,"0")}`;
      const txType = pay.flowType === "income" ? "income" : "expense";

      let transactions = p.transactions || [];
      if (wasAlreadyPaid) {
        // Remove the auto-transaction created for this scheduled payment + period
        transactions = transactions.filter(t => !(t.scheduledPaymentId === id && t.scheduledPeriodKey === key));
      } else {
        // Add a real transaction to Expenses / Income
        const newTx = {
          id: Date.now() + Math.random(),
          type: txType,
          amount: pay.amount,
          category: pay.type || (txType === "income" ? "Income" : "EMI"),
          note: pay.name + (pay.notes ? ` — ${pay.notes}` : ""),
          date: txDate,
          bankId: pay.accountId || "",
          scheduledPaymentId: id,
          scheduledPeriodKey: key,
        };
        transactions = [...transactions, newTx];
      }

      const paid = wasAlreadyPaid
        ? pay.paid.filter(k => k !== key)
        : [...pay.paid, key];

      return {
        scheduledPayments: payments.map(x => x.id === id ? { ...x, paid } : x),
        transactions,
      };
    });
  }

  function getNextDueKey(p) {
    const now = new Date();
    const [sy, sm] = p.startMonth.split("-").map(Number);
    if (p.freq === "once") return p.startMonth;
    if (p.freq === "annually") {
      let y = sy;
      while (new Date(y, sm - 1, p.day) < new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) y++;
      return `${y}-${String(sm).padStart(2, "0")}`;
    }
    if (p.freq === "quarterly") {
      let d = new Date(sy, sm - 1, p.day);
      while (d < new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) d.setMonth(d.getMonth() + 3);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
    // monthly — find first unpaid from start
    let d = new Date(sy, sm - 1, p.day), ct = 0;
    while (ct < 300) {
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (!p.paid.includes(k)) return k;
      d.setMonth(d.getMonth() + 1); ct++;
    }
    return null;
  }

  function getDueDate(p) {
    const key = getNextDueKey(p);
    if (!key) return null;
    const [y, m] = key.split("-").map(Number);
    return new Date(y, m - 1, p.day);
  }

  function daysDiff(d) {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const t = new Date(d); t.setHours(0, 0, 0, 0);
    return Math.round((t - now) / 86400000);
  }

  const now = new Date();
  let list = [...payments].sort((a, b) => { const da = getDueDate(a), db = getDueDate(b); if (!da) return 1; if (!db) return -1; return da - db; });

  const typeColors = { "EMI": "#4da6ff", "Credit Card": "#f5a623", "Utility": "#ff4757", "Subscription": "#1a6b3c", "Salary": "#1a6b3c", "Freelance": "#2d9e5f", "Rent Income": "#4da6ff", "Dividend": "#9b59b6", "Rent": "#9b59b6", "Insurance": "#888" };
  const typeBg = { "EMI": "#e8f0ff", "Credit Card": "#fff3e0", "Utility": "#fdf0f0", "Subscription": "#e8f5ee", "Salary": "#e8f5ee", "Freelance": "#e8f5ee", "Rent Income": "#e8f0ff", "Dividend": "#f3e8ff", "Rent": "#f3e8ff", "Insurance": "#f5f5f5" };

  // Timeline view — next 6 months
  const timelineMonths = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    timelineMonths.push({ year: d.getFullYear(), month: d.getMonth() });
  }

  return (
    <div style={{ marginTop: 16 }}>
      {/* Edit Payment Modal */}
      {editingPayment && editForm && (
        <>
          <div onClick={() => setEditingPayment(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.32)", zIndex: 200 }} />
          <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", background: "var(--color-background-primary)", borderRadius: 16, padding: "1.5rem", zIndex: 201, width: 360, maxWidth: "94vw", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 16 }}>Edit Scheduled Payment</div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Direction</label>
              <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: "0.5px solid var(--color-border-secondary)" }}>
                {[["expense","📤 Expense","#d44","#fdf0f0"],["income","📥 Income","#1a6b3c","#e8f5ee"]].map(([v,lbl,color,bg]) => (
                  <button key={v} onClick={() => setEditForm(p => ({ ...p, flowType: v }))}
                    style={{ flex: 1, padding: "6px 0", border: "none", cursor: "pointer", fontSize: 13, fontWeight: editForm.flowType === v ? 600 : 400, background: editForm.flowType === v ? bg : "transparent", color: editForm.flowType === v ? color : "var(--color-text-secondary)" }}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Category</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {(editForm.flowType === "income" ? (categories.income || []) : (categories.expense || [])).map(t => (
                  <button key={t} onClick={() => setEditForm(p => ({ ...p, type: t }))}
                    style={{ padding: "4px 10px", borderRadius: 6, border: "0.5px solid", borderColor: editForm.type === t ? "#1a6b3c" : "var(--color-border-secondary)", background: editForm.type === t ? "#e8f5ee" : "transparent", color: editForm.type === t ? "#1a6b3c" : "var(--color-text-secondary)", fontSize: 12, cursor: "pointer", fontWeight: editForm.type === t ? 600 : 400 }}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <LabelInput label="Name" placeholder="e.g. HDFC Home Loan" value={editForm.name} onChange={v => setEditForm(p => ({ ...p, name: v }))} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <LabelInput label="Amount (₹)" placeholder="e.g. 12500" value={editForm.amount} onChange={v => setEditForm(p => ({ ...p, amount: v }))} />
              <LabelInput label="Day of month (1–31)" placeholder="e.g. 5" value={editForm.day} onChange={v => setEditForm(p => ({ ...p, day: v }))} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Start Month</label>
              <input type="month" value={editForm.startMonth} onChange={e => setEditForm(p => ({ ...p, startMonth: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Repeat</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {["monthly","quarterly","annually","once","custom"].map(f => (
                  <button key={f} onClick={() => setEditForm(p => ({ ...p, freq: f }))}
                    style={{ padding: "4px 10px", borderRadius: 6, border: "0.5px solid", borderColor: editForm.freq === f ? "#1a6b3c" : "var(--color-border-secondary)", background: editForm.freq === f ? "#e8f5ee" : "transparent", color: editForm.freq === f ? "#1a6b3c" : "var(--color-text-secondary)", fontSize: 12, cursor: "pointer", fontWeight: editForm.freq === f ? 600 : 400, textTransform: "capitalize" }}>
                    {f === "once" ? "One-time" : f}
                  </button>
                ))}
              </div>
              {editForm.freq === "custom" && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>Every</span>
                  <input type="number" min="1" value={editForm.customEveryN} onChange={e => setEditForm(p => ({ ...p, customEveryN: e.target.value }))} style={{ width: 60, textAlign: "center" }} />
                  <select value={editForm.customUnit} onChange={e => setEditForm(p => ({ ...p, customUnit: e.target.value }))} style={{ flex: 1 }}>
                    <option value="days">Day(s)</option><option value="weeks">Week(s)</option>
                    <option value="months">Month(s)</option><option value="years">Year(s)</option>
                  </select>
                </div>
              )}
            </div>
            <LabelInput label="Tenure (months, optional)" placeholder="e.g. 24 — blank = ongoing" value={editForm.tenure} onChange={v => setEditForm(p => ({ ...p, tenure: v }))} />
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Account (optional)</label>
              <select value={editForm.accountId} onChange={e => setEditForm(p => ({ ...p, accountId: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
                <option value="">— None —</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.type})</option>)}
              </select>
            </div>
            <LabelInput label="Notes (optional)" placeholder="e.g. Auto-debit from SBI" value={editForm.notes} onChange={v => setEditForm(p => ({ ...p, notes: v }))} />
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button onClick={() => setEditingPayment(null)} style={{ flex: 1, background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "8px 0", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)" }}>Cancel</button>
              <button onClick={saveEdit} style={{ flex: 2, background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 0", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Save Changes</button>
            </div>
          </div>
        </>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16, alignItems: "start" }}>
        {/* Add form */}
        <Card title="Add Scheduled Payment">
          {/* Income / Expense toggle */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Direction</label>
            <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: "0.5px solid var(--color-border-secondary)" }}>
              {[["expense", "📤 Expense", "#d44", "#fdf0f0"], ["income", "📥 Income", "#1a6b3c", "#e8f5ee"]].map(([v, lbl, color, bg]) => (
                <button key={v} onClick={() => setForm(p => ({ ...p, flowType: v }))}
                  style={{ flex: 1, padding: "6px 0", border: "none", cursor: "pointer", fontSize: 13, fontWeight: form.flowType === v ? 600 : 400, background: form.flowType === v ? bg : "transparent", color: form.flowType === v ? color : "var(--color-text-secondary)", transition: "all 0.15s" }}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Category</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(form.flowType === "income" ? (categories.income || []) : (categories.expense || [])).map(t => (
                <button key={t} onClick={() => setForm(p => ({ ...p, type: t }))}
                  style={{ padding: "4px 10px", borderRadius: 6, border: "0.5px solid", borderColor: form.type === t ? "#1a6b3c" : "var(--color-border-secondary)", background: form.type === t ? "#e8f5ee" : "transparent", color: form.type === t ? "#1a6b3c" : "var(--color-text-secondary)", fontSize: 12, cursor: "pointer", fontWeight: form.type === t ? 600 : 400 }}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <LabelInput label="Name" placeholder="e.g. HDFC Home Loan, Netflix, Rent" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <LabelInput label="Amount (₹)" placeholder="e.g. 12500" value={form.amount} onChange={v => setForm(p => ({ ...p, amount: v }))} />
            <LabelInput label="Day of month (1–31)" placeholder="e.g. 5" value={form.day} onChange={v => setForm(p => ({ ...p, day: v }))} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Start Month</label>
            <input type="month" value={form.startMonth} onChange={e => setForm(p => ({ ...p, startMonth: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
          {/* Fully customizable repeat */}
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Repeat</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {["monthly", "quarterly", "annually", "once", "custom"].map(f => (
                <button key={f} onClick={() => setForm(p => ({ ...p, freq: f }))}
                  style={{ padding: "4px 10px", borderRadius: 6, border: "0.5px solid", borderColor: form.freq === f ? "#1a6b3c" : "var(--color-border-secondary)", background: form.freq === f ? "#e8f5ee" : "transparent", color: form.freq === f ? "#1a6b3c" : "var(--color-text-secondary)", fontSize: 12, cursor: "pointer", fontWeight: form.freq === f ? 600 : 400, textTransform: "capitalize" }}>
                  {f === "once" ? "One-time" : f}
                </button>
              ))}
            </div>
            {form.freq === "custom" && (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>Every</span>
                <input type="number" min="1" value={form.customEveryN} onChange={e => setForm(p => ({ ...p, customEveryN: e.target.value }))} style={{ width: 60, boxSizing: "border-box", textAlign: "center" }} />
                <select value={form.customUnit} onChange={e => setForm(p => ({ ...p, customUnit: e.target.value }))} style={{ flex: 1, boxSizing: "border-box" }}>
                  <option value="days">Day(s)</option>
                  <option value="weeks">Week(s)</option>
                  <option value="months">Month(s)</option>
                  <option value="years">Year(s)</option>
                </select>
              </div>
            )}
          </div>
          {(form.type === "EMI" || form.flowType === "expense") && (
            <LabelInput label="Tenure (months, optional)" placeholder="e.g. 24 — leave blank for ongoing" value={form.tenure} onChange={v => setForm(p => ({ ...p, tenure: v }))} />
          )}
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Account (optional)</label>
            <select value={form.accountId} onChange={e => setForm(p => ({ ...p, accountId: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
              <option value="">— None —</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.type})</option>)}
            </select>
          </div>
          <LabelInput label="Notes (optional)" placeholder="e.g. Auto-debit from SBI" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} />
          <GreenBtn onClick={addPayment} label="+ Add" />
        </Card>

        {/* List / Timeline */}
        <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", overflow: "hidden" }}>
          <div style={{ padding: "0.8rem 1.1rem", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontWeight: 500, fontSize: 15 }}>Payments</span>
            <div style={{ display: "flex", border: "0.5px solid var(--color-border-secondary)", borderRadius: 7, overflow: "hidden" }}>
              {["list", "timeline"].map(v => (
                <button key={v} onClick={() => setView(v)} style={{ padding: "4px 12px", background: view === v ? "#1a6b3c" : "transparent", color: view === v ? "#fff" : "var(--color-text-secondary)", border: "none", cursor: "pointer", fontSize: 12, fontWeight: view === v ? 500 : 400 }}>
                  {v === "list" ? "List" : "Timeline"}
                </button>
              ))}
            </div>
          </div>

          {view === "list" && (
            <div style={{ padding: "0.8rem 1.1rem", display: "flex", flexDirection: "column", gap: 8, minHeight: 180 }}>
              {list.length === 0 ? <EmptyState msg="No scheduled payments yet. Add one on the left." /> : list.map(p => {
                const d = getDueDate(p);
                const key = getNextDueKey(p);
                const isPaid = key && p.paid.includes(key);
                const days = d ? daysDiff(d) : null;
                // Check if this was auto-paid (transaction note ends with "(auto)")
                const autoPaidTx = isPaid && (data.transactions || []).find(t => t.scheduledPaymentId === p.id && t.scheduledPeriodKey === key && t.note?.endsWith("(auto)"));
                let badge = "", badgeColor = "var(--color-text-secondary)", badgeBg = "var(--color-background-secondary)";
                if (!isPaid && d && days !== null) {
                  if (days < 0) { badge = `${Math.abs(days)}d overdue`; badgeColor = "#d44"; badgeBg = "#fdf0f0"; }
                  else if (days === 0) { badge = "Due today"; badgeColor = "#f0a020"; badgeBg = "#fff8e0"; }
                  else if (days <= 7) { badge = `${days}d left`; badgeColor = "#f0a020"; badgeBg = "#fff8e0"; }
                  else { badge = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }); }
                }
                const acct = accounts.find(a => String(a.id) === String(p.accountId));
                return (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, background: isPaid ? "var(--color-background-tertiary)" : "var(--color-background-secondary)", borderRadius: 10, padding: "10px 14px", border: `0.5px solid ${isPaid ? "#bbf7d0" : "var(--color-border-tertiary)"}`, opacity: isPaid ? 0.75 : 1, transition: "opacity 0.2s" }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: isPaid ? "#1a6b3c" : (typeColors[p.type] || "#1a6b3c"), flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 1 }}>
                        {p.flowType === "income" ? "📥" : "📤"} {p.type} · {p.freq === "custom" ? `every ${p.customEveryN || 1} ${p.customUnit || "months"}` : p.freq}{p.tenure ? ` · ${p.tenure}mo` : ""}
                        {acct ? ` · ${acct.name}` : ""}
                        {p.notes ? ` · ${p.notes}` : ""}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{fmtCur(p.amount)}</div>
                      <span style={{ fontSize: 10, background: isPaid ? "#e8f5ee" : badgeBg, color: isPaid ? "#1a6b3c" : badgeColor, borderRadius: 4, padding: "2px 7px", display: "inline-block", marginTop: 2, fontWeight: 500 }}>
                        {isPaid ? (autoPaidTx ? "⚡ Auto-paid" : "✓ Paid") : badge}
                      </span>
                      {isPaid && <div style={{ fontSize: 10, color: "#1a6b3c", marginTop: 2, opacity: 0.8 }}>↳ logged in {p.flowType === "income" ? "Income" : "Expenses"}</div>}
                    </div>
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      <button onClick={() => togglePaid(p.id)} title={isPaid ? "Undo — removes auto-logged transaction" : "Mark Paid manually"} style={{ width: 28, height: 28, borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: 13, color: isPaid ? "#1a6b3c" : "var(--color-text-secondary)", display: "flex", alignItems: "center", justifyContent: "center" }}>{isPaid ? "↩" : "✓"}</button>
                      <button onClick={() => startEdit(p)} title="Edit payment" style={{ width: 28, height: 28, borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: 13, color: "#4da6ff", display: "flex", alignItems: "center", justifyContent: "center" }}>✏️</button>
                      <button onClick={() => deletePayment(p.id)} title="Delete" style={{ width: 28, height: 28, borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: 13, color: "#d44", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {view === "timeline" && (
            <div style={{ padding: "0.8rem 1.1rem" }}>
              {timelineMonths.map(({ year, month }) => {
                const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
                const monthLabel = new Date(year, month, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
                const inMonth = payments.filter(p => {
                  const [sy, sm] = p.startMonth.split("-").map(Number);
                  const curr = new Date(year, month, 1);
                  if (curr < new Date(sy, sm - 1, 1)) return false;
                  if (p.freq === "once") return sy === year && (sm - 1) === month;
                  if (p.freq === "annually") return (sm - 1) === month;
                  if (p.freq === "quarterly") { const diff = (year * 12 + month) - (sy * 12 + (sm - 1)); return diff >= 0 && diff % 3 === 0; }
                  if (p.tenure) { const diff = (year * 12 + month) - (sy * 12 + (sm - 1)); if (diff >= p.tenure) return false; }
                  return true;
                });
                if (inMonth.length === 0) return null;
                const total = inMonth.reduce((s, p) => s + p.amount, 0);
                return (
                  <div key={monthKey} style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 8, paddingBottom: 6, borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between" }}>
                      <span>{monthLabel}</span>
                      <span style={{ color: "#1a6b3c" }}>{fmtCur(total)}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {inMonth.map(p => {
                        const isPaid = p.paid.includes(monthKey);
                        const dDate = new Date(year, month, p.day);
                        const days = daysDiff(dDate);
                        let badge = dDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
                        let badgeColor = "var(--color-text-secondary)";
                        if (!isPaid) { if (days < 0) { badge = `${Math.abs(days)}d overdue`; badgeColor = "#d44"; } else if (days <= 7) { badge = days === 0 ? "Today" : `${days}d`; badgeColor = "#f0a020"; } }
                        return (
                          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, background: isPaid ? "var(--color-background-tertiary)" : "var(--color-background-secondary)", borderRadius: 8, padding: "8px 12px", opacity: isPaid ? 0.55 : 1 }}>
                            <div style={{ width: 7, height: 7, borderRadius: "50%", background: typeColors[p.type] || "#1a6b3c", flexShrink: 0 }} />
                            <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{p.name}</div>
                            <span style={{ fontSize: 12, fontWeight: 600 }}>{fmtCur(p.amount)}</span>
                            <span style={{ fontSize: 10, color: isPaid ? "#1a6b3c" : badgeColor, fontWeight: 500 }}>{isPaid ? "✓ Paid" : badge}</span>
                            <button onClick={() => togglePaid(p.id)} style={{ width: 24, height: 24, borderRadius: 5, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: 11, color: isPaid ? "#1a6b3c" : "var(--color-text-secondary)", display: "flex", alignItems: "center", justifyContent: "center" }}>{isPaid ? "↩" : "✓"}</button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Liabilities Tab Content ─────────────────────────────────────────
function LiabilitiesTab({ data, update }) {
  const accounts = data.banks || [];
  const liabilities = data.emis || [];
  
  const [liabilityForm, setLiabilityForm] = useState({
    name: "",
    type: "Credit Card",
    amount: "",
    totalMonths: "",
    paymentDay: "",
    accountId: "",
    startDate: today(),
    notes: ""
  });
  
  const [editLiability, setEditLiability] = useState(null);

  // Check and auto-create expenses based on payment dates
  useEffect(() => {
    const checkAndCreatePayments = () => {
      const now = new Date();
      const currentDay = now.getDate();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();
      
      liabilities.forEach(liability => {
        if (!liability.active || liability.paidMonths >= liability.totalMonths) return;
        
        // Check if payment is due today
        if (liability.paymentDay === currentDay) {
          const startDate = new Date(liability.startDate);
          const monthsSinceStart = (currentYear - startDate.getFullYear()) * 12 + (currentMonth - startDate.getMonth());
          
          // Check if this month's payment already exists
          const thisMonthPaymentExists = data.transactions.some(t => 
            t.emiId === liability.id && 
            new Date(t.date).getMonth() === currentMonth &&
            new Date(t.date).getFullYear() === currentYear
          );
          
          // Auto-create payment if not exists and within liability period
          if (!thisMonthPaymentExists && monthsSinceStart < liability.totalMonths && monthsSinceStart >= 0) {
            const newTransaction = {
              id: Date.now() + Math.random(),
              type: "expense",
              amount: liability.amount,
              category: "EMI",
              note: `${liability.name} - Auto payment (Month ${monthsSinceStart + 1}/${liability.totalMonths})`,
              date: today(),
              bankId: liability.accountId,
              emiId: liability.id
            };
            
            update(p => ({
              emis: p.emis.map(e => e.id === liability.id ? { ...e, paidMonths: monthsSinceStart + 1 } : e),
              transactions: [...p.transactions, newTransaction]
            }));
          }
        }
      });
    };
    
    // Check on mount and set interval to check daily
    checkAndCreatePayments();
    const interval = setInterval(checkAndCreatePayments, 1000 * 60 * 60); // Check every hour
    
    return () => clearInterval(interval);
  }, [liabilities, data.transactions, update]);

  function addLiability() {
    if (!liabilityForm.name || !liabilityForm.amount || !liabilityForm.totalMonths || !liabilityForm.paymentDay || !liabilityForm.accountId) return;
    
    const newLiability = {
      id: Date.now(),
      name: liabilityForm.name,
      type: liabilityForm.type,
      amount: parseFloat(liabilityForm.amount),
      totalMonths: parseInt(liabilityForm.totalMonths),
      paidMonths: 0,
      paymentDay: parseInt(liabilityForm.paymentDay),
      accountId: liabilityForm.accountId,
      startDate: liabilityForm.startDate,
      notes: liabilityForm.notes,
      active: true
    };
    
    update(p => ({ emis: [...(p.emis || []), newLiability] }));
    setLiabilityForm({ name: "", type: "Credit Card", amount: "", totalMonths: "", paymentDay: "", accountId: "", startDate: today(), notes: "" });
  }

  function saveEditLiability() {
    if (!editLiability) return;
    update(p => ({ 
      emis: p.emis.map(e => e.id === editLiability.id ? { 
        ...editLiability, 
        amount: parseFloat(editLiability.amount),
        totalMonths: parseInt(editLiability.totalMonths),
        paymentDay: parseInt(editLiability.paymentDay)
      } : e) 
    }));
    setEditLiability(null);
  }

  function deleteLiability(id) {
    // Delete the liability AND all related expense transactions completely from everywhere
    update(p => ({ 
      emis: p.emis.filter(e => e.id !== id),
      transactions: p.transactions.filter(t => t.emiId !== id) // Remove all auto-payments and manual payments linked to this liability
    }));
  }

  function toggleLiabilityActive(id) {
    update(p => ({ emis: p.emis.map(e => e.id === id ? { ...e, active: !e.active } : e) }));
  }

  function markPaymentMade(liability) {
    if (liability.paidMonths >= liability.totalMonths) return;
    
    // Create expense transaction
    const newTransaction = {
      id: Date.now(),
      type: "expense",
      amount: liability.amount,
      category: "EMI",
      note: `${liability.name} - Manual payment (Month ${liability.paidMonths + 1}/${liability.totalMonths})`,
      date: today(),
      bankId: liability.accountId,
      emiId: liability.id
    };
    
    // Update liability paid months and add transaction
    update(p => ({
      emis: p.emis.map(e => e.id === liability.id ? { ...e, paidMonths: e.paidMonths + 1 } : e),
      transactions: [...p.transactions, newTransaction]
    }));
  }

  const activeLiabilities = liabilities.filter(e => e.active && e.paidMonths < e.totalMonths);
  const completedLiabilities = liabilities.filter(e => !e.active || e.paidMonths >= e.totalMonths);

  // Summary computations for the liability strip
  const nowL = new Date();
  const liabDueThisMonth = activeLiabilities.reduce((s, l) => {
    const start = new Date(l.startDate);
    const monthsIn = (nowL.getFullYear() - start.getFullYear()) * 12 + (nowL.getMonth() - start.getMonth());
    if (monthsIn >= 0 && monthsIn < l.totalMonths) return s + l.amount;
    return s;
  }, 0);
  const liabOverdue = activeLiabilities.reduce((s, l) => {
    const start = new Date(l.startDate);
    const monthsIn = (nowL.getFullYear() - start.getFullYear()) * 12 + (nowL.getMonth() - start.getMonth());
    const dueDate = new Date(nowL.getFullYear(), nowL.getMonth(), l.paymentDay);
    if (monthsIn >= 0 && monthsIn < l.totalMonths && nowL > dueDate) return s + l.amount;
    return s;
  }, 0);
  const liabDue7 = activeLiabilities.reduce((s, l) => {
    const start = new Date(l.startDate);
    const monthsIn = (nowL.getFullYear() - start.getFullYear()) * 12 + (nowL.getMonth() - start.getMonth());
    if (monthsIn < 0 || monthsIn >= l.totalMonths) return s;
    const dueDate = new Date(nowL.getFullYear(), nowL.getMonth(), l.paymentDay);
    const diff = Math.round((dueDate - nowL) / 86400000);
    if (diff >= 0 && diff <= 7) return s + l.amount;
    return s;
  }, 0);
  const liabAnnual = activeLiabilities.reduce((s, l) => {
    const remaining = Math.max(0, l.totalMonths - (l.paidMonths || 0));
    return s + l.amount * remaining;
  }, 0);

  return (
    <div style={{ marginTop: 16 }}>
      {/* Summary Strip — matching Scheduled Payments look */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
        {[
          { label: "Due This Month", val: fmtCur(liabDueThisMonth), color: "#4da6ff" },
          { label: "Overdue", val: fmtCur(liabOverdue), color: "#d44" },
          { label: "Due in 7 Days", val: fmtCur(liabDue7), color: "#f0a020" },
          { label: "Annual Total", val: fmtCur(liabAnnual), color: "#1a6b3c" },
        ].map(c => (
          <div key={c.label} style={{ background: "var(--color-background-secondary)", borderRadius: 10, padding: "0.8rem 1rem", border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: c.color }}>{c.val}</div>
          </div>
        ))}
      </div>
      {/* Edit Liability Modal */}
      {editLiability && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 16, padding: "1.5rem", width: "min(480px, 90vw)", border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 16 }}>✏️ Edit Liability</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div style={{ gridColumn: "span 2" }}>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Name</label>
                <input value={editLiability.name} onChange={e => setEditLiability(p => ({ ...p, name: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Type</label>
                <select value={editLiability.type} onChange={e => setEditLiability(p => ({ ...p, type: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
                  <option>Credit Card</option>
                  <option>Personal Loan</option>
                  <option>Car Loan</option>
                  <option>Home Loan</option>
                  <option>Other</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Amount (₹)</label>
                <input type="number" value={editLiability.amount} onChange={e => setEditLiability(p => ({ ...p, amount: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Total Months</label>
                <input type="number" value={editLiability.totalMonths} onChange={e => setEditLiability(p => ({ ...p, totalMonths: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Payment Day</label>
                <input type="number" min="1" max="31" value={editLiability.paymentDay} onChange={e => setEditLiability(p => ({ ...p, paymentDay: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Notes</label>
                <input value={editLiability.notes || ""} onChange={e => setEditLiability(p => ({ ...p, notes: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setEditLiability(null)} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "8px 16px", cursor: "pointer", color: "var(--color-text-secondary)" }}>Cancel</button>
              <button onClick={saveEditLiability} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontWeight: 600 }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Add Liability Form */}
      <Card title="➕ Add Liability">
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Name</label>
            <input placeholder="e.g. HDFC Credit Card, Personal Loan" value={liabilityForm.name} onChange={e => setLiabilityForm(p => ({ ...p, name: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Type</label>
            <select value={liabilityForm.type} onChange={e => setLiabilityForm(p => ({ ...p, type: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
              <option>Credit Card</option>
              <option>Personal Loan</option>
              <option>Car Loan</option>
              <option>Home Loan</option>
              <option>Other</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Monthly Amount (₹)</label>
            <input type="number" placeholder="e.g. 5000" value={liabilityForm.amount} onChange={e => setLiabilityForm(p => ({ ...p, amount: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 2fr", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Total Months</label>
            <input type="number" placeholder="e.g. 12" value={liabilityForm.totalMonths} onChange={e => setLiabilityForm(p => ({ ...p, totalMonths: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Payment Day</label>
            <input type="number" min="1" max="31" placeholder="e.g. 5" value={liabilityForm.paymentDay} onChange={e => setLiabilityForm(p => ({ ...p, paymentDay: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Start Date</label>
            <input type="date" value={liabilityForm.startDate} onChange={e => setLiabilityForm(p => ({ ...p, startDate: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Payment Account</label>
            <select value={liabilityForm.accountId} onChange={e => setLiabilityForm(p => ({ ...p, accountId: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
              <option value="">Select account</option>
              {accounts.filter(a => a.type === "Bank").length > 0 && (
                <optgroup label="🏦 Bank Accounts">
                  {accounts.filter(a => a.type === "Bank").map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </optgroup>
              )}
              {accounts.filter(a => a.type === "Credit Card").length > 0 && (
                <optgroup label="💳 Credit Cards">
                  {accounts.filter(a => a.type === "Credit Card").map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </optgroup>
              )}
              {accounts.filter(a => a.type === "Cash").length > 0 && (
                <optgroup label="💵 Cash">
                  {accounts.filter(a => a.type === "Cash").map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Notes (optional)</label>
          <input placeholder="e.g. Interest rate 12%, Principal amount 60000" value={liabilityForm.notes} onChange={e => setLiabilityForm(p => ({ ...p, notes: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
        </div>
        <button onClick={addLiability} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>+ Add Liability</button>
      </Card>

      {/* Info Banner */}
      <div style={{ marginTop: 16, background: "#e8f5ee", border: "0.5px solid #1a6b3c", borderRadius: 10, padding: "0.8rem 1rem", fontSize: 13, color: "#1a6b3c" }}>
        ℹ️ <strong>Auto-Payment Feature:</strong> On the payment day each month, expenses will be automatically created and linked to the selected account. You can also manually mark payments using the button below.
      </div>

      {/* Active Liabilities */}
      {activeLiabilities.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>📊 Active Liabilities</div>
          <div style={{ display: "grid", gap: 12 }}>
            {activeLiabilities.map(liability => {
              const account = accounts.find(a => a.id === liability.accountId);
              const progress = (liability.paidMonths / liability.totalMonths) * 100;
              const remaining = liability.totalMonths - liability.paidMonths;
              const totalPaid = liability.paidMonths * liability.amount;
              const totalAmount = liability.totalMonths * liability.amount;
              const relatedExpenses = data.transactions.filter(t => t.emiId === liability.id);
              
              return (
                <div key={liability.id} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "1rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{liability.name}</div>
                      <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                        {liability.type} · {fmtCur(liability.amount)}/month · Due on {liability.paymentDay}{liability.paymentDay === 1 ? 'st' : liability.paymentDay === 2 ? 'nd' : liability.paymentDay === 3 ? 'rd' : 'th'}
                      </div>
                      {account && (
                        <div style={{ marginTop: 4, fontSize: 11 }}>
                          <span style={{ background: account.type === "Credit Card" ? "#fff3e0" : "#e8f5ee", color: account.type === "Credit Card" ? "#e65100" : "#1a6b3c", borderRadius: 4, padding: "2px 6px", fontWeight: 500 }}>
                            {account.name}
                          </span>
                          {relatedExpenses.length > 0 && (
                            <span style={{ marginLeft: 8, color: "var(--color-text-secondary)" }}>
                              · {relatedExpenses.length} auto-payments logged
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <ThreeDotMenu 
                      onEdit={() => setEditLiability({ ...liability })}
                      onDelete={() => {
                        if (confirm(`⚠️ DELETE "${liability.name}"?\n\nThis will permanently remove:\n✗ The liability entry\n✗ All ${relatedExpenses.length} related expense transactions\n\nThis action cannot be undone.`)) {
                          deleteLiability(liability.id);
                        }
                      }}
                    />
                  </div>
                  
                  {/* Progress bar */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12 }}>
                      <span style={{ color: "var(--color-text-secondary)" }}>Progress: {liability.paidMonths} / {liability.totalMonths} months</span>
                      <span style={{ fontWeight: 500, color: remaining === 0 ? "#1a6b3c" : "var(--color-text-primary)" }}>
                        {remaining} {remaining === 1 ? 'month' : 'months'} left
                      </span>
                    </div>
                    <div style={{ background: "var(--color-background-secondary)", borderRadius: 4, height: 8, overflow: "hidden" }}>
                      <div style={{ width: progress + "%", height: "100%", background: progress === 100 ? "#1a6b3c" : "#3b82f6", borderRadius: 4, transition: "width 0.5s" }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 11, color: "var(--color-text-secondary)" }}>
                      <span>Paid: {fmtCur(totalPaid)}</span>
                      <span>Total: {fmtCur(totalAmount)}</span>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button 
                      onClick={() => markPaymentMade(liability)}
                      disabled={liability.paidMonths >= liability.totalMonths}
                      style={{ 
                        flex: 1, 
                        background: liability.paidMonths >= liability.totalMonths ? "var(--color-background-secondary)" : "#1a6b3c", 
                        color: liability.paidMonths >= liability.totalMonths ? "var(--color-text-secondary)" : "#fff", 
                        border: "none", 
                        borderRadius: 8, 
                        padding: "7px", 
                        cursor: liability.paidMonths >= liability.totalMonths ? "not-allowed" : "pointer", 
                        fontSize: 13, 
                        fontWeight: 500 
                      }}
                    >
                      {liability.paidMonths >= liability.totalMonths ? "✓ Completed" : "💳 Mark Payment Made"}
                    </button>
                    <button 
                      onClick={() => toggleLiabilityActive(liability.id)}
                      style={{ 
                        background: "var(--color-background-secondary)", 
                        border: "0.5px solid var(--color-border-secondary)", 
                        borderRadius: 8, 
                        padding: "7px 12px", 
                        cursor: "pointer", 
                        fontSize: 13, 
                        color: "var(--color-text-secondary)" 
                      }}
                    >
                      Pause
                    </button>
                  </div>
                  
                  {liability.notes && (
                    <div style={{ marginTop: 10, padding: "8px", background: "var(--color-background-secondary)", borderRadius: 6, fontSize: 12, color: "var(--color-text-secondary)" }}>
                      📝 {liability.notes}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Completed/Paused Liabilities */}
      {completedLiabilities.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {completedLiabilities.filter(e => e.paidMonths >= e.totalMonths).length > 0 ? "✓ Completed Liabilities" : "⏸ Paused Liabilities"}
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {completedLiabilities.map(liability => {
              const isCompleted = liability.paidMonths >= liability.totalMonths;
              const relatedExpenses = data.transactions.filter(t => t.emiId === liability.id);
              
              return (
                <div key={liability.id} style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "0.8rem", opacity: 0.7 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>
                        {isCompleted && "✓ "}{liability.name}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                        {liability.paidMonths} / {liability.totalMonths} months · {fmtCur(liability.amount * liability.paidMonths)} paid
                        {relatedExpenses.length > 0 && ` · ${relatedExpenses.length} logged payments`}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {!isCompleted && (
                        <button 
                          onClick={() => toggleLiabilityActive(liability.id)}
                          style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 500 }}
                        >
                          Resume
                        </button>
                      )}
                      <button 
                        onClick={() => {
                          if (confirm(`⚠️ DELETE "${liability.name}"?\n\nThis will permanently remove:\n✗ The liability entry\n✗ All ${relatedExpenses.length} related expense transactions\n\nThis action cannot be undone.`)) {
                            deleteLiability(liability.id);
                          }
                        }}
                        style={{ background: "none", border: "0.5px solid #d44", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 12, color: "#d44" }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {liabilities.length === 0 && (
        <div style={{ marginTop: 16 }}>
          <EmptyState msg="No liabilities added yet. Add your first liability above to start tracking auto-payments." />
        </div>
      )}
    </div>
  );
}

// ─── AddSavingsInline — stable component so input focus is never lost ────────
function AddSavingsInline({ item, cardAccent, accounts, addSavings }) {
  const [addAmt, setAddAmt] = useState("");
  const [showAddSave, setShowAddSave] = useState(false);
  const [saveTxType, setSaveTxType] = useState("income");
  const [saveBankId, setSaveBankId] = useState("");

  function handleAddSavings() {
    if (!addAmt || parseFloat(addAmt) <= 0) return;
    addSavings(item.id, addAmt, saveTxType, saveBankId, item.name);
    setAddAmt(""); setShowAddSave(false); setSaveBankId("");
  }

  if (!showAddSave) {
    return (
      <button onClick={() => setShowAddSave(true)} style={{ fontSize: 12, color: cardAccent, background: cardAccent + "14", border: `0.5px solid ${cardAccent}44`, borderRadius: 7, padding: "4px 12px", cursor: "pointer", fontWeight: 500 }}>
        + Add Savings
      </button>
    );
  }

  return (
    <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, padding: "10px 12px", marginTop: 4 }}>
      <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginBottom: 4 }}>Log this saving as:</div>
      <div style={{ display: "flex", borderRadius: 7, overflow: "hidden", border: "0.5px solid var(--color-border-secondary)", marginBottom: 8 }}>
        {[["income","📥 Income","#1a6b3c","#e8f5ee"],["expense","📤 Expense","#d44","#fdf0f0"],["savings","💰 Savings","#7c3aed","#f3e8ff"]].map(([v, lbl, color, bg]) => (
          <button key={v} onClick={() => setSaveTxType(v)}
            style={{ flex: 1, padding: "5px 0", border: "none", cursor: "pointer", fontSize: 11, fontWeight: saveTxType === v ? 600 : 400, background: saveTxType === v ? bg : "transparent", color: saveTxType === v ? color : "var(--color-text-secondary)", transition: "all 0.15s" }}>
            {lbl}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <input
          type="text"
          inputMode="decimal"
          placeholder="Amount (₹)"
          value={addAmt}
          onChange={e => { const v = e.target.value; if (v === "" || /^\d*\.?\d*$/.test(v)) setAddAmt(v); }}
          style={{ flex: 1, fontSize: 12, padding: "5px 8px", boxSizing: "border-box" }}
          autoFocus
        />
      </div>
      {accounts.length > 0 && (
        <select value={saveBankId} onChange={e => setSaveBankId(e.target.value)} style={{ width: "100%", fontSize: 12, marginBottom: 8, boxSizing: "border-box" }}>
          <option value="">— No account —</option>
          {accounts.filter(a => a.type === "Bank").length > 0 && (
            <optgroup label="🏦 Bank Accounts">
              {accounts.filter(a => a.type === "Bank").map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </optgroup>
          )}
          {accounts.filter(a => a.type === "Credit Card").length > 0 && (
            <optgroup label="💳 Credit Cards">
              {accounts.filter(a => a.type === "Credit Card").map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </optgroup>
          )}
          {accounts.filter(a => a.type === "Cash").length > 0 && (
            <optgroup label="💵 Cash">
              {accounts.filter(a => a.type === "Cash").map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </optgroup>
          )}
        </select>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={handleAddSavings} style={{ flex: 1, background: cardAccent, color: "#fff", border: "none", borderRadius: 7, padding: "5px 0", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Log Savings</button>
        <button onClick={() => { setShowAddSave(false); setAddAmt(""); setSaveBankId(""); }} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 7, padding: "5px 10px", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}>✕</button>
      </div>
    </div>
  );
}

// ─── Goals Page ───────────────────────────────────────────────────────────────
function GoalsPage({ data, update }) {
  const items = data.needsWants || [];
  const [activeTab, setActiveTab] = useState("needs");
  const [form, setForm] = useState({ name: "", goalType: "money", targetAmount: "", savedAmount: "", notes: "", priority: "medium", dueDate: "", urls: [""] });
  const [editItem, setEditItem] = useState(null);
  const [showAdd, setShowAdd] = useState(false);

  const PRIORITIES = [["high","🔴 High"],["medium","🟡 Medium"],["low","🟢 Low"]];

  const needs = items.filter(i => i.kind === "need");
  const wants = items.filter(i => i.kind === "want");
  const displayed = activeTab === "needs" ? needs : wants;

  function addItem() {
    if (!form.name.trim()) return;
    if (form.goalType === "money" && !form.targetAmount) return;
    update(p => ({
      needsWants: [...(p.needsWants || []), {
        id: Date.now(),
        kind: activeTab === "needs" ? "need" : "want",
        goalType: form.goalType || "money",
        name: form.name.trim(),
        targetAmount: parseFloat(form.targetAmount) || 0,
        savedAmount: parseFloat(form.savedAmount) || 0,
        notes: form.notes,
        priority: form.priority,
        dueDate: form.dueDate || "",
        urls: (form.urls || []).filter(u => u.trim()),
        createdAt: today(),
        completed: false,
      }]
    }));
    setForm({ name: "", goalType: "money", targetAmount: "", savedAmount: "", notes: "", priority: "medium", dueDate: "", urls: [""] });
    setShowAdd(false);
  }

  function saveEdit() {
    if (!editItem) return;
    update(p => ({
      needsWants: (p.needsWants || []).map(x => x.id === editItem.id ? {
        ...x,
        name: editItem.name,
        targetAmount: parseFloat(editItem.targetAmount),
        savedAmount: parseFloat(editItem.savedAmount) || 0,
        notes: editItem.notes,
        priority: editItem.priority,
        urls: (editItem.urls || (editItem.url ? [editItem.url] : [])).filter(u => u.trim()),
      } : x)
    }));
    setEditItem(null);
  }

  function deleteItem(id) {
    update(p => ({ needsWants: (p.needsWants || []).filter(x => x.id !== id) }));
  }

  function toggleComplete(id) {
    update(p => ({ needsWants: (p.needsWants || []).map(x => x.id === id ? { ...x, completed: !x.completed } : x) }));
  }

  function addSavings(id, amount, txType, bankId, goalName) {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    const actualType = txType === "savings" ? "income" : txType;
    update(p => {
      const updatedNeeds = (p.needsWants || []).map(x =>
        x.id === id ? { ...x, savedAmount: Math.min(x.savedAmount + amt, x.targetAmount) } : x
      );
      const newTx = {
        id: Date.now() + Math.random(),
        type: actualType,
        amount: amt,
        category: "Savings",
        note: `Goal: ${goalName}`,
        date: today(),
        bankId: bankId || "",
      };
      return { needsWants: updatedNeeds, transactions: [...(p.transactions || []), newTx] };
    });
  }

  const totalNeedsTarget = needs.reduce((s, i) => s + i.targetAmount, 0);
  const totalNeedsSaved  = needs.reduce((s, i) => s + i.savedAmount, 0);
  const totalWantsTarget = wants.reduce((s, i) => s + i.targetAmount, 0);
  const totalWantsSaved  = wants.reduce((s, i) => s + i.savedAmount, 0);

  const accentColor = activeTab === "needs" ? "#4da6ff" : "#9b59b6";

  function renderFormFields(values, onChange) {
    return (
      <div>
        {/* Goal type toggle: Money vs Task */}
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Goal Type</label>
          <div style={{ display: "flex", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, overflow: "hidden" }}>
            {[["money","💰 Money","#1a6b3c","#e8f5ee"],["task","✅ Task","#4da6ff","#e8f0ff"]].map(([v, lbl, color, bg]) => (
              <button key={v} onClick={() => onChange({ ...values, goalType: v })}
                style={{ flex: 1, padding: "6px 0", border: "none", cursor: "pointer", fontSize: 12, fontWeight: values.goalType === v ? 600 : 400, background: values.goalType === v ? bg : "transparent", color: values.goalType === v ? color : "var(--color-text-secondary)", transition: "all 0.15s" }}>
                {lbl}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Name *</label>
          <input placeholder={values.goalType === "task" ? "e.g. Complete certification, Learn piano" : "e.g. Emergency Fund, New Laptop"} value={values.name} onChange={e => onChange({ ...values, name: e.target.value })} style={{ width: "100%", boxSizing: "border-box" }} />
        </div>
        {values.goalType === "money" ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Target Amount (₹) *</label>
              <input type="text" inputMode="decimal" placeholder="e.g. 50000" value={values.targetAmount} onChange={e => { const v = e.target.value; if (v === "" || /^\d*\.?\d*$/.test(v)) onChange({ ...values, targetAmount: v }); }} style={{ width: "100%", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Already Saved (₹)</label>
              <input type="text" inputMode="decimal" placeholder="0" value={values.savedAmount} onChange={e => { const v = e.target.value; if (v === "" || /^\d*\.?\d*$/.test(v)) onChange({ ...values, savedAmount: v }); }} style={{ width: "100%", boxSizing: "border-box" }} />
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Due Date (optional)</label>
            <input type="date" value={values.dueDate || ""} onChange={e => onChange({ ...values, dueDate: e.target.value })} style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
        )}
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Priority</label>
          <div style={{ display: "flex", gap: 6 }}>
            {PRIORITIES.map(([v, lbl]) => (
              <button key={v} onClick={() => onChange({ ...values, priority: v })}
                style={{ flex: 1, padding: "5px 0", borderRadius: 7, border: "0.5px solid", borderColor: values.priority === v ? "#1a6b3c" : "var(--color-border-secondary)", background: values.priority === v ? "#e8f5ee" : "transparent", color: values.priority === v ? "#1a6b3c" : "var(--color-text-secondary)", fontSize: 12, cursor: "pointer", fontWeight: values.priority === v ? 600 : 400 }}>
                {lbl}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Notes (optional)</label>
          <input placeholder="Why this goal matters…" value={values.notes} onChange={e => onChange({ ...values, notes: e.target.value })} style={{ width: "100%", boxSizing: "border-box" }} />
        </div>
        <div style={{ marginTop: 10 }}>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>🔗 Links (optional)</label>
          {(values.urls || [""]).map((url, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
              <input
                type="url"
                placeholder={`https://… (link ${i + 1})`}
                value={url}
                onChange={e => {
                  const updated = [...(values.urls || [""])];
                  updated[i] = e.target.value;
                  onChange({ ...values, urls: updated });
                }}
                style={{ flex: 1, boxSizing: "border-box", fontSize: 12 }}
              />
              {(values.urls || [""]).length > 1 && (
                <button type="button" onClick={() => {
                  const updated = (values.urls || [""]).filter((_, j) => j !== i);
                  onChange({ ...values, urls: updated });
                }} style={{ background: "none", border: "0.5px solid #d44", borderRadius: 6, padding: "4px 8px", cursor: "pointer", color: "#d44", fontSize: 12, flexShrink: 0 }}>✕</button>
              )}
            </div>
          ))}
          <button type="button" onClick={() => onChange({ ...values, urls: [...(values.urls || [""]), ""] })}
            style={{ fontSize: 12, color: "#1a6b3c", background: "#e8f5ee", border: "0.5px solid #1a6b3c44", borderRadius: 7, padding: "4px 12px", cursor: "pointer", fontWeight: 500 }}>
            + Add another link
          </button>
        </div>
      </div>
    );
  }

  function renderItemCard(item) {
    const pct = item.targetAmount > 0 ? Math.min((item.savedAmount / item.targetAmount) * 100, 100) : 0;
    const remaining = item.targetAmount - item.savedAmount;
    const cardAccent = item.kind === "need" ? "#4da6ff" : "#9b59b6";
    const accounts = data.banks || [];
    const isTask = item.goalType === "task";

    // For task goals: show due date and completion status
    const dueDateEl = isTask && item.dueDate ? (() => {
      const diff = Math.round((new Date(item.dueDate) - new Date()) / 86400000);
      const color = diff < 0 ? "#d44" : diff <= 3 ? "#f0a020" : "#1a6b3c";
      return <span style={{ fontSize: 11, color, fontWeight: 500 }}>📅 {new Date(item.dueDate).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"})} {diff < 0 ? "(overdue)" : diff === 0 ? "(today)" : `(${diff}d left)`}</span>;
    })() : null;

    return (
      <div style={{
        background: item.completed ? "var(--color-background-tertiary)" : "var(--color-background-primary)",
        borderRadius: 14, border: `0.5px solid ${item.completed ? "var(--color-border-tertiary)" : "var(--color-border-secondary)"}`,
        padding: "1rem 1.1rem", opacity: item.completed ? 0.7 : 1,
        borderTop: item.completed ? undefined : `3px solid ${cardAccent}`,
        display: "flex", flexDirection: "column", height: "100%",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>
                {item.completed && <span style={{ color: "#1a6b3c", marginRight: 4 }}>✓</span>}
                {item.name}
              </span>
              {isTask && <span style={{ fontSize: 10, background: "#e8f0ff", color: "#4da6ff", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>✅ Task</span>}
              <span style={{ fontSize: 10, background: item.priority === "high" ? "#fdf0f0" : item.priority === "medium" ? "#fffbe0" : "#e8f5ee", color: item.priority === "high" ? "#d44" : item.priority === "medium" ? "#b8860b" : "#1a6b3c", borderRadius: 4, padding: "1px 6px", fontWeight: 500 }}>
                {item.priority === "high" ? "🔴" : item.priority === "medium" ? "🟡" : "🟢"} {item.priority}
              </span>
            </div>
            {item.notes && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{item.notes}</div>}
            {(item.urls && item.urls.length > 0 ? item.urls : item.url ? [item.url] : []).map((u, i) => u ? (
              <a key={i} href={u} target="_blank" rel="noreferrer"
                style={{ fontSize: 11, color: "#4da6ff", marginTop: 2, display: "flex", alignItems: "center", gap: 3, overflow: "hidden", maxWidth: "100%" }}
                title={u}>
                <span style={{ flexShrink: 0 }}>🔗</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u}</span>
              </a>
            ) : null)}
            {dueDateEl && <div style={{ marginTop: 4 }}>{dueDateEl}</div>}
          </div>
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            <button onClick={() => toggleComplete(item.id)} title={item.completed ? "Mark incomplete" : "Mark complete"} style={{ width: 26, height: 26, borderRadius: 6, border: `0.5px solid ${item.completed ? "#1a6b3c" : "var(--color-border-secondary)"}`, background: item.completed ? "#e8f5ee" : "transparent", cursor: "pointer", fontSize: 12, color: item.completed ? "#1a6b3c" : "var(--color-text-secondary)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {item.completed ? "↩" : "✓"}
            </button>
            <ThreeDotMenu onEdit={() => setEditItem({ ...item, goalType: item.goalType || "money", urls: item.urls || (item.url ? [item.url] : [""]) })} onDelete={() => deleteItem(item.id)} />
          </div>
        </div>

        {/* Money goal progress */}
        {!isTask && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
              <span style={{ color: "var(--color-text-secondary)" }}>Saved: <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>{fmtCur(item.savedAmount)}</span></span>
              <span style={{ color: "var(--color-text-secondary)" }}>Target: <span style={{ fontWeight: 600, color: cardAccent }}>{fmtCur(item.targetAmount)}</span></span>
            </div>
            <div style={{ background: "var(--color-background-secondary)", borderRadius: 6, height: 7, overflow: "hidden" }}>
              <div style={{ width: pct + "%", height: "100%", background: pct >= 100 ? "#1a6b3c" : cardAccent, borderRadius: 6, transition: "width 0.5s ease" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 4, color: "var(--color-text-secondary)" }}>
              <span>{pct.toFixed(1)}% complete</span>
              {remaining > 0 ? <span>{fmtCur(remaining)} remaining</span> : <span style={{ color: "#1a6b3c", fontWeight: 500 }}>🎉 Goal reached!</span>}
            </div>
          </div>
        )}

        {/* Task goal completion indicator */}
        {isTask && !item.completed && (
          <div style={{ marginTop: "auto", paddingTop: 8 }}>
            <button onClick={() => toggleComplete(item.id)} style={{ width: "100%", background: "#e8f5ee", border: "1px solid #1a6b3c", borderRadius: 8, padding: "6px", cursor: "pointer", fontSize: 12, color: "#1a6b3c", fontWeight: 500 }}>
              ✓ Mark as Done
            </button>
          </div>
        )}

        {/* Add savings — only for money goals */}
        <div style={{ marginTop: "auto", paddingTop: 8 }}>
          {!isTask && !item.completed && remaining > 0 && <AddSavingsInline item={item} cardAccent={cardAccent} accounts={accounts} addSavings={addSavings} />}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Edit modal */}
      {editItem && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 16, padding: "1.5rem", width: "min(460px, 90vw)", border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 16 }}>✏️ Edit Goal</div>
            { renderFormFields(editItem, setEditItem) }
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
              <button onClick={() => setEditItem(null)} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "8px 16px", cursor: "pointer", color: "var(--color-text-secondary)" }}>Cancel</button>
              <button onClick={saveEdit} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontWeight: 600 }}>Save</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26 }}>Goals</h1>
        <button onClick={() => setShowAdd(p => !p)} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>
          {showAdd ? "✕ Cancel" : "+ Add Goal"}
        </button>
      </div>

      {/* Summary strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
        {[
          { label: "Needs Goals", val: needs.length, sub: `${needs.filter(i => i.completed).length} completed`, color: "#4da6ff" },
          { label: "Needs Progress", val: fmtCur(totalNeedsSaved), sub: `of ${fmtCur(totalNeedsTarget)}`, color: "#1a6b3c" },
          { label: "Wants Goals", val: wants.length, sub: `${wants.filter(i => i.completed).length} completed`, color: "#9b59b6" },
          { label: "Wants Progress", val: fmtCur(totalWantsSaved), sub: `of ${fmtCur(totalWantsTarget)}`, color: "#f5a623" },
        ].map(c => (
          <div key={c.label} style={{ background: "var(--color-background-secondary)", borderRadius: 10, padding: "0.8rem 1rem", border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: c.color }}>{c.val}</div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{c.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: showAdd ? "300px 1fr" : "1fr", gap: 16, alignItems: "start" }}>
        {/* Add form */}
        {showAdd && (
          <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.1rem" }}>
            <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 12, borderBottom: "0.5px solid var(--color-border-tertiary)", paddingBottom: 10 }}>Add Goal</div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Type</label>
              <div style={{ display: "flex", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, overflow: "hidden" }}>
                {[["needs","🏠 Need","#4da6ff","#e8f0ff"],["wants","✨ Want","#9b59b6","#f3e8ff"]].map(([v, lbl, color, bg]) => (
                  <button key={v} onClick={() => setActiveTab(v)}
                    style={{ flex: 1, padding: "7px 0", border: "none", cursor: "pointer", fontSize: 13, fontWeight: activeTab === v ? 600 : 400, background: activeTab === v ? bg : "transparent", color: activeTab === v ? color : "var(--color-text-secondary)", transition: "all 0.15s" }}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
            { renderFormFields(form, setForm) }
            <button onClick={addItem} style={{ marginTop: 12, background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 500, width: "100%" }}>+ Add Goal</button>
          </div>
        )}

        {/* Goals list */}
        <div>
          <div style={{ display: "flex", borderBottom: "0.5px solid var(--color-border-tertiary)", marginBottom: 16 }}>
            {[["needs","🏠 Needs"],["wants","✨ Wants"]].map(([v, lbl]) => (
              <button key={v} onClick={() => setActiveTab(v)} style={{ padding: "8px 20px", background: "none", border: "none", cursor: "pointer", fontSize: 14, color: activeTab === v ? "var(--color-text-primary)" : "var(--color-text-secondary)", fontWeight: activeTab === v ? 500 : 400, borderBottom: activeTab === v ? "2px solid #1a6b3c" : "2px solid transparent", marginBottom: -1 }}>
                {lbl} <span style={{ fontSize: 12, background: "var(--color-background-secondary)", borderRadius: 10, padding: "1px 7px", marginLeft: 4, color: "var(--color-text-secondary)" }}>{v === "needs" ? needs.length : wants.length}</span>
              </button>
            ))}
          </div>

          {displayed.length === 0 ? (
            <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px dashed var(--color-border-secondary)", padding: "2.5rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
              No {activeTab} goals yet. Click "+ Add Goal" to create one.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14, alignItems: "stretch" }}>
              {displayed.sort((a, b) => {
                const pOrder = { high: 0, medium: 1, low: 2 };
                if (a.completed !== b.completed) return a.completed ? 1 : -1;
                return pOrder[a.priority] - pOrder[b.priority];
              }).map(item => <div key={item.id} style={{ display: "flex", flexDirection: "column", height: "100%" }}>{renderItemCard(item)}</div>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ─── Business Page ────────────────────────────────────────────────────────────
function BusinessPage({ data, update }) {
  // Data structure: businesses = [{ id, name, data: [{id, year, month, monthIndex, grossIncome, netIncome, billImage, ...}] }]
  // Migrate legacy flat businessData into first business if needed
  const businesses = data.businesses || [];
  const legacyData = data.businessData || [];

  // State: which business is open, which year is open
  const [selectedBiz,  setSelectedBiz]  = useState(null); // business id
  const [selectedYear, setSelectedYear] = useState(null);
  const [showAddBiz,   setShowAddBiz]   = useState(false);
  const [newBizName,   setNewBizName]   = useState("");
  const [showAddYear,  setShowAddYear]  = useState(false);
  const [newYear,      setNewYear]      = useState("");
  const [showAddMonth, setShowAddMonth] = useState(false);
  const [monthForm,    setMonthForm]    = useState({ month: "", grossIncome: "", netIncome: "" });
  const [editEntry,    setEditEntry]    = useState(null);
  const [billModal,    setBillModal]    = useState(null);

  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  const activeBiz = businesses.find(b => b.id === selectedBiz) || null;
  // Use active business data or legacy flat data for backward compat
  const bizData = activeBiz ? (activeBiz.data || []) : (selectedBiz === "__legacy__" ? legacyData : []);
  const years = [...new Set(bizData.map(e => e.year))].sort((a, b) => b - a);
  const yearEntries = selectedYear
    ? bizData.filter(e => e.year === selectedYear).sort((a, b) => a.monthIndex - b.monthIndex)
    : [];
  const yearSummary = years.map(yr => {
    const entries = bizData.filter(e => e.year === yr);
    return { year: yr, totalGross: entries.reduce((s, e) => s + (e.grossIncome || 0), 0), totalNet: entries.reduce((s, e) => s + (e.netIncome || 0), 0), months: entries.length };
  });

  function updateBizData(fn) {
    if (!activeBiz) return;
    update(p => ({ businesses: (p.businesses || []).map(b => b.id === selectedBiz ? { ...b, data: fn(b.data || []) } : b) }));
  }
  function updateEntry(id, changes) {
    updateBizData(d => d.map(e => e.id === id ? { ...e, ...changes } : e));
  }
  function deleteEntry(id) {
    updateBizData(d => d.filter(e => e.id !== id));
  }
  function deleteYear(yr) {
    if (!confirm(`Delete all data for ${yr}?`)) return;
    updateBizData(d => d.filter(e => e.year !== yr));
    if (selectedYear === yr) setSelectedYear(null);
  }

  function addBusiness() {
    if (!newBizName.trim()) return;
    const biz = { id: "biz_" + Date.now(), name: newBizName.trim(), data: [], createdAt: new Date().toISOString() };
    update(p => ({ businesses: [...(p.businesses || []), biz] }));
    setNewBizName(""); setShowAddBiz(false);
    setSelectedBiz(biz.id);
  }
  function deleteBusiness(id) {
    if (!confirm("Delete this business and all its data?")) return;
    update(p => ({ businesses: (p.businesses || []).filter(b => b.id !== id) }));
    if (selectedBiz === id) { setSelectedBiz(null); setSelectedYear(null); }
  }

  function addYear() {
    const y = parseInt(newYear);
    if (!y || years.includes(y)) return;
    setSelectedYear(y); setShowAddYear(false); setNewYear("");
  }

  function addMonthEntry() {
    const monthIdx = MONTHS.indexOf(monthForm.month);
    if (monthIdx === -1 || !monthForm.grossIncome || !monthForm.netIncome) return;
    const existing = bizData.find(e => e.year === selectedYear && e.monthIndex === monthIdx);
    if (existing) {
      updateBizData(d => d.map(e => e.year === selectedYear && e.monthIndex === monthIdx
        ? { ...e, grossIncome: parseFloat(monthForm.grossIncome), netIncome: parseFloat(monthForm.netIncome) } : e));
    } else {
      updateBizData(d => [...d, { id: Date.now(), year: selectedYear, month: monthForm.month, monthIndex: monthIdx, grossIncome: parseFloat(monthForm.grossIncome), netIncome: parseFloat(monthForm.netIncome) }]);
    }
    setMonthForm({ month: "", grossIncome: "", netIncome: "" }); setShowAddMonth(false);
  }

  function saveEdit() {
    if (!editEntry) return;
    updateBizData(d => d.map(e => e.id === editEntry.id ? { ...e, grossIncome: parseFloat(editEntry.grossIncome), netIncome: parseFloat(editEntry.netIncome) } : e));
    setEditEntry(null);
  }

  // Minimal SVG line chart (replaces bar chart)
  function LineChart({ entries, height = 120 }) {
    const [hoveredIdx, setHoveredIdx] = useState(null);
    const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
    if (!entries.length) return null;
    const sorted = [...entries].sort((a, b) => (a.monthIndex ?? 0) - (b.monthIndex ?? 0));
    const maxVal = Math.max(...sorted.map(e => Math.max(e.grossIncome, e.netIncome)), 1);
    const W = 520, pad = { l: 10, r: 10, t: 8, b: 28 };
    const chartW = W - pad.l - pad.r;
    const chartH = height;
    const n = sorted.length;
    const xOf = i => pad.l + (n > 1 ? (i / (n - 1)) * chartW : chartW / 2);
    const yOf = v => pad.t + chartH - Math.round((v / maxVal) * chartH);
    const pts = key => sorted.map((e, i) => `${xOf(i)},${yOf(e[key])}`).join(" ");
    const area = key => {
      const line = sorted.map((e, i) => `${xOf(i)},${yOf(e[key])}`).join(" L ");
      return `M ${xOf(0)},${pad.t + chartH} L ${line} L ${xOf(n - 1)},${pad.t + chartH} Z`;
    };
    const hovered = hoveredIdx !== null ? sorted[hoveredIdx] : null;
    return (
      <div style={{ position: "relative" }}>
        <svg width="100%" viewBox={`0 0 ${W} ${height + pad.t + pad.b}`} style={{ display: "block" }}
          onMouseLeave={() => setHoveredIdx(null)}>
          <defs>
            <linearGradient id="lgGross" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1a6b3c" stopOpacity="0.13" />
              <stop offset="100%" stopColor="#1a6b3c" stopOpacity="0.01" />
            </linearGradient>
            <linearGradient id="lgNet" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4da6ff" stopOpacity="0.13" />
              <stop offset="100%" stopColor="#4da6ff" stopOpacity="0.01" />
            </linearGradient>
          </defs>
          {/* Subtle grid */}
          {[0, 0.5, 1].map(f => (
            <line key={f} x1={pad.l} x2={W - pad.r} y1={yOf(maxVal * f)} y2={yOf(maxVal * f)}
              stroke="#e5e7eb" strokeWidth={0.5} />
          ))}
          {/* Area fills */}
          <path d={area("grossIncome")} fill="url(#lgGross)" />
          <path d={area("netIncome")} fill="url(#lgNet)" />
          {/* Lines */}
          <polyline points={pts("grossIncome")} fill="none" stroke="#1a6b3c" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
          <polyline points={pts("netIncome")} fill="none" stroke="#4da6ff" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
          {/* Hover vertical line */}
          {hoveredIdx !== null && (
            <line x1={xOf(hoveredIdx)} x2={xOf(hoveredIdx)} y1={pad.t} y2={pad.t + chartH}
              stroke="#6b7280" strokeWidth={1} strokeDasharray="3,3" />
          )}
          {/* Dots + hover targets + month labels */}
          {sorted.map((e, i) => (
            <g key={e.id}>
              <rect x={xOf(i) - (n > 1 ? chartW / (n - 1) / 2 : 20)} y={pad.t}
                width={n > 1 ? chartW / (n - 1) : 40} height={chartH}
                fill="transparent" style={{ cursor: "crosshair" }}
                onMouseEnter={ev => { setHoveredIdx(i); setTooltipPos({ x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY }); }}
                onMouseMove={ev => setTooltipPos({ x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY })}
              />
              <circle cx={xOf(i)} cy={yOf(e.grossIncome)} r={hoveredIdx === i ? 4.5 : 3} fill="#1a6b3c" style={{ transition: "r 0.1s" }} />
              <circle cx={xOf(i)} cy={yOf(e.netIncome)} r={hoveredIdx === i ? 4.5 : 3} fill="#4da6ff" style={{ transition: "r 0.1s" }} />
              <text x={xOf(i)} y={pad.t + chartH + 14} textAnchor="middle" fontSize={8.5}
                fill={hoveredIdx === i ? "#111" : "#6b7280"} fontWeight={hoveredIdx === i ? "600" : "400"}>
                {e.month.slice(0, 3)}
              </text>
            </g>
          ))}
          {/* Legend */}
          <circle cx={pad.l} cy={pad.t + chartH + 24} r={3.5} fill="#1a6b3c" />
          <text x={pad.l + 8} y={pad.t + chartH + 28} fontSize={8} fill="#6b7280">Gross</text>
          <circle cx={pad.l + 46} cy={pad.t + chartH + 24} r={3.5} fill="#4da6ff" />
          <text x={pad.l + 54} y={pad.t + chartH + 28} fontSize={8} fill="#6b7280">Net</text>
        </svg>
        {hovered && (
          <div style={{
            position: "absolute", top: Math.max(0, tooltipPos.y - 65), left: tooltipPos.x + 10,
            background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)",
            borderRadius: 8, padding: "7px 12px", boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
            zIndex: 50, pointerEvents: "none", minWidth: 140,
          }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 5 }}>{hovered.month}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 3 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#1a6b3c", display: "inline-block" }} />
              <span style={{ color: "var(--color-text-secondary)" }}>Gross:</span>
              <span style={{ color: "#1a6b3c", fontWeight: 600 }}>{fmtCur(hovered.grossIncome)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#4da6ff", display: "inline-block" }} />
              <span style={{ color: "var(--color-text-secondary)" }}>Net:</span>
              <span style={{ color: "#4da6ff", fontWeight: 600 }}>{fmtCur(hovered.netIncome)}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Year-on-year line chart (compact, replaces bar chart)
  function YoYChart({ summaries, height = 90 }) {
    const [hoveredIdx, setHoveredIdx] = useState(null);
    const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
    if (!summaries.length) return null;
    const displayed = [...summaries].sort((a, b) => a.year - b.year);
    const maxVal = Math.max(...displayed.map(s => Math.max(s.totalGross, s.totalNet)), 1);
    const W = 480, pad = 40, chartH = height;
    const n = displayed.length;
    const xStep = n > 1 ? (W - pad * 2) / (n - 1) : 0;
    const yOf = v => chartH - Math.round((v / maxVal) * (chartH - 10)) + 4;
    const pts = (key) => displayed.map((s, i) => `${pad + i * xStep},${yOf(s[key])}`).join(" ");
    const area = (key) => {
      const line = displayed.map((s, i) => `${pad + i * xStep},${yOf(s[key])}`).join(" L ");
      return `M ${pad},${chartH + 4} L ${line} L ${pad + (n - 1) * xStep},${chartH + 4} Z`;
    };
    const hovered = hoveredIdx !== null ? displayed[hoveredIdx] : null;
    return (
      <div style={{ position: "relative" }}>
        <svg width="100%" viewBox={`0 0 ${W} ${chartH + 36}`} style={{ display: "block" }}
          onMouseLeave={() => setHoveredIdx(null)}
        >
          <defs>
            <linearGradient id="grossGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1a6b3c" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#1a6b3c" stopOpacity="0.01" />
            </linearGradient>
            <linearGradient id="netGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4da6ff" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#4da6ff" stopOpacity="0.01" />
            </linearGradient>
          </defs>
          {/* Grid lines */}
          {[0, 0.5, 1].map(frac => (
            <line key={frac} x1={pad} x2={W - pad} y1={yOf(maxVal * frac)} y2={yOf(maxVal * frac)} stroke="#e5e7eb" strokeWidth={0.5} />
          ))}
          {/* Area fills */}
          <path d={area("totalGross")} fill="url(#grossGrad)" />
          <path d={area("totalNet")} fill="url(#netGrad)" />
          {/* Lines */}
          <polyline points={pts("totalGross")} fill="none" stroke="#1a6b3c" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <polyline points={pts("totalNet")} fill="none" stroke="#4da6ff" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {/* Vertical hover line */}
          {hoveredIdx !== null && (
            <line
              x1={pad + hoveredIdx * xStep} x2={pad + hoveredIdx * xStep}
              y1={4} y2={chartH + 4}
              stroke="#6b7280" strokeWidth={1} strokeDasharray="3,3"
            />
          )}
          {/* Dots + hover targets + year labels */}
          {displayed.map((s, i) => (
            <g key={s.year}>
              <rect
                x={pad + i * xStep - (xStep > 0 ? xStep / 2 : 20)} y={0}
                width={xStep > 0 ? xStep : 40} height={chartH + 4}
                fill="transparent" style={{ cursor: "crosshair" }}
                onMouseEnter={(e) => {
                  setHoveredIdx(i);
                  setTooltipPos({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY });
                }}
                onMouseMove={(e) => setTooltipPos({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })}
              />
              <circle cx={pad + i * xStep} cy={yOf(s.totalGross)} r={hoveredIdx === i ? 5 : 3.5} fill="#1a6b3c" style={{ transition: "r 0.1s" }} />
              <circle cx={pad + i * xStep} cy={yOf(s.totalNet)} r={hoveredIdx === i ? 5 : 3.5} fill="#4da6ff" style={{ transition: "r 0.1s" }} />
              <text x={pad + i * xStep} y={chartH + 18} textAnchor="middle" fontSize={9} fill={hoveredIdx === i ? "#111" : "#6b7280"} fontWeight={hoveredIdx === i ? "600" : "400"}>{s.year}</text>
            </g>
          ))}
          {/* Legend */}
          <circle cx={pad} cy={chartH + 28} r={4} fill="#1a6b3c" />
          <text x={pad + 8} y={chartH + 32} fontSize={8} fill="#6b7280">Gross Income</text>
          <circle cx={pad + 90} cy={chartH + 28} r={4} fill="#4da6ff" />
          <text x={pad + 98} y={chartH + 32} fontSize={8} fill="#6b7280">Net Income</text>
        </svg>
        {/* Floating tooltip */}
        {hovered && (
          <div style={{
            position: "absolute",
            top: Math.max(0, tooltipPos.y - 70),
            left: tooltipPos.x + 12,
            background: "var(--color-background-primary)",
            border: "0.5px solid var(--color-border-secondary)",
            borderRadius: 8,
            padding: "7px 12px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            zIndex: 50,
            pointerEvents: "none",
            minWidth: 140,
          }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 5, color: "var(--color-text-primary)" }}>{hovered.year}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 3 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#1a6b3c", display: "inline-block" }} />
              <span style={{ color: "var(--color-text-secondary)" }}>Gross:</span>
              <span style={{ color: "#1a6b3c", fontWeight: 600 }}>{fmtCur(hovered.totalGross)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 3 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#4da6ff", display: "inline-block" }} />
              <span style={{ color: "var(--color-text-secondary)" }}>Net:</span>
              <span style={{ color: "#4da6ff", fontWeight: 600 }}>{fmtCur(hovered.totalNet)}</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 4, marginTop: 2 }}>
              Margin: {hovered.totalGross > 0 ? ((hovered.totalNet / hovered.totalGross) * 100).toFixed(1) : 0}% · {hovered.months} month{hovered.months !== 1 ? "s" : ""}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Edit modal */}
      {editEntry && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 16, padding: "1.5rem", width: "min(380px, 90vw)", border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 16 }}>✏️ Edit {editEntry.month} {editEntry.year}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              <div>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Gross Income (₹)</label>
                <input type="text" inputMode="decimal" value={editEntry.grossIncome}
                  onChange={e => { const v = e.target.value; if (v === "" || /^\d*\.?\d*$/.test(v)) setEditEntry(p => ({ ...p, grossIncome: v })); }}
                  style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Net Income (₹)</label>
                <input type="text" inputMode="decimal" value={editEntry.netIncome}
                  onChange={e => { const v = e.target.value; if (v === "" || /^\d*\.?\d*$/.test(v)) setEditEntry(p => ({ ...p, netIncome: v })); }}
                  style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setEditEntry(null)} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "8px 16px", cursor: "pointer", color: "var(--color-text-secondary)" }}>Cancel</button>
              <button onClick={saveEdit} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontWeight: 600 }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ── HEADER / BREADCRUMB ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {selectedBiz && (
            <button onClick={() => { setSelectedBiz(null); setSelectedYear(null); }} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)" }}>← Back</button>
          )}
          {selectedYear && (
            <button onClick={() => setSelectedYear(null)} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)" }}>← Years</button>
          )}
          <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26 }}>
            {!selectedBiz ? "Business"
              : !selectedYear ? `${activeBiz?.name}`
              : `${activeBiz?.name} · ${selectedYear}`}
          </h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!selectedBiz && (
            <button onClick={() => setShowAddBiz(p => !p)} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>
              {showAddBiz ? "✕ Cancel" : "+ New Business"}
            </button>
          )}
          {selectedBiz && !selectedYear && (
            <button onClick={() => setShowAddYear(p => !p)} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>
              {showAddYear ? "✕ Cancel" : "+ Add Year"}
            </button>
          )}
          {selectedYear && (
            <button onClick={() => setShowAddMonth(p => !p)} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>
              {showAddMonth ? "✕ Cancel" : "+ Add Month"}
            </button>
          )}
        </div>
      </div>

      {/* ── LEVEL 1: Businesses grid ── */}
      {!selectedBiz && (
        <>
          {showAddBiz && (
            <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.1rem", marginBottom: 16, display: "flex", gap: 10, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Business Name</label>
                <input placeholder="e.g. Coconut, Freelance, Agency" value={newBizName} onChange={e => setNewBizName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addBusiness()}
                  style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <button onClick={addBusiness} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>Create</button>
            </div>
          )}
          {businesses.length === 0 ? (
            <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px dashed var(--color-border-secondary)", padding: "3rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
              No businesses yet. Click "+ New Business" to create your first one.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
              {businesses.map(biz => {
                const bizYears = [...new Set((biz.data || []).map(e => e.year))];
                const totalGross = (biz.data || []).reduce((s, e) => s + (e.grossIncome || 0), 0);
                const totalNet   = (biz.data || []).reduce((s, e) => s + (e.netIncome   || 0), 0);
                return (
                  <div key={biz.id} onClick={() => setSelectedBiz(biz.id)}
                    style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-secondary)", padding: "1.2rem", cursor: "pointer", borderTop: "3px solid #1a6b3c", position: "relative" }}
                    onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.08)"}
                    onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}>
                    <button onClick={ev => { ev.stopPropagation(); deleteBusiness(biz.id); }}
                      style={{ position: "absolute", top: 10, right: 10, background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: 14, opacity: 0.5, padding: 2 }}>🗑</button>
                    <div style={{ fontSize: 32, marginBottom: 6 }}>🏢</div>
                    <div style={{ fontWeight: 700, fontSize: 20, fontFamily: "'DM Serif Display', serif", marginBottom: 4 }}>{biz.name}</div>
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>{bizYears.length} year{bizYears.length !== 1 ? "s" : ""} of data</div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ color: "#1a6b3c" }}>Gross: {fmtCur(totalGross)}</span>
                      <span style={{ color: "#4da6ff" }}>Net: {fmtCur(totalNet)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ── LEVEL 2: Year folders inside a business ── */}
      {selectedBiz && !selectedYear && (
        <>
          {showAddYear && (
            <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.1rem", marginBottom: 16, display: "flex", gap: 10, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Year</label>
                <input type="text" inputMode="numeric" placeholder="e.g. 2025" value={newYear}
                  onChange={e => setNewYear(e.target.value)} onKeyDown={e => e.key === "Enter" && addYear()}
                  style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <button onClick={addYear} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>Create Year</button>
            </div>
          )}
          {yearSummary.length === 0 ? (
            <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px dashed var(--color-border-secondary)", padding: "3rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
              No years yet. Click "+ Add Year" to create your first year folder.
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12, marginBottom: 16 }}>
                {[...yearSummary].sort((a, b) => a.year - b.year).map(s => (
                  <div key={s.year} onClick={() => setSelectedYear(s.year)}
                    style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-secondary)", padding: "1.2rem", cursor: "pointer", borderTop: "3px solid #1a6b3c", position: "relative" }}
                    onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.08)"}
                    onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}>
                    <button onClick={ev => { ev.stopPropagation(); deleteYear(s.year); }}
                      style={{ position: "absolute", top: 10, right: 10, background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: 14, opacity: 0.5, padding: 2 }}>🗑</button>
                    <div style={{ fontSize: 28, marginBottom: 4 }}>📁</div>
                    <div style={{ fontWeight: 700, fontSize: 22, fontFamily: "'DM Serif Display', serif", marginBottom: 6 }}>{s.year}</div>
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>{s.months} month{s.months !== 1 ? "s" : ""} of data</div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ color: "#1a6b3c" }}>Gross: {fmtCur(s.totalGross)}</span>
                      <span style={{ color: "#4da6ff" }}>Net: {fmtCur(s.totalNet)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10, marginBottom: 16 }}>
                {[...yearSummary].sort((a, b) => a.year - b.year).map(s => (
                  <div key={s.year} style={{ background: "var(--color-background-secondary)", borderRadius: 10, padding: "0.8rem 1rem", border: "0.5px solid var(--color-border-tertiary)" }}>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 2 }}>{s.year} — Gross</div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: "#1a6b3c" }}>{fmtCur(s.totalGross)}</div>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4, marginBottom: 2 }}>Net</div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: "#4da6ff" }}>{fmtCur(s.totalNet)}</div>
                  </div>
                ))}
              </div>
              {yearSummary.length > 1 && (
                <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.1rem" }}>
                  <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 12, borderBottom: "0.5px solid var(--color-border-tertiary)", paddingBottom: 10 }}>Year-on-Year Performance</div>
                  <YoYChart summaries={yearSummary} />
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── YEAR DRILL-DOWN ── */}
      {selectedYear && (
        <>
          {/* Add Month form */}
          {showAddMonth && (
            <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.1rem", marginBottom: 16 }}>
              <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 12, borderBottom: "0.5px solid var(--color-border-tertiary)", paddingBottom: 10 }}>Add Month Data</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Month *</label>
                  <select value={monthForm.month} onChange={e => setMonthForm(p => ({ ...p, month: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
                    <option value="">Select month</option>
                    {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Gross Income (₹) *</label>
                  <input type="text" inputMode="decimal" placeholder="e.g. 500000" value={monthForm.grossIncome}
                    onChange={e => { const v = e.target.value; if (v === "" || /^\d*\.?\d*$/.test(v)) setMonthForm(p => ({ ...p, grossIncome: v })); }}
                    style={{ width: "100%", boxSizing: "border-box" }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Net Income (₹) *</label>
                  <input type="text" inputMode="decimal" placeholder="e.g. 300000" value={monthForm.netIncome}
                    onChange={e => { const v = e.target.value; if (v === "" || /^\d*\.?\d*$/.test(v)) setMonthForm(p => ({ ...p, netIncome: v })); }}
                    style={{ width: "100%", boxSizing: "border-box" }} />
                </div>
              </div>
              <button onClick={addMonthEntry} style={{ marginTop: 12, background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>+ Add Month</button>
            </div>
          )}

          {yearEntries.length === 0 ? (
            <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px dashed var(--color-border-secondary)", padding: "2.5rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
              No months added yet for {selectedYear}. Click "+ Add Month" to start.
            </div>
          ) : (
            <>
              {/* Summary stats for year */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
                {[
                  { label: "Total Gross", val: fmtCur(yearEntries.reduce((s, e) => s + e.grossIncome, 0)), color: "#1a6b3c" },
                  { label: "Total Net", val: fmtCur(yearEntries.reduce((s, e) => s + e.netIncome, 0)), color: "#4da6ff" },
                  { label: "Avg Monthly Gross", val: fmtCur(yearEntries.reduce((s, e) => s + e.grossIncome, 0) / yearEntries.length), color: "#f0a020" },
                  { label: "Avg Monthly Net", val: fmtCur(yearEntries.reduce((s, e) => s + e.netIncome, 0) / yearEntries.length), color: "#9b59b6" },
                ].map(c => (
                  <div key={c.label} style={{ background: "var(--color-background-secondary)", borderRadius: 10, padding: "0.8rem 1rem", border: "0.5px solid var(--color-border-tertiary)" }}>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>{c.label}</div>
                    <div style={{ fontSize: 18, fontWeight: 600, color: c.color }}>{c.val}</div>
                  </div>
                ))}
              </div>

              {/* Chart */}
              <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.1rem", marginBottom: 16 }}>
                <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 12, borderBottom: "0.5px solid var(--color-border-tertiary)", paddingBottom: 10 }}>Monthly Performance — {selectedYear}</div>
                <LineChart entries={yearEntries} />
              </div>

              {/* Monthly data table */}
              <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", overflow: "hidden" }}>
                <div style={{ padding: "0.8rem 1.1rem", borderBottom: "0.5px solid var(--color-border-tertiary)", fontWeight: 500, fontSize: 15 }}>Monthly Breakdown</div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "var(--color-background-secondary)" }}>
                      {["Month","Gross Income","Net Income","Margin","Bill",""].map(h => (
                        <th key={h} style={{ padding: "8px 14px", textAlign: h === "" ? "right" : "left", fontSize: 11, color: "var(--color-text-secondary)", fontWeight: 500 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {yearEntries.map((e, i) => {
                      const margin = e.grossIncome > 0 ? ((e.netIncome / e.grossIncome) * 100).toFixed(1) : "0.0";
                      return (
                        <tr key={e.id} style={{ borderTop: "0.5px solid var(--color-border-tertiary)", background: i % 2 === 0 ? "transparent" : "var(--color-background-secondary)" }}>
                          <td style={{ padding: "9px 14px", fontWeight: 500 }}>{e.month}</td>
                          <td style={{ padding: "9px 14px", color: "#1a6b3c", fontWeight: 600 }}>{fmtCur(e.grossIncome)}</td>
                          <td style={{ padding: "9px 14px", color: "#4da6ff", fontWeight: 600 }}>{fmtCur(e.netIncome)}</td>
                          <td style={{ padding: "9px 14px", color: parseFloat(margin) >= 50 ? "#1a6b3c" : "#f0a020" }}>{margin}%</td>
                          {/* Bill column */}
                          <td style={{ padding: "6px 14px" }}>
                            {e.billImage ? (
                              <img
                                src={e.billImage}
                                alt="bill"
                                onClick={() => setBillModal({ url: e.billImage, link: e.billLink, driveId: e.billDriveId })}
                                style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", cursor: "pointer", display: "block" }}
                                title="Click to view full bill"
                              />
                            ) : (
                              <BillUploadBtn onUploaded={result => updateEntry(e.id, { billImage: result.previewUrl || result.webViewLink, billDriveId: result.id, billLink: result.webViewLink })} />
                            )}
                          </td>
                          <td style={{ padding: "9px 14px", textAlign: "right" }}>
                            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                              <button onClick={() => setEditEntry({ ...e })} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}>✏️</button>
                              <button onClick={() => deleteEntry(e.id)} style={{ background: "none", border: "0.5px solid #d44", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12, color: "#d44" }}>🗑</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: "2px solid var(--color-border-secondary)", background: "var(--color-background-secondary)" }}>
                      <td style={{ padding: "9px 14px", fontWeight: 600 }}>Total</td>
                      <td style={{ padding: "9px 14px", color: "#1a6b3c", fontWeight: 700 }}>{fmtCur(yearEntries.reduce((s, e) => s + e.grossIncome, 0))}</td>
                      <td style={{ padding: "9px 14px", color: "#4da6ff", fontWeight: 700 }}>{fmtCur(yearEntries.reduce((s, e) => s + e.netIncome, 0))}</td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                </table>
                {/* Bill full-view modal */}
                {billModal && (
                  <div onClick={() => setBillModal(null)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.78)", zIndex:9999, display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
                    <div onClick={e=>e.stopPropagation()} style={{ background:"#fff", borderRadius:14, overflow:"hidden", maxWidth:"92vw", maxHeight:"92vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,0.4)", minWidth:340 }}>
                      <div style={{ padding:"10px 16px", borderBottom:"0.5px solid #e5e7eb", display:"flex", alignItems:"center", justifyContent:"space-between", background:"#f9fafb" }}>
                        <span style={{ fontWeight:600, fontSize:13 }}>Bill Preview</span>
                        <div style={{ display:"flex", gap:8 }}>
                          {billModal.link && <a href={billModal.link} target="_blank" rel="noreferrer" style={{ fontSize:12, color:"#1a6b3c", textDecoration:"none", padding:"3px 10px", border:"0.5px solid #1a6b3c", borderRadius:6 }}>☁ Open in Drive</a>}
                          <button onClick={()=>setBillModal(null)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:18, color:"#6b7280" }}>✕</button>
                        </div>
                      </div>
                      <div style={{ flex:1, overflow:"auto", display:"flex", alignItems:"center", justifyContent:"center", padding:8 }}>
                        {billModal.driveId
                          ? <iframe src={`https://drive.google.com/file/d/${billModal.driveId}/preview`} style={{ width:"80vw", height:"78vh", border:"none" }} title="Bill" allow="autoplay" />
                          : billModal.url?.startsWith?.("data:image")
                            ? <img src={billModal.url} alt="Bill" style={{ maxWidth:"80vw", maxHeight:"78vh", objectFit:"contain", borderRadius:6 }} />
                            : <iframe src={billModal.url} style={{ width:"80vw", height:"78vh", border:"none" }} title="Bill" />
                        }
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
// ─── Projects Page ───────────────────────────────────────────────────────────
const DEFAULT_TASK_TYPES = ["Design", "Development", "Research", "Review", "Testing", "Meeting", "Documentation", "Bug Fix", "Marketing", "Other"];

function ProjectsPage({ data, update }) {
  const projects = data.projectsData || [];
  const TASK_TYPES = (data.projectTaskTypes && data.projectTaskTypes.length > 0) ? data.projectTaskTypes : DEFAULT_TASK_TYPES;
  const [selectedProject, setSelectedProject] = useState(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");

  // Left panel tab: "tasks" | "files" | "notes"
  const [leftTab, setLeftTab] = useState("tasks");

  // Active note for OneNote-style view
  const [activeNoteId, setActiveNoteId] = useState(null);

  // File preview for project files tab — must be at component level (Rules of Hooks)
  const [filePreview, setFilePreview] = useState(null);

  // Notes state
  const [noteContent, setNoteContent] = useState("");
  const [notesSaved, setNotesSaved] = useState(false);

  // Task form state — taskTypes is now an array
  const [showAddTask, setShowAddTask] = useState(false);
  const [taskForm, setTaskForm] = useState({ name: "", types: [], eta: "" });

  // Edit task state
  const [editTaskId, setEditTaskId] = useState(null);
  const [editTaskForm, setEditTaskForm] = useState({ name: "", types: [], eta: "" });

  // Day tracking state
  const [newDayEntry, setNewDayEntry] = useState("");
  const [dayTrackDate, setDayTrackDate] = useState(new Date().toISOString().split("T")[0]);

  // Get the full selected project object (always fresh from data)
  const project = selectedProject ? projects.find(p => p.id === selectedProject) : null;
  const todos = project ? (project.todos || []) : [];
  const files = project ? (project.files || []) : [];
  const dayLog = project ? (project.dayLog || []) : [];
  const notes = project ? (project.notes || []) : [];

  // Sync noteContent to selected project's notes
  const prevProjectRef = useRef(null);
  useEffect(() => {
    if (selectedProject !== prevProjectRef.current) {
      prevProjectRef.current = selectedProject;
      // Don't reset noteContent here – Notes tab manages its own blocks
    }
  }, [selectedProject]);

  function addProject() {
    if (!newProjectName.trim()) return;
    const id = Date.now();
    update(p => ({ projectsData: [...(p.projectsData || []), { id, name: newProjectName.trim(), todos: [], files: [], createdAt: new Date().toISOString() }] }));
    setNewProjectName("");
    setShowAddProject(false);
    setSelectedProject(id);
  }

  function deleteProject(id) {
    if (!confirm("Delete this project and all its data?")) return;
    update(p => ({ projectsData: (p.projectsData || []).filter(pr => pr.id !== id) }));
    if (selectedProject === id) setSelectedProject(null);
  }

  function addTask() {
    if (!taskForm.name.trim() || !project) return;
    const todo = {
      id: Date.now(),
      text: taskForm.name.trim(),
      taskTypes: taskForm.types.length > 0 ? taskForm.types : [],
      // keep legacy taskType for backwards compat
      taskType: taskForm.types.length === 1 ? taskForm.types[0] : (taskForm.types.length > 1 ? taskForm.types.join(", ") : ""),
      eta: taskForm.eta,
      done: false,
      createdAt: new Date().toISOString(),
    };
    update(p => ({ projectsData: (p.projectsData || []).map(pr => pr.id === project.id ? { ...pr, todos: [...(pr.todos || []), todo] } : pr) }));
    setTaskForm({ name: "", types: [], eta: "" });
    setShowAddTask(false);
  }

  function toggleTodo(todoId) {
    update(p => ({ projectsData: (p.projectsData || []).map(pr => pr.id === project.id
      ? { ...pr, todos: (pr.todos || []).map(t => t.id === todoId ? { ...t, done: !t.done } : t) }
      : pr
    )}));
  }

  function deleteTodo(todoId) {
    update(p => ({ projectsData: (p.projectsData || []).map(pr => pr.id === project.id
      ? { ...pr, todos: (pr.todos || []).filter(t => t.id !== todoId) }
      : pr
    )}));
  }

  function startEditTask(t) {
    setEditTaskId(t.id);
    // Support both old taskType (string) and new taskTypes (array)
    const types = t.taskTypes && t.taskTypes.length > 0
      ? t.taskTypes
      : (t.taskType ? [t.taskType] : []);
    setEditTaskForm({ name: t.text, types, eta: t.eta || "" });
  }

  function saveEditTask() {
    if (!editTaskForm.name.trim()) return;
    update(p => ({ projectsData: (p.projectsData || []).map(pr => pr.id === project.id
      ? { ...pr, todos: (pr.todos || []).map(t => t.id === editTaskId ? {
          ...t,
          text: editTaskForm.name.trim(),
          taskTypes: editTaskForm.types,
          taskType: editTaskForm.types.length === 1 ? editTaskForm.types[0] : (editTaskForm.types.join(", ")),
          eta: editTaskForm.eta
        } : t) }
      : pr
    )}));
    setEditTaskId(null);
  }

  const drive = useDrive();
  async function handleFileUpload(e) {
    const fileList = Array.from(e.target.files);
    if (!fileList.length || !project) return;
    for (const file of fileList) {
      let fileEntry;
      if (drive?.connected) {
        const result = await drive.uploadToDrive(file, null);
        fileEntry = result
          ? { id: result.id, name: result.name, type: result.mimeType, size: result.size, previewUrl: result.previewUrl, webViewLink: result.webViewLink, downloadUrl: result.downloadUrl, source: "gdrive", uploadedAt: new Date().toISOString() }
          : null;
      }
      if (!fileEntry) {
        // fallback local
        const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = ev => res(ev.target.result); r.readAsDataURL(file); });
        fileEntry = { id: Date.now() + Math.random(), name: file.name, type: file.type, size: file.size, dataUrl, source: "local", uploadedAt: new Date().toISOString() };
      }
      update(p => ({ projectsData: (p.projectsData || []).map(pr => pr.id === project.id
        ? { ...pr, files: [...(pr.files || []), fileEntry] }
        : pr
      )}));
    }
    e.target.value = "";
  }

  function deleteFile(fileId) {
    update(p => ({ projectsData: (p.projectsData || []).map(pr => pr.id === project.id
      ? { ...pr, files: (pr.files || []).filter(f => f.id !== fileId) }
      : pr
    )}));
  }

  function addDayEntry() {
    if (!newDayEntry.trim() || !project) return;
    const entry = { id: Date.now(), text: newDayEntry.trim(), date: dayTrackDate, done: false, createdAt: new Date().toISOString() };
    update(p => ({ projectsData: (p.projectsData || []).map(pr => pr.id === project.id
      ? { ...pr, dayLog: [...(pr.dayLog || []), entry] }
      : pr
    )}));
    setNewDayEntry("");
  }

  function toggleDayEntry(entryId) {
    update(p => ({ projectsData: (p.projectsData || []).map(pr => pr.id === project.id
      ? { ...pr, dayLog: (pr.dayLog || []).map(e => e.id === entryId ? { ...e, done: !e.done } : e) }
      : pr
    )}));
  }

  function deleteDayEntry(entryId) {
    update(p => ({ projectsData: (p.projectsData || []).map(pr => pr.id === project.id
      ? { ...pr, dayLog: (pr.dayLog || []).filter(e => e.id !== entryId) }
      : pr
    )}));
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function fileIcon(type) {
    if (type.startsWith("image/")) return "🖼️";
    if (type === "application/pdf") return "📄";
    if (type.includes("word") || type.includes("document")) return "📝";
    if (type.includes("sheet") || type.includes("excel") || type.includes("csv")) return "📊";
    if (type.includes("zip") || type.includes("rar")) return "🗜️";
    return "📎";
  }

  function etaColor(etaStr) {
    if (!etaStr) return "var(--color-text-secondary)";
    const eta = new Date(etaStr);
    const now = new Date();
    const diff = (eta - now) / (1000 * 60 * 60 * 24);
    if (diff < 0) return "#d44";
    if (diff <= 2) return "#f0a020";
    return "#1a6b3c";
  }

  function formatEta(etaStr) {
    if (!etaStr) return null;
    const d = new Date(etaStr);
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  const doneTodos = todos.filter(t => t.done).length;
  const pendingTodos = todos.filter(t => !t.done);
  const completedTodos = todos.filter(t => t.done);

  // Tab styles helper
  const tabStyle = (active) => ({
    padding: "7px 16px", background: "none", border: "none", cursor: "pointer",
    fontSize: 13, fontWeight: active ? 500 : 400,
    color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
    borderBottom: active ? "2px solid #1a6b3c" : "2px solid transparent",
    marginBottom: -1, whiteSpace: "nowrap",
  });

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {project && (
            <button onClick={() => { setSelectedProject(null); setShowAddTask(false); setEditTaskId(null); }} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)" }}>
              ← Back
            </button>
          )}
          <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26 }}>
            {project ? project.name : "Projects"}
          </h1>
        </div>
        {!project && (
          <button onClick={() => setShowAddProject(p => !p)} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>
            {showAddProject ? "✕ Cancel" : "+ New Project"}
          </button>
        )}
      </div>

      {/* Add project form */}
      {showAddProject && !project && (
        <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.1rem", marginBottom: 16, display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Project Name</label>
            <input
              placeholder="e.g. Website Redesign, Q3 Campaign…"
              value={newProjectName}
              onChange={e => setNewProjectName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addProject()}
              style={{ width: "100%", boxSizing: "border-box" }}
              autoFocus
            />
          </div>
          <button onClick={addProject} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 500, whiteSpace: "nowrap" }}>Create Project</button>
        </div>
      )}

      {/* ── PROJECT LIST (overview) ── */}
      {!project && (
        <>
          {projects.length === 0 ? (
            <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px dashed var(--color-border-secondary)", padding: "3.5rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
              No projects yet. Click "+ New Project" to create your first one.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}>
              {projects.map(pr => {
                const done = (pr.todos || []).filter(t => t.done).length;
                const total = (pr.todos || []).length;
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                return (
                  <div key={pr.id}
                    onClick={() => setSelectedProject(pr.id)}
                    style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-secondary)", borderTop: "3px solid #1a6b3c", padding: "1.2rem", cursor: "pointer", position: "relative", transition: "box-shadow 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.08)"}
                    onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}
                  >
                    <button onClick={ev => { ev.stopPropagation(); deleteProject(pr.id); }}
                      style={{ position: "absolute", top: 10, right: 10, background: "none", border: "none", cursor: "pointer", fontSize: 14, opacity: 0.4, padding: 2 }}>🗑</button>
                    <div style={{ fontSize: 28, marginBottom: 6 }}>📁</div>
                    <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4, paddingRight: 20 }}>{pr.name}</div>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 10 }}>
                      {total} task{total !== 1 ? "s" : ""} · {(pr.files || []).length} file{(pr.files || []).length !== 1 ? "s" : ""}
                    </div>
                    {total > 0 && (
                      <>
                        <div style={{ background: "var(--color-background-secondary)", borderRadius: 4, height: 5, overflow: "hidden", marginBottom: 4 }}>
                          <div style={{ width: pct + "%", height: "100%", background: pct === 100 ? "#1a6b3c" : "#4da6ff", borderRadius: 4, transition: "width 0.4s" }} />
                        </div>
                        <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{done}/{total} done · {pct}%</div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ── PROJECT DETAIL ── */}
      {project && (
        <div style={{ display: "grid", gridTemplateColumns: leftTab === "notes" ? "1fr" : "1fr 1.5fr", gap: 16, alignItems: "start", ...(leftTab === "notes" ? { height: "calc(100vh - 140px)" } : {}) }}>

          {/* LEFT PANEL — Tabbed: Tasks | Files | Notes */}
          <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", overflow: "hidden", ...(leftTab === "notes" ? { gridColumn: "1 / -1", display: "flex", flexDirection: "column", height: "100%" } : {}) }}>

            {/* Tab bar */}
            <div style={{ display: "flex", borderBottom: "0.5px solid var(--color-border-tertiary)", padding: "0 4px", flexShrink: 0 }}>
              <button style={tabStyle(leftTab === "tasks")} onClick={() => setLeftTab("tasks")}>
                ✅ Tasks {todos.length > 0 && <span style={{ fontSize: 11, color: "var(--color-text-secondary)", marginLeft: 4 }}>({doneTodos}/{todos.length})</span>}
              </button>
              <button style={tabStyle(leftTab === "files")} onClick={() => setLeftTab("files")}>
                📎 Files {files.length > 0 && <span style={{ fontSize: 11, color: "var(--color-text-secondary)", marginLeft: 4 }}>({files.length})</span>}
              </button>
              <button style={tabStyle(leftTab === "notes")} onClick={() => setLeftTab("notes")}>
                📝 Notes {notes.length > 0 && <span style={{ fontSize: 11, color: "var(--color-text-secondary)", marginLeft: 4 }}>({notes.length})</span>}
              </button>
            </div>

            {/* ── TASKS TAB ── */}
            {leftTab === "tasks" && (
              <div>
                {/* Add Task button */}
                <div style={{ padding: "10px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                  {!showAddTask ? (
                    <button onClick={() => setShowAddTask(true)} style={{ width: "100%", background: "none", border: "1px dashed var(--color-border-secondary)", borderRadius: 8, padding: "7px", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)", textAlign: "left" }}>
                      + Add task…
                    </button>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div>
                        <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Task Name *</label>
                        <input
                          placeholder="e.g. Design homepage mockup"
                          value={taskForm.name}
                          onChange={e => setTaskForm(f => ({ ...f, name: e.target.value }))}
                          style={{ width: "100%", boxSizing: "border-box", fontSize: 13 }}
                          autoFocus
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 5 }}>
                          Task Types <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>(select one or more)</span>
                          {taskForm.types.length > 0 && <span style={{ marginLeft: 6, color: "#1a6b3c", fontWeight: 600 }}>· {taskForm.types.length} selected · {Math.round(100/taskForm.types.length)}% each</span>}
                        </label>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                          {TASK_TYPES.map(t => {
                            const sel = taskForm.types.includes(t);
                            return (
                              <button key={t} type="button"
                                onClick={() => setTaskForm(f => ({ ...f, types: sel ? f.types.filter(x => x !== t) : [...f.types, t] }))}
                                style={{ fontSize: 11, padding: "3px 9px", borderRadius: 12, border: sel ? "1.5px solid #1a6b3c" : "0.5px solid var(--color-border-secondary)", background: sel ? "#e8f5ee" : "transparent", color: sel ? "#1a6b3c" : "var(--color-text-secondary)", cursor: "pointer", fontWeight: sel ? 600 : 400, transition: "all 0.12s" }}
                              >{t}</button>
                            );
                          })}
                        </div>
                      </div>
                      <div>
                        <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>ETA (Due Date)</label>
                        <input type="date" value={taskForm.eta} onChange={e => setTaskForm(f => ({ ...f, eta: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontSize: 12 }} />
                      </div>
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button onClick={() => { setShowAddTask(false); setTaskForm({ name: "", types: [], eta: "" }); }} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}>Cancel</button>
                        <button onClick={addTask} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 7, padding: "5px 14px", cursor: "pointer", fontSize: 12, fontWeight: 500 }}>Add Task</button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Deadlines */}
                {todos.length === 0 ? (
                  <div style={{ padding: "2rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
                    No tasks yet. Click "+ Add task…" to get started.
                  </div>
                ) : (
                  <div>
                    {pendingTodos.length > 0 && (
                      <>
                    <div style={{ padding: "6px 14px", fontSize: 11, color: "var(--color-text-secondary)", fontWeight: 500, background: "var(--color-background-secondary)", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>DEADLINES ({pendingTodos.length})</div>
                    {pendingTodos
                      .slice()
                      .sort((a, b) => {
                        if (!a.eta && !b.eta) return 0;
                        if (!a.eta) return 1;
                        if (!b.eta) return -1;
                        return new Date(a.eta) - new Date(b.eta);
                      })
                      .map(t => (
                        <div key={t.id} style={{ borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                          {editTaskId === t.id ? (
                            <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 7, background: "var(--color-background-secondary)" }}>
                              <input value={editTaskForm.name} onChange={e => setEditTaskForm(f => ({ ...f, name: e.target.value }))} placeholder="Task name" style={{ width: "100%", boxSizing: "border-box", fontSize: 13 }} autoFocus />
                              <div>
                                <label style={{ fontSize: 10, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
                                  Task Types
                                  {editTaskForm.types.length > 0 && <span style={{ marginLeft: 5, color: "#1a6b3c", fontWeight: 600 }}>· {editTaskForm.types.length} · {Math.round(100/editTaskForm.types.length)}% each</span>}
                                </label>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                  {TASK_TYPES.map(tt => {
                                    const sel = editTaskForm.types.includes(tt);
                                    return (
                                      <button key={tt} type="button"
                                        onClick={() => setEditTaskForm(f => ({ ...f, types: sel ? f.types.filter(x => x !== tt) : [...f.types, tt] }))}
                                        style={{ fontSize: 10, padding: "2px 7px", borderRadius: 10, border: sel ? "1.5px solid #1a6b3c" : "0.5px solid var(--color-border-secondary)", background: sel ? "#e8f5ee" : "#fff", color: sel ? "#1a6b3c" : "var(--color-text-secondary)", cursor: "pointer", fontWeight: sel ? 600 : 400 }}
                                      >{tt}</button>
                                    );
                                  })}
                                </div>
                              </div>
                              <input type="date" value={editTaskForm.eta} onChange={e => setEditTaskForm(f => ({ ...f, eta: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontSize: 12 }} />
                              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                                <button onClick={() => setEditTaskId(null)} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}>Cancel</button>
                                <button onClick={saveEditTask} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 12, fontWeight: 500 }}>Save</button>
                              </div>
                            </div>
                          ) : (
                            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 14px" }}>
                              <button
                                onClick={() => toggleTodo(t.id)}
                                style={{ width: 18, height: 18, borderRadius: 4, border: t.done ? "1.5px solid #1a6b3c" : "1.5px solid var(--color-border-secondary)", background: t.done ? "#e8f5ee" : "transparent", cursor: "pointer", flexShrink: 0, marginTop: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#1a6b3c", fontSize: 10 }}
                              >{t.done ? "✓" : ""}</button>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, wordBreak: "break-word" }}>{t.text}</div>
                                {/* Task types with % breakdown */}
                                {(() => {
                                  const types = t.taskTypes && t.taskTypes.length > 0
                                    ? t.taskTypes
                                    : (t.taskType ? [t.taskType] : []);
                                  if (types.length === 0) return null;
                                  const pctEach = Math.round(100 / types.length);
                                  return (
                                    <div style={{ marginBottom: 4 }}>
                                      {/* Segmented bar */}
                                      <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", height: 5, marginBottom: 5 }}>
                                        {types.map((tp, i) => {
                                          const colors = ["#1a6b3c","#4da6ff","#f0a020","#9b59b6","#e74c3c","#1abc9c","#e67e22","#3498db","#e91e63","#607d8b"];
                                          return <div key={tp} style={{ flex: 1, background: colors[i % colors.length] }} />;
                                        })}
                                      </div>
                                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                        {types.map((tp, i) => {
                                          const colors = ["#1a6b3c","#4da6ff","#f0a020","#9b59b6","#e74c3c","#1abc9c","#e67e22","#3498db","#e91e63","#607d8b"];
                                          return (
                                            <span key={tp} style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10, background: colors[i % colors.length] + "18", border: `0.5px solid ${colors[i % colors.length]}44`, color: colors[i % colors.length], fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 3 }}>
                                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: colors[i % colors.length], display: "inline-block" }} />
                                              {tp} · {pctEach}%
                                            </span>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                })()}
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: t.eta ? 6 : 0 }}>
                                  {t.eta
                                    ? <span style={{ fontSize: 10, color: etaColor(t.eta), fontWeight: 500 }}>📅 {formatEta(t.eta)}</span>
                                    : <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>No deadline</span>
                                  }
                                </div>
                                {/* Timeline progress bar — only shown when ETA is set */}
                                {t.eta && (() => {
                                  const created = new Date(t.createdAt || t.id);
                                  const due = new Date(t.eta);
                                  const now = new Date();
                                  const total = due - created;
                                  const elapsed = now - created;
                                  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((elapsed / total) * 100))) : 0;
                                  const barColor = pct >= 90 ? "#d44" : pct >= 70 ? "#f0a020" : "#4da6ff";
                                  return (
                                    <div>
                                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--color-text-secondary)", marginBottom: 2 }}>
                                        <span>Timeline</span>
                                        <span style={{ color: barColor, fontWeight: 600 }}>{pct}%</span>
                                      </div>
                                      <div style={{ background: "var(--color-background-secondary)", borderRadius: 3, height: 4, overflow: "hidden" }}>
                                        <div style={{ width: pct + "%", height: "100%", background: barColor, borderRadius: 3, transition: "width 0.4s" }} />
                                      </div>
                                    </div>
                                  );
                                })()}
                              </div>
                              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                                <button onClick={() => startEditTask(t)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, opacity: 0.5, padding: "2px 4px" }} title="Edit">✏️</button>
                                <button onClick={() => deleteTodo(t.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#d44", fontSize: 12, opacity: 0.5, padding: "2px 4px" }}>✕</button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))
                    }
                      </>
                    )}
                    {completedTodos.length > 0 && (
                      <>
                        <div style={{ padding: "6px 14px", fontSize: 11, color: "var(--color-text-secondary)", fontWeight: 500, background: "var(--color-background-secondary)", borderBottom: "0.5px solid var(--color-border-tertiary)", borderTop: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span>✅ COMPLETED ({completedTodos.length})</span>
                          <span style={{ fontSize: 10, color: "#1a6b3c" }}>↩ to reopen</span>
                        </div>
                        {completedTodos.map(t => {
                          const types = t.taskTypes && t.taskTypes.length > 0 ? t.taskTypes : (t.taskType ? [t.taskType] : []);
                          return (
                            <div key={t.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)" }}>
                              <button onClick={() => toggleTodo(t.id)} style={{ width: 18, height: 18, borderRadius: 4, border: "1.5px solid #1a6b3c", background: "#e8f5ee", cursor: "pointer", flexShrink: 0, marginTop: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#1a6b3c", fontSize: 10 }}>✓</button>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, textDecoration: "line-through", color: "var(--color-text-secondary)", wordBreak: "break-word", marginBottom: 3 }}>{t.text}</div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 2 }}>
                                  {types.map((tp, i) => {
                                    const colors = ["#1a6b3c","#4da6ff","#f0a020","#9b59b6","#e74c3c","#1abc9c","#e67e22","#3498db","#e91e63","#607d8b"];
                                    return (
                                      <span key={tp} style={{ fontSize: 9, padding: "1px 6px", borderRadius: 8, background: colors[i%colors.length]+"14", color: colors[i%colors.length], fontWeight: 600, opacity: 0.7 }}>{tp} · {Math.round(100/types.length)}%</span>
                                    );
                                  })}
                                  {t.eta && <span style={{ fontSize: 9, color: "var(--color-text-secondary)", opacity: 0.7 }}>📅 {formatEta(t.eta)}</span>}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                                <button onClick={() => toggleTodo(t.id)} style={{ background: "none", border: "0.5px solid #1a6b3c44", borderRadius: 5, cursor: "pointer", fontSize: 10, color: "#1a6b3c", padding: "2px 7px", fontWeight: 500 }} title="Reopen task">↩ Reopen</button>
                                <button onClick={() => deleteTodo(t.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#d44", fontSize: 12, opacity: 0.5, padding: "2px 4px" }}>✕</button>
                              </div>
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── FILES TAB ── */}
            {leftTab === "files" && (() => {
              return (
              <div>
                {filePreview && (
                  <div onClick={() => setFilePreview(null)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.78)", zIndex:9999, display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
                    <div onClick={e => e.stopPropagation()} style={{ background:"#fff", borderRadius:14, overflow:"hidden", maxWidth:"92vw", maxHeight:"92vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,0.4)", minWidth:340 }}>
                      <div style={{ padding:"10px 16px", borderBottom:"0.5px solid #e5e7eb", display:"flex", alignItems:"center", justifyContent:"space-between", background:"#f9fafb" }}>
                        <span style={{ fontWeight:600, fontSize:13, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:400 }}>{filePreview.name}</span>
                        <div style={{ display:"flex", gap:8, flexShrink:0, marginLeft:12 }}>
                          {filePreview.dataUrl && <a href={filePreview.dataUrl} download={filePreview.name} style={{ fontSize:12, color:"#1a6b3c", textDecoration:"none", padding:"3px 10px", border:"0.5px solid #1a6b3c", borderRadius:6 }}>⬇ Download</a>}
                          <button onClick={() => setFilePreview(null)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:20, color:"#6b7280", lineHeight:1 }}>✕</button>
                        </div>
                      </div>
                      <div style={{ overflow:"auto", flex:1, display:"flex", alignItems:"center", justifyContent:"center", padding:8 }}>
                        {filePreview.dataUrl?.startsWith("data:image")
                          ? <img src={filePreview.dataUrl} alt={filePreview.name} style={{ maxWidth:"82vw", maxHeight:"78vh", objectFit:"contain", borderRadius:6 }} />
                          : filePreview.dataUrl?.startsWith("data:application/pdf") || filePreview.type === "application/pdf"
                            ? <iframe src={filePreview.dataUrl} style={{ width:"82vw", height:"78vh", border:"none" }} title="Preview" />
                            : filePreview.dataUrl
                              ? <iframe src={filePreview.dataUrl} style={{ width:"82vw", height:"78vh", border:"none" }} title="Preview" />
                              : <div style={{ padding:40, textAlign:"center", color:"#6b7280" }}><div style={{ fontSize:48, marginBottom:12 }}>📄</div><div>No preview available</div></div>
                        }
                      </div>
                    </div>
                  </div>
                )}
                <div style={{ padding: "10px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "flex-end" }}>
                  <label style={{ background: "#1a6b3c", color: "#fff", borderRadius: 7, padding: "5px 14px", cursor: "pointer", fontSize: 12, fontWeight: 500 }}>
                    + Upload
                    <input type="file" multiple onChange={handleFileUpload} style={{ display: "none" }} />
                  </label>
                </div>
                {files.length === 0 ? (
                  <label style={{ display: "block", cursor: "pointer" }}>
                    <input type="file" multiple onChange={handleFileUpload} style={{ display: "none" }} />
                    <div style={{ padding: "2.5rem 1.5rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
                      <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
                      Drop files here or click to upload
                    </div>
                  </label>
                ) : (
                  <div style={{ padding: "0.5rem 0" }}>
                    {files.map(f => (
                      <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                        <div onClick={() => f.dataUrl && setFilePreview(f)} style={{ width: 36, height: 36, borderRadius: 6, overflow: "hidden", border: "0.5px solid var(--color-border-secondary)", cursor: f.dataUrl ? "pointer" : "default", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#f9fafb", fontSize: 20 }}>
                          {f.type?.startsWith("image/") && f.dataUrl
                            ? <img src={f.dataUrl} alt={f.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            : <span>{fileIcon(f.type)}</span>
                          }
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div onClick={() => f.dataUrl && setFilePreview(f)} style={{ fontSize: 13, fontWeight: 500, color: "#1a6b3c", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: f.dataUrl ? "pointer" : "default" }}>{f.name}</div>
                          <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{formatFileSize(f.size)}</div>
                        </div>
                        {f.dataUrl && (
                          <button onClick={() => setFilePreview(f)} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontSize: 11, color: "var(--color-text-secondary)", flexShrink: 0 }}>👁 Preview</button>
                        )}
                        <a href={f.dataUrl} download={f.name} style={{ background: "none", border: "0.5px solid #1a6b3c", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontSize: 11, color: "#1a6b3c", textDecoration: "none", flexShrink: 0 }}>⬇</a>
                        <button onClick={() => deleteFile(f.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#d44", fontSize: 14, flexShrink: 0, opacity: 0.6, padding: "2px 4px" }}>🗑</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              );
            })()}
            {/* ── NOTES TAB — Merged Note + MindMap + Undo/Redo ── */}
            {leftTab === "notes" && (() => {
              function makeDefaultMindmap() {
                return { nodes: [{ id: "root", label: "Central Idea", x: 300, y: 200, isRoot: true, color: "#ede9fe" }], edges: [] };
              }
              function addNote() {
                const note = {
                  id: Date.now(),
                  title: "Untitled Note",
                  content: "",
                  noteView: "text", // "text" | "map"
                  mindmap: makeDefaultMindmap(),
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  color: "#ffffff",
                };
                update(p => ({ projectsData: (p.projectsData || []).map(pr => pr.id === project.id
                  ? { ...pr, notes: [...(pr.notes || []), note] } : pr
                )}));
                setTimeout(() => setActiveNoteId(note.id), 0);
              }
              function updateNote(noteId, changes) {
                update(p => ({ projectsData: (p.projectsData || []).map(pr => pr.id === project.id
                  ? { ...pr, notes: (pr.notes || []).map(n => n.id === noteId ? { ...n, ...changes, updatedAt: new Date().toISOString() } : n) } : pr
                )}));
              }
              function deleteNote(noteId) {
                update(p => ({ projectsData: (p.projectsData || []).map(pr => pr.id === project.id
                  ? { ...pr, notes: (pr.notes || []).filter(n => n.id !== noteId) } : pr
                )}));
                if (activeNoteId === noteId) setActiveNoteId(null);
              }
              const activeNote = notes.find(n => n.id === activeNoteId) || null;
              const NOTE_COLORS = ["#ffffff", "#fef9c3", "#dcfce7", "#dbeafe", "#fce7f3", "#ede9fe", "#fee2e2", "#ffedd5"];
              return (
                <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
                  {/* LEFT sidebar */}
                  <div style={{ width: 200, flexShrink: 0, borderRight: "0.5px solid var(--color-border-tertiary)", display: "flex", flexDirection: "column" }}>
                    <div style={{ padding: "10px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>{notes.length} note{notes.length !== 1 ? "s" : ""}</span>
                      <button onClick={addNote} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 11, fontWeight: 500 }}>+ New</button>
                    </div>
                    <div style={{ flex: 1, overflowY: "auto" }}>
                      {notes.length === 0 ? (
                        <div style={{ padding: "2rem 1rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 12 }}>
                          <div style={{ fontSize: 28, marginBottom: 6 }}>📝</div>No notes yet
                        </div>
                      ) : notes.map(note => {
                        const isActive = activeNote && activeNote.id === note.id;
                        return (
                          <div key={note.id} onClick={() => setActiveNoteId(note.id)}
                            style={{ padding: "9px 12px", cursor: "pointer", borderBottom: "0.5px solid var(--color-border-tertiary)", background: isActive ? "#e8f5ee" : "transparent", borderLeft: isActive ? "3px solid #1a6b3c" : "3px solid transparent" }}>
                            <div style={{ fontSize: 13, fontWeight: isActive ? 600 : 400, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {note.title || "Untitled"}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* RIGHT — unified editor */}
                  {activeNote ? (
                    <MergedNoteEditor
                      key={activeNote.id}
                      note={activeNote}
                      updateNote={updateNote}
                      deleteNote={deleteNote}
                      onEsc={() => setActiveNoteId(null)}
                      NOTE_COLORS={NOTE_COLORS}
                      makeDefaultMindmap={makeDefaultMindmap}
                    />
                  ) : (
                    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)", flexDirection: "column", gap: 10 }}>
                      <div style={{ fontSize: 36 }}>📝</div>
                      <div style={{ fontSize: 13 }}>Select a note or create one</div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* RIGHT — Project summary / stats (hidden when viewing Notes) */}
          {leftTab !== "notes" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Summary card */}
            <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1.1rem 1.2rem" }}>
              <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 12 }}>Project Overview</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
                <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, padding: "0.8rem", textAlign: "center" }}>
                  <div style={{ fontSize: 22, fontWeight: 600, color: "#4da6ff" }}>{todos.length}</div>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>Total Tasks</div>
                </div>
                <div style={{ background: "#e8f5ee", borderRadius: 10, padding: "0.8rem", textAlign: "center" }}>
                  <div style={{ fontSize: 22, fontWeight: 600, color: "#1a6b3c" }}>{doneTodos}</div>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>Completed</div>
                </div>
                <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, padding: "0.8rem", textAlign: "center" }}>
                  <div style={{ fontSize: 22, fontWeight: 600, color: "var(--color-text-secondary)" }}>{files.length}</div>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>Files</div>
                </div>
              </div>
              {todos.length > 0 && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 5 }}>
                    <span>Progress</span>
                    <span style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>{Math.round(doneTodos / todos.length * 100)}%</span>
                  </div>
                  <div style={{ background: "var(--color-background-secondary)", borderRadius: 6, height: 8, overflow: "hidden" }}>
                    <div style={{ width: (doneTodos / todos.length * 100) + "%", height: "100%", background: doneTodos === todos.length ? "#1a6b3c" : "#4da6ff", borderRadius: 6, transition: "width 0.4s" }} />
                  </div>
                </div>
              )}
            </div>

            {/* Task type breakdown */}
            {todos.length > 0 && (() => {
              const typeMap = {};
              todos.forEach(t => { const k = t.taskType || "Other"; typeMap[k] = (typeMap[k] || 0) + 1; });
              const entries = Object.entries(typeMap).sort((a, b) => b[1] - a[1]);
              return entries.length > 1 ? (
                <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", overflow: "hidden" }}>
                  <div style={{ padding: "0.9rem 1.1rem", borderBottom: "0.5px solid var(--color-border-tertiary)", fontWeight: 500, fontSize: 14 }}>Tasks by Type</div>
                  <div style={{ padding: "0.6rem 1.1rem" }}>
                    {entries.map(([type, count]) => (
                      <div key={type} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                        <span style={{ fontSize: 12, color: "var(--color-text-secondary)", width: 90, flexShrink: 0 }}>{type}</span>
                        <div style={{ flex: 1, background: "var(--color-background-secondary)", borderRadius: 4, height: 6, overflow: "hidden" }}>
                          <div style={{ width: (count / todos.length * 100) + "%", height: "100%", background: "#4da6ff", borderRadius: 4 }} />
                        </div>
                        <span style={{ fontSize: 12, color: "var(--color-text-secondary)", width: 20, textAlign: "right" }}>{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null;
            })()}

            {/* ── DAY TRACKING ── */}
            {(() => {
              const todayStr = new Date().toISOString().split("T")[0];
              // Group dayLog entries by date
              const grouped = {};
              dayLog.forEach(e => {
                const d = e.date || todayStr;
                if (!grouped[d]) grouped[d] = [];
                grouped[d].push(e);
              });
              const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
              const doneDayEntries = (grouped[dayTrackDate] || []).filter(e => e.done).length;
              const totalDayEntries = (grouped[dayTrackDate] || []).length;

              return (
                <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", overflow: "hidden" }}>
                  {/* Header */}
                  <div style={{ padding: "0.9rem 1.1rem", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 500, fontSize: 14 }}>🗓 Day Tracking</span>
                    <input
                      type="date"
                      value={dayTrackDate}
                      onChange={e => setDayTrackDate(e.target.value)}
                      style={{ fontSize: 12, padding: "3px 8px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", cursor: "pointer" }}
                    />
                  </div>

                  {/* Date label */}
                  <div style={{ padding: "7px 14px", background: "var(--color-background-secondary)", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>
                      {dayTrackDate === todayStr ? "Today" : new Date(dayTrackDate + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", year: "numeric" })}
                    </span>
                    {totalDayEntries > 0 && (
                      <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{doneDayEntries}/{totalDayEntries} done</span>
                    )}
                  </div>

                  {/* Add entry input */}
                  <div style={{ padding: "10px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", gap: 8 }}>
                    <input
                      placeholder="What did you work on today?"
                      value={newDayEntry}
                      onChange={e => setNewDayEntry(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && addDayEntry()}
                      style={{ flex: 1, fontSize: 13, padding: "5px 8px", boxSizing: "border-box" }}
                    />
                    <button onClick={addDayEntry} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 7, padding: "5px 14px", cursor: "pointer", fontSize: 13, fontWeight: 500, whiteSpace: "nowrap" }}>+ Add</button>
                  </div>

                  {/* Entries for selected date */}
                  {(grouped[dayTrackDate] || []).length === 0 ? (
                    <div style={{ padding: "1.5rem", textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
                      No entries for this day yet.
                    </div>
                  ) : (
                    <div>
                      {(grouped[dayTrackDate] || []).filter(e => !e.done).map(e => (
                        <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                          <button onClick={() => toggleDayEntry(e.id)} style={{ width: 18, height: 18, borderRadius: 4, border: "1.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", flexShrink: 0 }} />
                          <span style={{ flex: 1, fontSize: 13 }}>{e.text}</span>
                          <button onClick={() => deleteDayEntry(e.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#d44", fontSize: 12, opacity: 0.5, padding: "0 2px" }}>✕</button>
                        </div>
                      ))}
                      {(grouped[dayTrackDate] || []).filter(e => e.done).map(e => (
                        <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", opacity: 0.55 }}>
                          <button onClick={() => toggleDayEntry(e.id)} style={{ width: 18, height: 18, borderRadius: 4, border: "1.5px solid #1a6b3c", background: "#e8f5ee", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#1a6b3c", fontSize: 10 }}>✓</button>
                          <span style={{ flex: 1, fontSize: 13, textDecoration: "line-through", color: "var(--color-text-secondary)" }}>{e.text}</span>
                          <button onClick={() => deleteDayEntry(e.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#d44", fontSize: 12, opacity: 0.5, padding: "0 2px" }}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Past days log */}
                  {sortedDates.filter(d => d !== dayTrackDate).length > 0 && (
                    <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                      <div style={{ padding: "6px 14px", fontSize: 11, color: "var(--color-text-secondary)", fontWeight: 500, background: "var(--color-background-secondary)" }}>PAST DAYS</div>
                      {sortedDates.filter(d => d !== dayTrackDate).slice(0, 5).map(d => {
                        const entries = grouped[d];
                        const done = entries.filter(e => e.done).length;
                        return (
                          <div key={d}
                            onClick={() => setDayTrackDate(d)}
                            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", cursor: "pointer" }}
                            onMouseEnter={e => e.currentTarget.style.background = "var(--color-background-secondary)"}
                            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                          >
                            <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                              {new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
                            </span>
                            <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{done}/{entries.length} done</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
          )}

        </div>
      )}
    </div>
  );
}

// ─── NoteBlock Component (OneNote-style) ─────────────────────────────────────
function NoteBlock({ note, onUpdate, onDelete, colors }) {
  const [editing, setEditing] = useState(!note.title && !note.content);
  const [localTitle, setLocalTitle] = useState(note.title || "");
  const [localContent, setLocalContent] = useState(note.content || "");
  const [showColors, setShowColors] = useState(false);
  const saveTimer = useRef(null);

  function triggerSave(title, content) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onUpdate(note.id, { title, content });
    }, 600);
  }

  const fmt = (iso) => {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div style={{ borderRadius: 10, border: "0.5px solid var(--color-border-secondary)", background: note.color || "#fff", overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
      {/* Note header */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: editing ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
        {editing ? (
          <input
            placeholder="Note title…"
            value={localTitle}
            onChange={e => { setLocalTitle(e.target.value); triggerSave(e.target.value, localContent); }}
            style={{ flex: 1, fontSize: 13, fontWeight: 600, border: "none", background: "transparent", outline: "none", color: "var(--color-text-primary)", padding: 0 }}
            autoFocus={!note.title && !note.content}
          />
        ) : (
          <div onClick={() => setEditing(true)} style={{ flex: 1, fontSize: 13, fontWeight: 600, cursor: "text", color: note.title ? "var(--color-text-primary)" : "var(--color-text-secondary)", fontStyle: note.title ? "normal" : "italic" }}>
            {note.title || "Untitled note"}
          </div>
        )}
        {/* Color picker */}
        <div style={{ position: "relative" }}>
          <button onClick={() => setShowColors(s => !s)} style={{ width: 16, height: 16, borderRadius: "50%", background: note.color || "#fff", border: "1px solid var(--color-border-secondary)", cursor: "pointer", flexShrink: 0 }} title="Note color" />
          {showColors && (
            <>
              <div onClick={() => setShowColors(false)} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
              <div style={{ position: "absolute", right: 0, top: 22, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: 6, zIndex: 100, display: "flex", gap: 5, flexWrap: "wrap", width: 114 }}>
                {colors.map(c => (
                  <button key={c} onClick={() => { onUpdate(note.id, { color: c }); setShowColors(false); }}
                    style={{ width: 20, height: 20, borderRadius: "50%", background: c, border: note.color === c ? "2px solid #1a6b3c" : "1px solid var(--color-border-secondary)", cursor: "pointer" }} />
                ))}
              </div>
            </>
          )}
        </div>
        {editing ? (
          <button onClick={() => setEditing(false)} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 5, padding: "2px 8px", cursor: "pointer", fontSize: 11, fontWeight: 500, whiteSpace: "nowrap" }}>Done</button>
        ) : (
          <button onClick={() => setEditing(true)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, opacity: 0.5, padding: "0 2px" }} title="Edit">✏️</button>
        )}
        <button onClick={() => onDelete(note.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#d44", fontSize: 12, opacity: 0.5, padding: "0 2px" }}>🗑</button>
      </div>
      {/* Note body */}
      {editing ? (
        <textarea
          placeholder="Write your note here… supports multiple lines, links, anything."
          value={localContent}
          onChange={e => { setLocalContent(e.target.value); triggerSave(localTitle, e.target.value); }}
          rows={5}
          style={{ width: "100%", boxSizing: "border-box", border: "none", background: "transparent", resize: "vertical", outline: "none", fontSize: 13, padding: "8px 10px", lineHeight: 1.6, fontFamily: "inherit", color: "var(--color-text-primary)" }}
        />
      ) : (
        note.content ? (
          <div onClick={() => setEditing(true)} style={{ padding: "8px 10px", fontSize: 13, color: "var(--color-text-primary)", lineHeight: 1.6, whiteSpace: "pre-wrap", cursor: "text", minHeight: 32 }}>{note.content}</div>
        ) : (
          <div onClick={() => setEditing(true)} style={{ padding: "8px 10px", fontSize: 12, color: "var(--color-text-secondary)", fontStyle: "italic", cursor: "text" }}>Click to add content…</div>
        )
      )}
      {/* Footer */}
      {note.updatedAt && (
        <div style={{ padding: "4px 10px 6px", fontSize: 10, color: "var(--color-text-secondary)", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
          Updated {fmt(note.updatedAt)}
        </div>
      )}
    </div>
  );
}

// ─── Canvas Sticky Note — draggable, editable, deletable ─────────────────────
function CanvasStickyNote({ note, pan, onUpdate, onDelete, onMoveEnd }) {
  const [dragging, setDragging] = useState(null);
  const [hovered, setHovered] = useState(false);
  const COLORS = ["#fef9c3","#dcfce7","#dbeafe","#fce7f3","#ede9fe","#fee2e2","#ffedd5","#f0fdf4"];

  function onMouseDown(e) {
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "BUTTON") return;
    e.stopPropagation();
    setDragging({ ox: e.clientX - note.x, oy: e.clientY - note.y, moved: false });
  }
  function onMouseMove(e) {
    if (!dragging) return;
    onUpdate(note.id, { x: e.clientX - dragging.ox, y: e.clientY - dragging.oy });
    setDragging(d => ({ ...d, moved: true }));
  }
  function onMouseUp() {
    if (dragging?.moved && onMoveEnd) onMoveEnd();
    setDragging(null);
  }

  return (
    <div
      data-nocanvas="1"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { onMouseUp(); setHovered(false); }}
      onMouseEnter={() => setHovered(true)}
      style={{
        position: "absolute",
        left: note.x + pan.x,
        top: note.y + pan.y,
        width: note.w || 200,
        zIndex: 8,
        cursor: dragging ? "grabbing" : "grab",
        background: note.color || "#fef9c3",
        borderRadius: 10,
        boxShadow: hovered ? "0 6px 20px rgba(0,0,0,0.18)" : "0 3px 12px rgba(0,0,0,0.10)",
        border: hovered ? "1.5px solid rgba(0,0,0,0.18)" : "1px solid rgba(0,0,0,0.07)",
        padding: "0 0 6px 0",
        display: "flex",
        flexDirection: "column",
        userSelect: "none",
        transition: "box-shadow 0.15s, border 0.15s",
      }}
    >
      {/* Top drag bar with color dots + delete */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px 4px", borderBottom: "1px solid rgba(0,0,0,0.06)", cursor: "grab" }}>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 9, color: "rgba(0,0,0,0.25)", marginRight: 2, letterSpacing: 1 }}>⠿</span>
          {COLORS.map(c => (
            <button key={c} onMouseDown={e => { e.stopPropagation(); onUpdate(note.id, { color: c }); }}
              style={{ width: 11, height: 11, borderRadius: "50%", background: c, border: note.color === c ? "2px solid #1a6b3c" : "1px solid rgba(0,0,0,0.18)", cursor: "pointer", padding: 0, flexShrink: 0 }} />
          ))}
        </div>
        {/* Delete button — always visible on hover, subtle otherwise */}
        <button
          onMouseDown={e => { e.stopPropagation(); onDelete(note.id); }}
          title="Delete sticky note"
          style={{
            background: hovered ? "#fee2e2" : "none",
            border: hovered ? "1px solid #fca5a5" : "none",
            borderRadius: 5, cursor: "pointer", fontSize: 11,
            color: "#d44", lineHeight: 1, padding: "2px 5px",
            fontWeight: 700, transition: "all 0.12s",
            opacity: hovered ? 1 : 0.35,
          }}>✕</button>
      </div>

      {/* Textarea */}
      <textarea
        id={"cninput-" + note.id}
        value={note.text}
        onChange={e => onUpdate(note.id, { text: e.target.value })}
        onMouseDown={e => e.stopPropagation()}
        onBlur={() => {
          // Auto-delete if note is empty and user clicks away
          if (!note.text.trim()) onDelete(note.id);
        }}
        placeholder="Type here… click ✕ to delete"
        rows={3}
        style={{
          background: "transparent", border: "none", outline: "none",
          resize: "none", fontSize: 12.5, lineHeight: 1.65,
          color: "#333", fontFamily: "inherit",
          width: "100%", boxSizing: "border-box",
          userSelect: "text", cursor: "text",
          padding: "7px 10px 2px",
          minHeight: 60,
        }}
        onInput={e => { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
      />

      {/* Resize handle bottom-right */}
      <div
        onMouseDown={e => {
          e.stopPropagation();
          const startX = e.clientX, startW = note.w || 200;
          function move(ev) { onUpdate(note.id, { w: Math.max(120, startW + ev.clientX - startX) }); }
          function up() { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); }
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }}
        style={{ alignSelf: "flex-end", cursor: "ew-resize", fontSize: 10, color: "rgba(0,0,0,0.22)", padding: "0 6px 2px", lineHeight: 1 }}
        title="Drag to resize">⟺</div>
    </div>
  );
}

// ─── Merged Note + MindMap Editor — Split view (Note left · Map right) ────────
// ─── Merged Note + MindMap Editor ────────────────────────────────────────────
function MergedNoteEditor({ note, updateNote, deleteNote, onEsc, NOTE_COLORS, makeDefaultMindmap }) {
  const MAX_HISTORY = 80;
  const NC  = ["#ede9fe","#dbeafe","#dcfce7","#fef9c3","#fce7f3","#fee2e2","#ffedd5","#f0fdf4"];

  // ── 1. ALL useState ──────────────────────────────────────────────────────
  const initMM = note.mindmap || makeDefaultMindmap();
  const [title,      setTitle]      = useState(note.title || "");
  const [nodes,      setNodes]      = useState(initMM.nodes);
  const [edges,      setEdges]      = useState(initMM.edges);
  const [textBlocks, setTextBlocks] = useState(note.textBlocks || []);
  const [collapsed,  setCollapsed]  = useState(new Set());
  const [histVer,    setHistVer]    = useState(0);
  const [selected,   setSelected]   = useState(null);
  const [editingId,  setEditingId]  = useState(null);
  const [editLabel,  setEditLabel]  = useState("");
  const [dragging,   setDragging]   = useState(null);
  const [pan,        setPan]        = useState({ x: 0, y: 0 });
  const [panStart,   setPanStart]   = useState(null);

  // ── 2. ALL useRef ────────────────────────────────────────────────────────
  const undoStack      = useRef([]);
  const redoStack      = useRef([]);
  const nodesRef       = useRef(nodes);
  const edgesRef       = useRef(edges);
  const textBlocksRef  = useRef(textBlocks);
  const saveTimer      = useRef(null);

  // ── 3. ALL useEffect ─────────────────────────────────────────────────────
  useEffect(() => { nodesRef.current      = nodes;      }, [nodes]);
  useEffect(() => { edgesRef.current      = edges;      }, [edges]);
  useEffect(() => { textBlocksRef.current = textBlocks; }, [textBlocks]);

  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      updateNote(note.id, { title, mindmap: { nodes, edges }, textBlocks });
    }, 600);
  }, [title, nodes, edges, textBlocks]); // eslint-disable-line

  useEffect(() => {
    function onKey(e) {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line

  // ── Undo / Redo ──────────────────────────────────────────────────────────
  function snap() {
    undoStack.current.push({
      nodes:      JSON.parse(JSON.stringify(nodesRef.current)),
      edges:      JSON.parse(JSON.stringify(edgesRef.current)),
      textBlocks: JSON.parse(JSON.stringify(textBlocksRef.current)),
    });
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = [];
    setHistVer(v => v + 1);
  }
  function undo() {
    if (!undoStack.current.length) return;
    redoStack.current.push({ nodes: JSON.parse(JSON.stringify(nodesRef.current)), edges: JSON.parse(JSON.stringify(edgesRef.current)), textBlocks: JSON.parse(JSON.stringify(textBlocksRef.current)) });
    const p = undoStack.current.pop();
    setNodes(p.nodes); setEdges(p.edges); setTextBlocks(p.textBlocks);
    setHistVer(v => v + 1);
  }
  function redo() {
    if (!redoStack.current.length) return;
    undoStack.current.push({ nodes: JSON.parse(JSON.stringify(nodesRef.current)), edges: JSON.parse(JSON.stringify(edgesRef.current)), textBlocks: JSON.parse(JSON.stringify(textBlocksRef.current)) });
    const nx = redoStack.current.pop();
    setNodes(nx.nodes); setEdges(nx.edges); setTextBlocks(nx.textBlocks);
    setHistVer(v => v + 1);
  }

  // ── Collapse ─────────────────────────────────────────────────────────────
  function getHidden(col) {
    const h = new Set(), q = [];
    col.forEach(id => edges.filter(e => e.from === id).forEach(e => q.push(e.to)));
    while (q.length) { const id = q.shift(); if (h.has(id)) continue; h.add(id); edges.filter(e => e.from === id).forEach(e => { if (!h.has(e.to)) q.push(e.to); }); }
    return h;
  }
  const hiddenSet    = getHidden(collapsed);
  const visibleNodes = nodes.filter(n => !hiddenSet.has(n.id));
  const visibleEdges = edges.filter(e => !hiddenSet.has(e.from) && !hiddenSet.has(e.to));

  // ── Map node actions ─────────────────────────────────────────────────────
  function addChild(parentId) {
    snap();
    const parent = nodes.find(n => n.id === parentId); if (!parent) return;
    const angles = edges.filter(e => e.from === parentId).map(e => { const c = nodes.find(n => n.id === e.to); return c ? Math.atan2(c.y - parent.y, c.x - parent.x) : null; }).filter(a => a !== null);
    const angle = angles.length ? Math.max(...angles) + 0.6 : 0;
    const id = "n" + Date.now();
    setCollapsed(s => { const ns = new Set(s); ns.delete(parentId); return ns; });
    setNodes(p => [...p, { id, label: "New node", x: parent.x + 180 * Math.cos(angle), y: parent.y + 180 * Math.sin(angle), color: NC[nodes.length % NC.length] }]);
    setEdges(p => [...p, { id: "e" + Date.now(), from: parentId, to: id }]);
    setTimeout(() => { setSelected(id); setEditingId(id); setEditLabel("New node"); }, 0);
  }
  function addRootNode() {
    snap();
    const id = "root" + Date.now();
    setNodes(p => [...p, { id, label: "Central Idea", x: 200 + Math.random() * 200 - pan.x, y: 150 + Math.random() * 100 - pan.y, isRoot: true, color: "#ede9fe" }]);
    setTimeout(() => { setSelected(id); setEditingId(id); setEditLabel("Central Idea"); }, 0);
  }
  function deleteNode(nodeId) {
    // Allow deleting any node that isn't the very last root node
    const rootNodes = nodes.filter(n => n.isRoot);
    if (nodeId === "root" && rootNodes.length <= 1) return; // don't delete the only root
    snap();
    const del = new Set(), q = [nodeId];
    while (q.length) { const id = q.shift(); del.add(id); edges.filter(e => e.from === id).forEach(e => q.push(e.to)); }
    setNodes(p => p.filter(n => !del.has(n.id))); setEdges(p => p.filter(e => !del.has(e.from) && !del.has(e.to))); setSelected(null);
  }
  function commitEdit() {
    if (!editingId) return; snap();
    setNodes(p => p.map(n => n.id === editingId ? { ...n, label: editLabel } : n)); setEditingId(null);
  }
  function changeNodeColor(nodeId, color) { snap(); setNodes(p => p.map(n => n.id === nodeId ? { ...n, color } : n)); }
  function toggleCollapse(nodeId) {
    if (!edges.some(e => e.from === nodeId)) return;
    setCollapsed(s => { const ns = new Set(s); ns.has(nodeId) ? ns.delete(nodeId) : ns.add(nodeId); return ns; });
  }

  // ── Text block actions ───────────────────────────────────────────────────
  // Each textBlock: { id, x, y, text, fontSize, bold, color }
  function addTextBlock(x, y) {
    snap();
    const id = "tb" + Date.now();
    setTextBlocks(p => [...p, { id, x, y, text: "Text", fontSize: 16, bold: false, color: "#1a1a2e" }]);
    setTimeout(() => { const el = document.getElementById("tb-" + id); if (el) { el.focus(); el.select(); } }, 50);
  }
  function addTextBlockCenter() {
    addTextBlock(320 - pan.x + Math.random() * 40, 180 - pan.y + Math.random() * 40);
  }
  function updateTextBlock(id, changes) { setTextBlocks(p => p.map(t => t.id === id ? { ...t, ...changes } : t)); }
  function deleteTextBlock(id) { snap(); setTextBlocks(p => p.filter(t => t.id !== id)); }

  // ── Drag / Pan ───────────────────────────────────────────────────────────
  function onNodeMouseDown(e, nodeId) {
    e.stopPropagation(); setSelected(nodeId);
    const node = nodes.find(n => n.id === nodeId);
    setDragging({ type: "node", nodeId, offsetX: e.clientX - node.x, offsetY: e.clientY - node.y, moved: false });
  }
  function onTextBlockMouseDown(e, tbId) {
    e.stopPropagation();
    const tb = textBlocks.find(t => t.id === tbId); if (!tb) return;
    setDragging({ type: "tb", id: tbId, offsetX: e.clientX - tb.x - pan.x, offsetY: e.clientY - tb.y - pan.y });
  }
  function onCanvasMouseDown(e) {
    if (editingId) { commitEdit(); return; }
    setSelected(null);
    setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  }
  function onCanvasDblClick(e) {
    let el = e.target;
    while (el && el !== e.currentTarget) { if (el.dataset?.nocanvas) return; el = el.parentElement; }
    const rect = e.currentTarget.getBoundingClientRect();
    addTextBlock(e.clientX - rect.left - pan.x, e.clientY - rect.top - pan.y);
  }
  function onMouseMove(e) {
    if (dragging?.type === "node") {
      setNodes(p => p.map(n => n.id === dragging.nodeId ? { ...n, x: e.clientX - dragging.offsetX, y: e.clientY - dragging.offsetY } : n));
      setDragging(d => ({ ...d, moved: true }));
    } else if (dragging?.type === "tb") {
      setTextBlocks(p => p.map(t => t.id === dragging.id ? { ...t, x: e.clientX - dragging.offsetX - pan.x, y: e.clientY - dragging.offsetY - pan.y } : t));
    } else if (panStart) {
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
    }
  }
  function onMouseUp() {
    if (dragging?.moved) snap();
    setDragging(null); setPanStart(null);
  }

  const selNode  = nodes.find(n => n.id === selected);
  const canUndo  = undoStack.current.length > 0;
  const canRedo  = redoStack.current.length > 0;
  const btn      = { border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: "3px 9px", cursor: "pointer", fontSize: 11, background: "none" };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>

      {/* ── Toolbar ── */}
      <div style={{ padding: "6px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.97)", flexShrink: 0, flexWrap: "wrap" }}>
        <button onClick={undo} disabled={!canUndo} title="Undo Ctrl+Z" style={{ ...btn, opacity: canUndo ? 1 : 0.3 }}>↩ Undo</button>
        <button onClick={redo} disabled={!canRedo} title="Redo Ctrl+Y" style={{ ...btn, opacity: canRedo ? 1 : 0.3 }}>↪ Redo</button>

        <div style={{ width: 1, height: 16, background: "var(--color-border-secondary)" }} />

        {/* ── TEXT button — replaces Note ── */}
        <button onClick={addTextBlockCenter} title="Add text anywhere on canvas (or double-click canvas)"
          style={{ ...btn, background: "#f0f4ff", border: "1.5px solid #6d28d9", color: "#4c1d95", fontWeight: 700, fontSize: 12, padding: "4px 11px", display: "flex", alignItems: "center", gap: 5 }}>
          T&nbsp; Text
        </button>

        <button onClick={addRootNode} title="Add a new Central Idea node"
          style={{ ...btn, background: "#ede9fe", border: "1.5px solid #7c3aed", color: "#5b21b6", fontWeight: 700, fontSize: 12, padding: "4px 11px", display: "flex", alignItems: "center", gap: 5 }}>
          ＋ Central Idea
        </button>

        <div style={{ width: 1, height: 16, background: "var(--color-border-secondary)" }} />

        {/* Canvas bg color dots */}
        {NOTE_COLORS.map(c => (
          <button key={c} onClick={() => updateNote(note.id, { color: c })}
            style={{ width: 13, height: 13, borderRadius: "50%", background: c, border: note.color === c ? "2px solid #1a6b3c" : "1px solid #ccc", cursor: "pointer", padding: 0 }} />
        ))}

        {/* Node selected actions */}
        {selNode && (<>
          <div style={{ width: 1, height: 16, background: "var(--color-border-secondary)" }} />
          <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>Node:</span>
          <button onClick={() => { setEditingId(selNode.id); setEditLabel(selNode.label); }} style={{ ...btn }}>✏️ Rename</button>
          {!selNode.isRoot && <button onClick={() => deleteNode(selected)} style={{ ...btn, color: "#d44", borderColor: "#d44" }}>🗑</button>}
          {selNode.isRoot && nodes.filter(n => n.isRoot).length > 1 && <button onClick={() => deleteNode(selected)} style={{ ...btn, color: "#d44", borderColor: "#d44" }}>🗑</button>}
          <div style={{ display: "flex", gap: 3 }}>
            {NC.map(c => <button key={c} onClick={() => changeNodeColor(selected, c)} style={{ width: 13, height: 13, borderRadius: "50%", background: c, border: selNode.color === c ? "2px solid #6d28d9" : "1px solid #ccc", cursor: "pointer", padding: 0 }} />)}
          </div>
        </>)}

        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button onClick={() => setPan({ x: 0, y: 0 })} style={{ ...btn, color: "var(--color-text-secondary)" }}>⊙ Reset</button>
          <button onClick={() => deleteNote(note.id)} style={{ ...btn, color: "#d44", borderColor: "#d44" }}>🗑 Delete note</button>
        </div>
      </div>

      {/* ── Canvas ── */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", position: "relative" }}>
        <div
          onMouseDown={onCanvasMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onDoubleClick={onCanvasDblClick}
          style={{ position: "relative", width: 2800, height: 2000, background: note.color || "#f0eff8", cursor: panStart ? "grabbing" : "default", userSelect: "none" }}
        >
          {/* SVG edges */}
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            <g transform={`translate(${pan.x},${pan.y})`}>
              {visibleEdges.map(edge => {
                const f = nodes.find(n => n.id === edge.from), t = nodes.find(n => n.id === edge.to);
                if (!f || !t) return null;
                const mx = (f.x + t.x) / 2;
                return <path key={edge.id} d={`M ${f.x} ${f.y} C ${mx} ${f.y} ${mx} ${t.y} ${t.x} ${t.y}`} stroke="#a78bfa" strokeWidth={1.5} fill="none" opacity={0.6} />;
              })}
            </g>
          </svg>

          {/* Mind-map nodes */}
          <div data-nocanvas="1" style={{ position: "absolute", inset: 0, transform: `translate(${pan.x}px,${pan.y}px)` }}>
            {visibleNodes.map(node => {
              const isSel    = selected === node.id;
              const hasKids  = edges.some(e => e.from === node.id);
              const isCol    = collapsed.has(node.id);
              const kidCount = edges.filter(e => e.from === node.id).length;
              const NW = 130, NH = 36;
              return (
                <div key={node.id} style={{ position: "absolute", left: node.x - NW/2, top: node.y - NH/2 }}>
                  <div onMouseDown={e => onNodeMouseDown(e, node.id)} onDoubleClick={() => { setEditingId(node.id); setEditLabel(node.label); }}
                    style={{ width: NW, minHeight: NH, background: node.color || "#ede9fe", border: isSel ? "2px solid #6d28d9" : "1.5px solid rgba(0,0,0,0.1)", borderRadius: node.isRoot ? 14 : 9, padding: "5px 12px", cursor: dragging?.nodeId === node.id ? "grabbing" : "grab", userSelect: "none", zIndex: isSel ? 10 : 2, boxShadow: isSel ? "0 3px 14px rgba(109,40,217,0.22)" : "0 1px 5px rgba(0,0,0,0.08)", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                    {editingId === node.id
                      ? <input autoFocus value={editLabel} onChange={e => setEditLabel(e.target.value)} onBlur={commitEdit} onKeyDown={e => (e.key==="Enter"||e.key==="Escape") && commitEdit()} onMouseDown={e => e.stopPropagation()} style={{ border:"none", outline:"none", background:"transparent", fontSize: node.isRoot?13:12, fontWeight: node.isRoot?700:500, width:"100%", fontFamily:"inherit", color:"#111", textAlign:"center" }} />
                      : <span style={{ fontSize: node.isRoot?13:12, fontWeight: node.isRoot?700:500, color:"#111", wordBreak:"break-word", textAlign:"center", lineHeight:1.35 }}>{node.label}</span>}
                  </div>
                  {/* + child */}
                  <div onMouseDown={e => { e.stopPropagation(); addChild(node.id); }} title="Add child"
                    style={{ position:"absolute", right:-11, top:"50%", transform:"translateY(-50%)", width:20, height:20, borderRadius:"50%", background:"#1a6b3c", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, fontWeight:700, cursor:"pointer", zIndex:20, boxShadow:"0 1px 4px rgba(0,0,0,0.18)", lineHeight:1 }}>+</div>
                  {hasKids && (
                    <div onMouseDown={e => { e.stopPropagation(); toggleCollapse(node.id); }} title={isCol ? `Show ${kidCount}` : "Collapse"}
                      style={{ position:"absolute", bottom:-11, left:"50%", transform:"translateX(-50%)", width:20, height:20, borderRadius:"50%", background: isCol?"#6d28d9":"#e5e7eb", color: isCol?"#fff":"#6b7280", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700, cursor:"pointer", zIndex:20, border:"1.5px solid "+(isCol?"#5b21b6":"#d1d5db") }}>
                      {isCol ? `+${kidCount}` : "−"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── Text blocks — plain draggable text ── */}
          {textBlocks.map(tb => (
            <div key={tb.id} data-nocanvas="1"
              style={{ position: "absolute", left: tb.x + pan.x, top: tb.y + pan.y, zIndex: 7, minWidth: 60 }}>
              {/* Drag strip + controls above text */}
              <div
                onMouseDown={e => onTextBlockMouseDown(e, tb.id)}
                style={{ height: 20, cursor: dragging?.id === tb.id ? "grabbing" : "grab", display: "flex", alignItems: "center", justifyContent: "space-between", paddingRight: 2, background: "rgba(109,40,217,0.07)", borderRadius: "4px 4px 0 0", paddingLeft: 4, borderBottom: "1px dashed rgba(109,40,217,0.2)" }}>
                {/* Formatting mini-bar */}
                <div style={{ display: "flex", gap: 3, alignItems: "center" }} onMouseDown={e => e.stopPropagation()}>
                  <button onClick={() => updateTextBlock(tb.id, { bold: !tb.bold })}
                    style={{ background: tb.bold ? "#6d28d9" : "none", border: "0.5px solid #ccc", borderRadius: 3, padding: "0 4px", fontSize: 10, fontWeight: 700, cursor: "pointer", color: tb.bold ? "#fff" : "#555", lineHeight: "13px" }}>B</button>
                  <select value={tb.fontSize || 16} onChange={e => updateTextBlock(tb.id, { fontSize: parseInt(e.target.value) })}
                    onMouseDown={e => e.stopPropagation()}
                    style={{ fontSize: 9, border: "0.5px solid #ccc", borderRadius: 3, padding: "0 2px", cursor: "pointer", background: "#fff", height: 14 }}>
                    {[10,12,14,16,18,20,24,28,32,40].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  {/* Color dots for text */}
                  {["#1a1a2e","#1a6b3c","#6d28d9","#d44","#d97706","#0ea5e9"].map(c => (
                    <button key={c} onMouseDown={e => e.stopPropagation()} onClick={() => updateTextBlock(tb.id, { color: c })}
                      style={{ width: 10, height: 10, borderRadius: "50%", background: c, border: tb.color===c?"2px solid #000":"1px solid rgba(0,0,0,0.2)", cursor: "pointer", padding: 0, flexShrink: 0 }} />
                  ))}
                </div>
                {/* Delete */}
                <button onMouseDown={e => e.stopPropagation()} onClick={() => deleteTextBlock(tb.id)}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#d44", padding: 0, lineHeight: 1, marginLeft: 4 }}>✕</button>
              </div>
              {/* The editable text */}
              <div
                id={"tb-" + tb.id}
                contentEditable
                suppressContentEditableWarning
                onBlur={e => updateTextBlock(tb.id, { text: e.currentTarget.innerText })}
                onMouseDown={e => e.stopPropagation()}
                style={{
                  fontSize: tb.fontSize || 16,
                  fontWeight: tb.bold ? 700 : 400,
                  color: tb.color || "#1a1a2e",
                  fontFamily: "inherit",
                  outline: "none",
                  minWidth: 40,
                  cursor: "text",
                  lineHeight: 1.4,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  padding: "1px 2px",
                  borderBottom: "1.5px dashed rgba(109,40,217,0.25)",
                }}
                dangerouslySetInnerHTML={{ __html: tb.text }}
              />
            </div>
          ))}

          {/* Canvas hint */}
          <div style={{ position:"absolute", bottom:10, right:14, fontSize:10, color:"#c0bedd", pointerEvents:"none", textAlign:"right", lineHeight:1.7 }}>
            <b style={{color:"#6d28d9"}}>T Text</b> in toolbar or <b>double-click</b> empty space to add text<br/>
            <span style={{color:"#7c3aed"}}>＋ Central Idea</span> = add new idea · <span style={{color:"#a78bfa"}}>+</span> = add child · drag purple bar = move text
          </div>
        </div>
      </div>

      {/* Note title bar at bottom */}
      <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", flexShrink: 0, padding: "8px 16px" }}>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Note title…"
          style={{ display:"block", width:"100%", boxSizing:"border-box", border:"none", outline:"none", background:"transparent", fontSize:14, fontWeight:600, fontFamily:"inherit", color:"var(--color-text-primary)" }} />
      </div>
    </div>
  );
}

// ─── DraggableList — drag-to-reorder rows with a ⠿ handle ───────────────────
function DraggableList({ items, onReorder, renderItem, keyFn }) {
  const dragIdx = useRef(null);
  const [dragOver, setDragOver] = useState(null);

  function onDragStart(e, i) {
    dragIdx.current = i;
    e.dataTransfer.effectAllowed = "move";
    // Ghost image: use the row itself
    e.dataTransfer.setDragImage(e.currentTarget, 20, 20);
  }
  function onDragOver(e, i) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (i !== dragOver) setDragOver(i);
  }
  function onDrop(e, i) {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === i) { cleanup(); return; }
    const next = [...items];
    const [moved] = next.splice(dragIdx.current, 1);
    next.splice(i, 0, moved);
    onReorder(next);
    cleanup();
  }
  function cleanup() { dragIdx.current = null; setDragOver(null); }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((item, i) => (
        <div key={keyFn(item)}
          draggable
          onDragStart={e => onDragStart(e, i)}
          onDragOver={e => onDragOver(e, i)}
          onDrop={e => onDrop(e, i)}
          onDragEnd={cleanup}
          style={{ display: "flex", alignItems: "center", gap: 8, borderRadius: 8,
            background: dragOver === i ? "#e8f5ee" : "var(--color-background-secondary)",
            border: dragOver === i ? "1.5px dashed #1a6b3c" : "0.5px solid var(--color-border-tertiary)",
            transition: "background 0.12s, border 0.12s", cursor: "default", userSelect: "none" }}>
          {/* Drag handle */}
          <div style={{ padding: "0 4px 0 10px", color: "#bbb", fontSize: 16, cursor: "grab", flexShrink: 0, lineHeight: 1 }}
            title="Drag to reorder">⠿</div>
          {/* Row content fills the rest */}
          <div style={{ flex: 1, minWidth: 0 }}>{renderItem(item, i)}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Shared Components ────────────────────────────────────────────────────────
function StatCard({ label, value, sub, icon, danger, pnl, big, accent }) {
  const color = pnl !== undefined ? (pnl >= 0 ? "#1a6b3c" : "#d44") : danger ? "#d44" : "var(--color-text-primary)";
  return (
    <div style={{ background: accent ? "#e8f5ee" : "var(--color-background-secondary)", borderRadius: 12, padding: big ? "1.2rem" : "0.9rem", border: "0.5px solid var(--color-border-tertiary)" }}>
      {icon && <div style={{ fontSize: 14, color: "#1a6b3c", marginBottom: 4 }}>{icon}</div>}
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: big ? 28 : 18, fontWeight: 500, color, fontFamily: big ? "'DM Serif Display', serif" : "inherit" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function Card({ title, children, action }) {
  return (
    <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, borderBottom: "0.5px solid var(--color-border-tertiary)", paddingBottom: 10 }}>
        <span style={{ fontWeight: 500, fontSize: 15 }}>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

function TabBar({ tabs, active, setActive, labels }) {
  return (
    <div style={{ display: "flex", borderBottom: "0.5px solid var(--color-border-tertiary)", marginBottom: 4 }}>
      {tabs.map((t, i) => (
        <button key={t} onClick={() => setActive(t)} style={{ padding: "8px 16px", background: "none", border: "none", cursor: "pointer", fontSize: 14, color: active === t ? "var(--color-text-primary)" : "var(--color-text-secondary)", fontWeight: active === t ? 500 : 400, borderBottom: active === t ? "2px solid #1a6b3c" : "2px solid transparent", marginBottom: -1 }}>
          {labels ? labels[i] : t}
        </button>
      ))}
    </div>
  );
}

function PeriodBar({ periods, active, setActive }) {
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
      {periods.map(p => (
        <button key={p} onClick={() => setActive(p)} style={{ padding: "4px 12px", borderRadius: 6, border: "0.5px solid", borderColor: active === p ? "#1a6b3c" : "var(--color-border-secondary)", background: active === p ? "#1a6b3c" : "transparent", color: active === p ? "#fff" : "var(--color-text-secondary)", fontSize: 12, cursor: "pointer" }}>{p}</button>
      ))}
    </div>
  );
}

function LabelInput({ label, placeholder, value, onChange, type = "text" }) {
  return (
    <div style={{ marginBottom: 10 }}>
      {label && <label style={{ display: "block", fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>{label}</label>}
      <input type={type} placeholder={placeholder} value={value || ""} onChange={e => onChange(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} />
    </div>
  );
}

function GreenBtn({ onClick, label }) {
  return <button onClick={onClick} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 500, marginTop: 6 }}>{label}</button>;
}

function GoogleBtn({ onClick, disabled, label }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "10px", border: "0.5px solid var(--color-border-secondary)", borderRadius: 10, background: disabled ? "var(--color-background-secondary)" : "var(--color-background-primary)", cursor: disabled ? "not-allowed" : "pointer", fontSize: 14, fontWeight: 500, color: "var(--color-text-primary)", opacity: disabled ? 0.7 : 1 }}>
      <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
      {label || "Continue with Google"}
    </button>
  );
}

function Tabs({ tabs, active, setActive }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {tabs.map(t => <button key={t} onClick={() => setActive(t)} style={{ padding: "2px 8px", background: "none", border: "none", cursor: "pointer", fontSize: 12, color: active === t ? "#1a6b3c" : "var(--color-text-secondary)" }}>{t}</button>)}
    </div>
  );
}

function HealthBar({ label, value, target, invert, unit, hint }) {
  const good = invert ? value <= target : value >= target;
  const color = good ? "#1a6b3c" : value > (invert ? target * 1.2 : target * 0.5) ? "#f0a020" : "#d44";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
        <span>{label}</span>
        <span style={{ color, fontWeight: 500 }}>{value?.toFixed(1)}{unit}</span>
      </div>
      <div style={{ background: "var(--color-background-secondary)", borderRadius: 4, height: 6, overflow: "hidden" }}>
        <div style={{ width: Math.min(value, 100) + "%", height: "100%", background: color, borderRadius: 4, transition: "width 0.5s" }} />
      </div>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{hint}</div>
    </div>
  );
}

function EmptyState({ msg }) {
  return <p style={{ color: "var(--color-text-secondary)", fontSize: 13, textAlign: "center", padding: "1.5rem 0" }}>{msg}</p>;
}

function ThreeDotMenu({ onEdit, onDelete }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "var(--color-text-secondary)", padding: "2px 6px", borderRadius: 4, lineHeight: 1 }}
      >⋮</button>
      {open && (
        <>
          {/* backdrop to close */}
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 199 }} />
          <div style={{ position: "absolute", right: 0, top: "100%", background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", zIndex: 200, minWidth: 110, overflow: "hidden" }}>
            <button onClick={() => { setOpen(false); onEdit(); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 14px", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "var(--color-text-primary)" }}>✏️ Edit</button>
            <button onClick={() => { setOpen(false); onDelete(); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 14px", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "#d44" }}>🗑 Delete</button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().split("T")[0]; }

function isThisMonth(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr), now = new Date();
  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

function filterByPeriod(dateStr, period) {
  if (!dateStr) return false;
  const d = new Date(dateStr), now = new Date();
  if (period === "This Week") { const w = new Date(now); w.setDate(now.getDate() - 7); return d >= w; }
  if (period === "This Month") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  if (period === "Last Month") { const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1); return d.getMonth() === lm.getMonth() && d.getFullYear() === lm.getFullYear(); }
  if (period === "6M") { const s = new Date(now); s.setMonth(now.getMonth() - 6); return d >= s; }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NSE STOCK DATABASE — symbol → company name (top ~200 stocks)
// ═══════════════════════════════════════════════════════════════════════════════
const NSE_STOCKS = [
  ["RELIANCE","Reliance Industries Ltd"],["TCS","Tata Consultancy Services"],["HDFCBANK","HDFC Bank Ltd"],
  ["INFY","Infosys Ltd"],["ICICIBANK","ICICI Bank Ltd"],["HINDUNILVR","Hindustan Unilever Ltd"],
  ["ITC","ITC Ltd"],["SBIN","State Bank of India"],["BHARTIARTL","Bharti Airtel Ltd"],
  ["KOTAKBANK","Kotak Mahindra Bank Ltd"],["LT","Larsen & Toubro Ltd"],["HCLTECH","HCL Technologies Ltd"],
  ["AXISBANK","Axis Bank Ltd"],["ASIANPAINT","Asian Paints Ltd"],["MARUTI","Maruti Suzuki India Ltd"],
  ["SUNPHARMA","Sun Pharmaceutical Industries"],["TITAN","Titan Company Ltd"],["BAJFINANCE","Bajaj Finance Ltd"],
  ["WIPRO","Wipro Ltd"],["ULTRACEMCO","UltraTech Cement Ltd"],["ONGC","Oil & Natural Gas Corp"],
  ["NTPC","NTPC Ltd"],["POWERGRID","Power Grid Corp of India"],["TECHM","Tech Mahindra Ltd"],
  ["NESTLEIND","Nestle India Ltd"],["ADANIENT","Adani Enterprises Ltd"],["ADANIPORTS","Adani Ports & SEZ Ltd"],
  ["JSWSTEEL","JSW Steel Ltd"],["TATASTEEL","Tata Steel Ltd"],["COALINDIA","Coal India Ltd"],
  ["DRREDDY","Dr Reddy's Laboratories"],["DIVISLAB","Divi's Laboratories"],["CIPLA","Cipla Ltd"],
  ["HINDALCO","Hindalco Industries Ltd"],["GRASIM","Grasim Industries Ltd"],["BAJAJFINSV","Bajaj Finserv Ltd"],
  ["EICHERMOT","Eicher Motors Ltd"],["HEROMOTOCO","Hero MotoCorp Ltd"],["BPCL","Bharat Petroleum Corp"],
  ["TATAMOTORS","Tata Motors Ltd"],["M&M","Mahindra & Mahindra Ltd"],["INDUSINDBK","IndusInd Bank Ltd"],
  ["BRITANNIA","Britannia Industries Ltd"],["APOLLOHOSP","Apollo Hospitals Enterprise"],
  ["SBILIFE","SBI Life Insurance Co"],["HDFCLIFE","HDFC Life Insurance Co"],["BAJAJ-AUTO","Bajaj Auto Ltd"],
  ["TATACONSUM","Tata Consumer Products Ltd"],["UPL","UPL Ltd"],["SHREECEM","Shree Cement Ltd"],
  ["PIDILITIND","Pidilite Industries Ltd"],["DMART","Avenue Supermarts Ltd"],["MUTHOOTFIN","Muthoot Finance Ltd"],
  ["HAVELLS","Havells India Ltd"],["VOLTAS","Voltas Ltd"],["BERGEPAINT","Berger Paints India Ltd"],
  ["GODREJCP","Godrej Consumer Products"],["DABUR","Dabur India Ltd"],["MARICO","Marico Ltd"],
  ["COLPAL","Colgate-Palmolive (India)"],["AMBUJACEM","Ambuja Cements Ltd"],["ACC","ACC Ltd"],
  ["INDIGO","InterGlobe Aviation Ltd"],["ZOMATO","Zomato Ltd"],["NYKAA","FSN E-Commerce Ventures"],
  ["PAYTM","One 97 Communications"],["POLICYBZR","PB Fintech Ltd"],["DELHIVERY","Delhivery Ltd"],
  ["TATAPOWER","Tata Power Co Ltd"],["ADANIGREEN","Adani Green Energy Ltd"],["ADANITRANS","Adani Transmission Ltd"],
  ["ADANIPOWER","Adani Power Ltd"],["ADANIWILMAR","Adani Wilmar Ltd"],["SIEMENS","Siemens Ltd"],
  ["ABB","ABB India Ltd"],["BOSCHLTD","Bosch Ltd"],["MCDOWELL-N","United Spirits Ltd"],
  ["TATAELXSI","Tata Elxsi Ltd"],["COFORGE","Coforge Ltd"],["MPHASIS","Mphasis Ltd"],
  ["LTIM","LTIMindtree Ltd"],["PERSISTENT","Persistent Systems Ltd"],["OFSS","Oracle Financial Services"],
  ["KPITTECH","KPIT Technologies Ltd"],["IRCTC","Indian Railway Catering & Tourism"],
  ["ZYDUSLIFE","Zydus Lifesciences Ltd"],["TORNTPHARM","Torrent Pharmaceuticals"],
  ["AUROPHARMA","Aurobindo Pharma Ltd"],["LUPIN","Lupin Ltd"],["BIOCON","Biocon Ltd"],
  ["GLAND","Gland Pharma Ltd"],["ALKEM","Alkem Laboratories Ltd"],["IPCALAB","IPCA Laboratories"],
  ["BANKBARODA","Bank of Baroda"],["PNB","Punjab National Bank"],["CANBK","Canara Bank"],
  ["FEDERALBNK","Federal Bank Ltd"],["RBLBANK","RBL Bank Ltd"],["BANDHANBNK","Bandhan Bank Ltd"],
  ["IDFCFIRSTB","IDFC First Bank Ltd"],["AUBANK","AU Small Finance Bank"],
  ["CHOLAFIN","Cholamandalam Investment"],["SHRIRAMFIN","Shriram Finance Ltd"],["LICHSGFIN","LIC Housing Finance Ltd"],
  ["PNBHOUSING","PNB Housing Finance Ltd"],["MANAPPURAM","Manappuram Finance Ltd"],
  ["M&MFIN","Mahindra & Mahindra Financial"],["RECLTD","REC Ltd"],["PFC","Power Finance Corp"],
  ["IRFC","Indian Railway Finance Corp"],["HUDCO","Housing & Urban Dev Corp"],
  ["DLF","DLF Ltd"],["GODREJPROP","Godrej Properties Ltd"],["OBEROIRLTY","Oberoi Realty Ltd"],
  ["PRESTIGE","Prestige Estates Projects"],["PHOENIXLTD","Phoenix Mills Ltd"],
  ["ZEEL","Zee Entertainment Enterprises"],["SUNTV","Sun TV Network Ltd"],["PVRINOX","PVR INOX Ltd"],
  ["JUBLFOOD","Jubilant FoodWorks Ltd"],["DEVYANI","Devyani International Ltd"],
  ["WESTLIFE","Westlife Foodworld Ltd"],["SAPPHIRE","Sapphire Foods India Ltd"],
  ["VEDL","Vedanta Ltd"],["NMDC","NMDC Ltd"],["SAIL","Steel Authority of India"],
  ["JINDALSTEL","Jindal Steel & Power Ltd"],["JSWENERGY","JSW Energy Ltd"],
  ["TORNTPOWER","Torrent Power Ltd"],["CESC","CESC Ltd"],["NHPC","NHPC Ltd"],["SJVN","SJVN Ltd"],
  ["GAIL","GAIL (India) Ltd"],["IOC","Indian Oil Corp"],["HPCL","Hindustan Petroleum Corp"],
  ["MRF","MRF Ltd"],["APOLLOTYRE","Apollo Tyres Ltd"],["CEAT","CEAT Ltd"],["BALKRISIND","Balkrishna Industries"],
  ["MOTHERSON","Samvardhana Motherson Intl"],["BHARATFORG","Bharat Forge Ltd"],["SUNDRMFAST","Sundram Fasteners Ltd"],
  ["ENDURANCE","Endurance Technologies"],["SWARAJENG","Swaraj Engines Ltd"],
  ["PAGEIND","Page Industries Ltd"],["KALYANKJIL","Kalyan Jewellers India"],
  ["RAJESHEXPO","Rajesh Exports Ltd"],["TRIBHOVANDAS","Tribhovandas Bhimji Zaveri"],
  ["TRENT","Trent Ltd"],["ABFRL","Aditya Birla Fashion & Retail"],["SHOPERSTOP","Shopper's Stop Ltd"],
  ["VBL","Varun Beverages Ltd"],["RADICO","Radico Khaitan Ltd"],["UBL","United Breweries Ltd"],
  ["GLAXO","GlaxoSmithKline Pharmaceuticals"],["PFIZER","Pfizer Ltd"],["ABBOTINDIA","Abbott India Ltd"],
  ["SANOFI","Sanofi India Ltd"],["3MINDIA","3M India Ltd"],["HONAUT","Honeywell Automation India"],
  ["CUMMINSIND","Cummins India Ltd"],["THERMAX","Thermax Ltd"],["AIAENG","AIA Engineering Ltd"],
  ["GRINDWELL","Grindwell Norton Ltd"],["CARBORUNIV","Carborundum Universal Ltd"],
  ["ASTRAL","Astral Ltd"],["SUPREMEIND","Supreme Industries Ltd"],["FINOLEX","Finolex Cables Ltd"],
  ["POLYCAB","Polycab India Ltd"],["KEI","KEI Industries Ltd"],
  ["DIXON","Dixon Technologies India"],["AMBER","Amber Enterprises India"],
  ["BLUESTARCO","Blue Star Ltd"],["WHIRLPOOL","Whirlpool of India Ltd"],
  ["BATAINDIA","Bata India Ltd"],["VIPIND","VIP Industries Ltd"],
  ["ICICIlombard","ICICI Lombard General Insurance"],["STARHEALTH","Star Health & Allied Insurance"],
  ["GICRE","General Insurance Corp of India"],["NIACL","New India Assurance Co"],
  ["CDSL","Central Depository Services"],["BSE","BSE Ltd"],["MCX","Multi Commodity Exchange"],
  ["CAMS","Computer Age Management Services"],["ANGELONE","Angel One Ltd"],["ICICIPRULI","ICICI Prudential Life Insurance"],
  ["ICICIGI","ICICI Lombard General Insurance"],["360ONE","360 One WAM Ltd"],
  ["LICI","Life Insurance Corp of India"],["PGHH","Procter & Gamble Hygiene"],
  ["HINDPETRO","Hindustan Petroleum Corp"],["CONCOR","Container Corp of India"],
  ["GMRINFRA","GMR Airports Infrastructure"],["IRB","IRB Infrastructure Developers"],
  ["ASHOKA","Ashoka Buildcon Ltd"],["KNR","KNR Constructions Ltd"],
  ["NCC","NCC Ltd"],["NBCC","NBCC (India) Ltd"],
];

// Build lookup maps
const NSE_BY_SYMBOL = Object.fromEntries(NSE_STOCKS.map(([s,n]) => [s, n]));
const NSE_SEARCH = NSE_STOCKS.map(([symbol, name]) => ({ symbol, name, lower: symbol.toLowerCase() + " " + name.toLowerCase() }));

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO PAGE — CORS-safe prices via corsproxy.io + stock autocomplete
// ═══════════════════════════════════════════════════════════════════════════════
function PortfolioPage({ data, update }) {
  const holdings = data.portfolioHoldings || [];

  // ── local UI state ──────────────────────────────────────────────────────────
  const [form, setForm]         = useState({ symbol: "", name: "", buyPrice: "", qty: "", exchange: "NSE" });
  const [editId, setEditId]     = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [prices, setPrices]     = useState({});
  const [loading, setLoading]   = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [priceError, setPriceError]   = useState("");
  const [sortBy, setSortBy]     = useState("symbol");
  // Autocomplete state
  const [acResults, setAcResults]   = useState([]);
  const [acOpen, setAcOpen]         = useState(false);
  const acRef = useRef(null);

  // ── ticker helper ───────────────────────────────────────────────────────────
  function toYahooTicker(symbol, exchange) {
    const s = symbol.trim().toUpperCase();
    if (exchange === "NSE") return s + ".NS";
    if (exchange === "BSE") return s + ".BO";
    return s;
  }

  // ── Auto-merge duplicate symbol+exchange into weighted avg — MUST be before useEffect ──
  const mergedHoldings = useMemo(() => {
    const map = new Map();
    holdings.forEach(h => {
      const key = `${h.symbol.trim().toUpperCase()}|${h.exchange || "NSE"}`;
      if (!map.has(key)) {
        map.set(key, { ...h, _ids: [h.id], _merged: false, _originalCount: 1 });
      } else {
        const existing = map.get(key);
        const totalQty = existing.qty + h.qty;
        const avgPrice = ((existing.buyPrice * existing.qty) + (h.buyPrice * h.qty)) / totalQty;
        map.set(key, {
          ...existing,
          qty: totalQty,
          buyPrice: Math.round(avgPrice * 100) / 100,
          _ids: [...existing._ids, h.id],
          _merged: true,
          _originalCount: existing._originalCount + 1,
        });
      }
    });
    return Array.from(map.values());
  }, [holdings]); // eslint-disable-line

  // ── CORS-safe price fetch ────────────────────────────────────────────────────
  const fetchPrices = useCallback(async (holdingsList) => {
    if (!holdingsList || holdingsList.length === 0) return;
    setLoading(true);
    setPriceError("");
    const tickers = [...new Set(holdingsList.map(h => toYahooTicker(h.symbol, h.exchange)))];
    try {
      const res = await fetch(`/api/stock-price?ticker=${tickers.map(encodeURIComponent).join(",")}`);
      if (!res.ok) throw new Error("API error " + res.status);
      const data = await res.json();
      setPrices(data);
      const failed = Object.values(data).filter(r => !r.ok).length;
      if (failed > 0) setPriceError(`${failed} ticker(s) could not be fetched — check symbol spelling.`);
      else setPriceError("");
    } catch (e) {
      setPriceError("Could not reach price API — try refreshing.");
    }
    setLastRefresh(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }));
    setLoading(false);
  }, []); // eslint-disable-line

  useEffect(() => {
    if (mergedHoldings.length > 0) fetchPrices(mergedHoldings);
  }, [holdings.length]); // eslint-disable-line

  // ── autocomplete logic ──────────────────────────────────────────────────────
  function handleSymbolInput(raw) {
    const val = raw.toUpperCase();
    setForm(f => ({ ...f, symbol: val }));
    if (val.length < 1) { setAcResults([]); setAcOpen(false); return; }
    const q = val.toLowerCase();
    const matches = NSE_SEARCH.filter(s => s.lower.includes(q)).slice(0, 8);
    setAcResults(matches);
    setAcOpen(matches.length > 0);
  }

  function selectAcStock(stock) {
    setForm(f => ({ ...f, symbol: stock.symbol, name: stock.name, exchange: "NSE" }));
    setAcResults([]);
    setAcOpen(false);
  }

  // Close autocomplete on outside click
  useEffect(() => {
    function handler(e) { if (acRef.current && !acRef.current.contains(e.target)) setAcOpen(false); }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── form helpers ────────────────────────────────────────────────────────────
  function openAdd()  { setForm({ symbol: "", name: "", buyPrice: "", qty: "", exchange: "NSE" }); setEditId(null); setShowForm(true); setAcOpen(false); }
  function openEdit(h){ setForm({ symbol: h.symbol, name: h.name || "", buyPrice: String(h.buyPrice), qty: String(h.qty), exchange: h.exchange || "NSE" }); setEditId(h.id); setShowForm(true); }
  function closeForm(){ setShowForm(false); setEditId(null); setAcOpen(false); }

  function saveHolding() {
    const sym = form.symbol.trim().toUpperCase();
    if (!sym || !form.buyPrice || !form.qty) return;
    // Auto-fill name from NSE db if blank
    const resolvedName = form.name.trim() || NSE_BY_SYMBOL[sym] || sym;
    const newH = { id: editId || Date.now(), symbol: sym, name: resolvedName, buyPrice: Number(form.buyPrice), qty: Number(form.qty), exchange: form.exchange, addedAt: editId ? undefined : today() };
    if (editId) {
      update(p => ({ portfolioHoldings: (p.portfolioHoldings || []).map(h => h.id === editId ? { ...h, ...newH } : h) }));
    } else {
      update(p => ({ portfolioHoldings: [...(p.portfolioHoldings || []), newH] }));
    }
    closeForm();
    setTimeout(() => {
      const updated = editId
        ? holdings.map(h => h.id === editId ? { ...h, ...newH } : h)
        : [...holdings, newH];
      // Re-compute merged before fetching
      const map = new Map();
      updated.forEach(h => {
        const key = `${h.symbol.trim().toUpperCase()}|${h.exchange || "NSE"}`;
        if (!map.has(key)) map.set(key, h);
        else {
          const e = map.get(key);
          const tq = e.qty + h.qty;
          map.set(key, { ...e, qty: tq, buyPrice: ((e.buyPrice*e.qty)+(h.buyPrice*h.qty))/tq });
        }
      });
      fetchPrices(Array.from(map.values()));
    }, 300);
  }

  function deleteHolding(id) { update(p => ({ portfolioHoldings: (p.portfolioHoldings || []).filter(h => h.id !== id) })); }

  // ── enriched rows using mergedHoldings ──────────────────────────────────────
  const rows = mergedHoldings.map(h => {
    const ticker   = toYahooTicker(h.symbol, h.exchange);
    const pd       = prices[ticker] || {};
    const cur      = pd.price ?? null;
    const invested = h.buyPrice * h.qty;
    const curVal   = cur != null ? cur * h.qty : null;
    const pnl      = curVal != null ? curVal - invested : null;
    const pnlPct   = pnl != null ? (pnl / invested) * 100 : null;
    return { ...h, ticker, cur, invested, curVal, pnl, pnlPct, dayChange: pd.change ?? null, dayChangePct: pd.changePct ?? null, fetchFailed: pd.ok === false };
  });

  const sorted = [...rows].sort((a, b) => {
    if (sortBy === "pnl")   return (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity);
    if (sortBy === "value") return (b.curVal ?? -Infinity) - (a.curVal ?? -Infinity);
    if (sortBy === "pct")   return (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity);
    return a.symbol.localeCompare(b.symbol);
  });

  const totalInvested = rows.reduce((s, r) => s + r.invested, 0);
  const totalCurVal   = rows.filter(r => r.curVal != null).reduce((s, r) => s + r.curVal, 0);
  const totalPnl      = rows.filter(r => r.pnl != null).reduce((s, r) => s + r.pnl, 0);
  const totalPnlPct   = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
  const dayPnl        = rows.filter(r => r.dayChange != null).reduce((s, r) => s + r.dayChange * r.qty, 0);

  const pnlColor = (v) => v == null ? "var(--color-text-secondary)" : v >= 0 ? "#1a6b3c" : "#d44";

  return (
    <div style={{ maxWidth: 960, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontFamily: "'DM Serif Display', serif", fontSize: 24 }}>Portfolio</h2>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
            {lastRefresh ? `Prices updated at ${lastRefresh}` : "Add your demat holdings to get started"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => fetchPrices(mergedHoldings)} disabled={loading || mergedHoldings.length === 0}
            style={{ padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: 6, opacity: loading ? 0.6 : 1 }}>
            <span style={{ display: "inline-block", animation: loading ? "spin 1s linear infinite" : "none" }}>↻</span>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button onClick={openAdd}
            style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "7px 16px", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>
            + Add Stock
          </button>
        </div>
      </div>

      {/* Summary cards */}
      {holdings.length > 0 && (
        <>
          {mergedHoldings.some(h => h._merged) && (
            <div style={{ fontSize: 12, color: "#92400e", background: "#fef9c3", border: "1px solid #fcd34d", borderRadius: 8, padding: "6px 12px", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
              ⚡ <strong>{holdings.length - mergedHoldings.length}</strong> duplicate entr{holdings.length - mergedHoldings.length === 1 ? "y" : "ies"} auto-merged into weighted avg price. Showing {mergedHoldings.length} unique holdings.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 20 }}>
            <StatCard label="Total Invested" value={fmtCur(totalInvested)} icon="💰" />
            <StatCard label="Current Value"  value={fmtCur(totalCurVal)}   icon="📊" accent={totalPnl > 0} />
            <StatCard label="Total P&L"      value={fmtCur(totalPnl)} sub={fmtPct(totalPnlPct)} icon={totalPnl >= 0 ? "▲" : "▼"} pnl={totalPnl} />
            <StatCard label="Day's P&L"      value={fmtCur(dayPnl)}         icon="📅" pnl={dayPnl} />
            <StatCard label="Holdings"       value={mergedHoldings.length}  sub={holdings.length !== mergedHoldings.length ? `${holdings.length} entries` : undefined} icon="🗂" />
          </div>
        </>
      )}

      {/* Add/Edit form */}
      {showForm && (
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "1.2rem", marginBottom: 20 }}>
          <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 14 }}>{editId ? "Edit Holding" : "Add Stock Holding"}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>

            {/* Exchange selector */}
            <div>
              <label style={{ display: "block", fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>Exchange</label>
              <select value={form.exchange} onChange={e => setForm(f => ({ ...f, exchange: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
                <option value="NSE">NSE (India)</option>
                <option value="BSE">BSE (India)</option>
                <option value="US">US (NYSE / NASDAQ)</option>
                <option value="OTHER">Other (full ticker)</option>
              </select>
            </div>

            {/* Symbol with autocomplete */}
            <div ref={acRef} style={{ position: "relative" }}>
              <label style={{ display: "block", fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>
                {form.exchange === "NSE" || form.exchange === "BSE" ? "Search Stock / Symbol" : "Symbol"}
              </label>
              <input
                type="text"
                placeholder={form.exchange === "NSE" ? "e.g. INFY or Infosys" : form.exchange === "US" ? "e.g. AAPL" : "Symbol"}
                value={form.symbol}
                onChange={e => handleSymbolInput(e.target.value)}
                onFocus={() => { if (acResults.length > 0) setAcOpen(true); }}
                style={{ width: "100%", boxSizing: "border-box" }}
                autoComplete="off"
              />
              {/* Dropdown */}
              {acOpen && acResults.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 300, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.12)", marginTop: 2, maxHeight: 220, overflowY: "auto" }}>
                  {acResults.map(s => (
                    <div key={s.symbol} onMouseDown={() => selectAcStock(s)}
                      style={{ padding: "8px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "0.5px solid var(--color-border-tertiary)" }}
                      onMouseEnter={e => e.currentTarget.style.background = "var(--color-background-secondary)"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{s.symbol}</span>
                      <span style={{ fontSize: 12, color: "var(--color-text-secondary)", maxWidth: 180, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Company name (auto-filled) */}
            <div>
              <label style={{ display: "block", fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>Company Name</label>
              <input type="text" placeholder="Auto-filled for NSE stocks" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                style={{ width: "100%", boxSizing: "border-box", background: form.name ? "#fff" : "#f9f9f9" }} />
            </div>

            <LabelInput label="Avg Buy Price (₹)" placeholder="1500" type="number" value={form.buyPrice} onChange={v => setForm(f => ({ ...f, buyPrice: v }))} />
            <LabelInput label="Quantity (shares)"  placeholder="10"   type="number" value={form.qty}      onChange={v => setForm(f => ({ ...f, qty: v }))} />
          </div>

          {/* Hint line */}
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", margin: "8px 0 12px" }}>
            {(form.exchange === "NSE" || form.exchange === "BSE") && "Start typing the symbol or company name — suggestions will appear."}
            {form.exchange === "US"    && "Use US tickers: AAPL, MSFT, TSLA, GOOGL, AMZN …"}
            {form.exchange === "OTHER" && "Enter full Yahoo Finance ticker e.g. RELIANCE.NS or BTC-USD"}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <GreenBtn onClick={saveHolding} label={editId ? "Save Changes" : "Add Holding"} />
            <button onClick={closeForm} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {holdings.length === 0 && !showForm && (
        <div style={{ textAlign: "center", padding: "4rem 1rem", background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📈</div>
          <div style={{ fontWeight: 500, fontSize: 16, marginBottom: 6 }}>No holdings yet</div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 16 }}>Add your demat account stocks to track real-time P&L</div>
          <GreenBtn onClick={openAdd} label="+ Add Your First Stock" />
        </div>
      )}

      {/* Holdings table */}
      {holdings.length > 0 && (
        <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.75rem 1rem", borderBottom: "0.5px solid var(--color-border-tertiary)", flexWrap: "wrap", gap: 8 }}>
            <span style={{ fontWeight: 500, fontSize: 14 }}>
              Holdings ({mergedHoldings.length})
              {holdings.length !== mergedHoldings.length && <span style={{ fontSize: 11, color: "#92400e", background: "#fef9c3", borderRadius: 4, padding: "1px 6px", marginLeft: 6 }}>⚡ {holdings.length} entries merged</span>}
            </span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Sort:</span>
              {[["symbol","A-Z"],["value","Value"],["pnl","P&L"],["pct","% Return"]].map(([k,l]) => (
                <button key={k} onClick={() => setSortBy(k)} style={{ padding: "3px 9px", borderRadius: 6, border: "0.5px solid", borderColor: sortBy === k ? "#1a6b3c" : "var(--color-border-secondary)", background: sortBy === k ? "#1a6b3c" : "transparent", color: sortBy === k ? "#fff" : "var(--color-text-secondary)", fontSize: 11, cursor: "pointer" }}>{l}</button>
              ))}
            </div>
          </div>

          {/* Column headers */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1.1fr 1.1fr 1.1fr 1.1fr 1.2fr 52px", padding: "6px 1rem", background: "var(--color-background-secondary)", fontSize: 11, color: "var(--color-text-secondary)", fontWeight: 500 }}>
            <span>STOCK</span>
            <span style={{ textAlign: "right" }}>LTP</span>
            <span style={{ textAlign: "right" }}>DAY CHG</span>
            <span style={{ textAlign: "right" }}>INVESTED</span>
            <span style={{ textAlign: "right" }}>CUR VALUE</span>
            <span style={{ textAlign: "right" }}>P&amp;L</span>
            <span />
          </div>

          {/* Rows */}
          {sorted.map(h => (
            <div key={h._ids ? h._ids[0] : h.id} style={{ display: "grid", gridTemplateColumns: "2fr 1.1fr 1.1fr 1.1fr 1.1fr 1.2fr 52px", padding: "10px 1rem", borderTop: "0.5px solid var(--color-border-tertiary)", alignItems: "center", fontSize: 13 }}>
              <div>
                <div style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                  {h.symbol}
                  <span style={{ fontSize: 10, background: "var(--color-background-secondary)", borderRadius: 4, padding: "1px 5px", fontWeight: 400, color: "var(--color-text-secondary)" }}>{h.exchange}</span>
                  {h._merged && (
                    <span title={`${h._originalCount} entries merged — avg buy price`} style={{ fontSize: 9, background: "#fef9c3", border: "1px solid #fcd34d", borderRadius: 4, padding: "1px 5px", color: "#92400e", fontWeight: 600, cursor: "help" }}>
                      ⚡ avg {h._originalCount}×
                    </span>
                  )}
                </div>
                {h.name && h.name !== h.symbol && <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{h.name}</div>}
                <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{h.qty} shares @ ₹{fmt(h.buyPrice)}</div>
              </div>

              {/* LTP — with retry on failure */}
              <div style={{ textAlign: "right" }}>
                {loading
                  ? <span style={{ color: "var(--color-text-secondary)", fontSize: 11 }}>…</span>
                  : h.fetchFailed
                    ? <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                        <span style={{ fontSize: 10, color: "#f0a020" }} title="Price fetch failed — symbol may not be listed on Yahoo Finance">⚠ N/A</span>
                        <button onClick={() => fetchPrices([h])} style={{ fontSize: 9, background: "#fff7ed", border: "1px solid #fcd34d", borderRadius: 4, padding: "1px 5px", cursor: "pointer", color: "#92400e" }}>↻ retry</button>
                      </div>
                    : h.cur != null
                      ? <span style={{ fontWeight: 500 }}>₹{fmt(h.cur)}</span>
                      : <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                          <span style={{ color: "var(--color-text-secondary)", fontSize: 11 }}>—</span>
                          <button onClick={() => fetchPrices([h])} style={{ fontSize: 9, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 4, padding: "1px 5px", cursor: "pointer", color: "var(--color-text-secondary)" }}>↻ fetch</button>
                        </div>
                }
              </div>

              {/* Day change */}
              <div style={{ textAlign: "right", color: pnlColor(h.dayChangePct), fontSize: 12 }}>
                {h.dayChangePct != null ? <>{h.dayChangePct >= 0 ? "▲" : "▼"} {Math.abs(h.dayChangePct).toFixed(2)}%</> : "—"}
              </div>

              <div style={{ textAlign: "right" }}>{fmtCur(h.invested)}</div>

              <div style={{ textAlign: "right" }}>
                {h.curVal != null ? fmtCur(h.curVal) : <span style={{ color: "var(--color-text-secondary)" }}>—</span>}
              </div>

              <div style={{ textAlign: "right" }}>
                {h.pnl != null ? (
                  <div>
                    <div style={{ color: pnlColor(h.pnl), fontWeight: 500 }}>{h.pnl >= 0 ? "+" : ""}{fmtCur(h.pnl)}</div>
                    <div style={{ fontSize: 11, color: pnlColor(h.pnlPct) }}>{fmtPct(h.pnlPct)}</div>
                  </div>
                ) : <span style={{ color: "var(--color-text-secondary)" }}>—</span>}
              </div>

              <div style={{ textAlign: "right" }}>
                <ThreeDotMenu
                  onEdit={() => openEdit(holdings.find(hh => hh.id === (h._ids?.[0] ?? h.id)) || h)}
                  onDelete={() => {
                    if (h._merged && h._ids?.length > 1) {
                      if (window.confirm(`This will delete all ${h._ids.length} entries for ${h.symbol}. Continue?`)) {
                        h._ids.forEach(id => deleteHolding(id));
                      }
                    } else {
                      deleteHolding(h._ids?.[0] ?? h.id);
                    }
                  }}
                />
              </div>
            </div>
          ))}

          {/* Footer */}
          <div style={{ padding: "8px 1rem", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11, color: "var(--color-text-secondary)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            <span>Prices via Yahoo Finance · 15-min delayed · For informational purposes only</span>
            {priceError && <span style={{ color: "#f0a020" }}>⚠ {priceError}</span>}
          </div>
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
