import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  auth,
  signInWithGoogle,
  signOutUser,
  onAuthStateChanged,
  loadFromFirestore,
  saveToFirestore,
} from "./firebase";
import { getFreshDriveToken } from "./firebase";

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
  } catch (e) { return null; }
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
  commuteSettings: { busFare: 0, bankId: "", category: "Transport", note: "Bus fare", timeLogs: [] },
  commuteLeaves: [],
  featureToggles: { fo: true, portfolio: true },
  businessData: [],
  projectsData: [],
  projectTaskTypes: ["Design", "Development", "Research", "Review", "Testing", "Meeting", "Documentation", "Bug Fix", "Marketing", "Other"],
  liabilityTypes: ["Credit Card", "Personal Loan", "Car Loan", "Home Loan", "Other"],
  billAttachments: [], // { monthId, fileName, fileUrl, fileId, uploadDate }
};



const ASSET_TYPES = ["Stocks & Equity", "Equity Funds", "Gold & Silver", "FD & RD", "EPF / PPF / NPS", "Real Estate", "Crypto", "Cash", "Other"];
const STRATEGIES = ["Call", "Put"];
const INSTRUMENTS = ["Index Options", "Stock Options", "Commodities"];

const fmt = (n) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n || 0);
const fmtCur = (n) => "₹" + fmt(n);
const fmtPct = (n) => (n >= 0 ? "+" : "") + (n || 0).toFixed(2) + "%";

// ── XIRR — Newton-Raphson solver ──────────────────────────────────────────────
// cashflows: [{ amount, date }]  (negative = outflow, positive = inflow)
function DriveProvider({ children, firebaseUser }) {
  const [token,  setToken]  = useState(() => {
    const t = localStorage.getItem("ft_drv_tok");
    const e = parseInt(localStorage.getItem("ft_drv_exp") || "0");
    return (t && Date.now() < e) ? t : null;
  });
  const [email,   setEmail]   = useState(() => localStorage.getItem("ft_drv_email") || null);
  const [loading, setLoading] = useState(false);

  // When Firebase confirms user is signed in → silently get fresh Drive token
  useEffect(() => {
    if (!firebaseUser) return;
    // Already have a valid token — nothing to do
    const saved  = localStorage.getItem("ft_drv_tok");
    const expiry = parseInt(localStorage.getItem("ft_drv_exp") || "0");
    if (saved && Date.now() < expiry) {
      setToken(saved);
      setEmail(localStorage.getItem("ft_drv_email") || firebaseUser.email);
      return;
    }
    // Token expired or missing — get a fresh one using Firebase's refresh token
    setLoading(true);
    getFreshDriveToken().then(tok => {
      setLoading(false);
      if (tok) {
        setToken(tok);
        setEmail(firebaseUser.email || localStorage.getItem("ft_drv_email"));
      }
    });
  }, [firebaseUser?.uid]); // eslint-disable-line

  function clearDrive() {
    ["ft_drv_tok", "ft_drv_exp", "ft_drv_email"].forEach(k => localStorage.removeItem(k));
    setToken(null); setEmail(null);
  }

  async function uploadToDrive(file, driveFolderId) {
    // Always get the freshest token before uploading
    let tok = localStorage.getItem("ft_drv_tok");
    const expiry = parseInt(localStorage.getItem("ft_drv_exp") || "0");
    if (!tok || Date.now() >= expiry) {
      tok = await getFreshDriveToken();
      if (tok) setToken(tok);
    }
    if (!tok) return null;
    try {
      const ab   = await file.arrayBuffer();
      const meta = JSON.stringify({ name: file.name, ...(driveFolderId ? { parents: [driveFolderId] } : {}) });
      const form = new FormData();
      form.append("metadata", new Blob([meta], { type: "application/json" }));
      form.append("file",     new Blob([ab],   { type: file.type || "application/octet-stream" }), file.name);
      const res = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,webContentLink,size",
        { method: "POST", headers: { Authorization: "Bearer " + tok }, body: form }
      );
      if (!res.ok) return null;
      const d = await res.json();
      await fetch(`https://www.googleapis.com/drive/v3/files/${d.id}/permissions`, {
        method: "POST",
        headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "reader", type: "anyone" }),
      }).catch(() => {});
      return {
        id: d.id, name: d.name, mimeType: d.mimeType,
        webViewLink: d.webViewLink,
        downloadUrl: `https://drive.google.com/uc?export=download&id=${d.id}`,
        previewUrl:  `https://drive.google.com/file/d/${d.id}/preview`,
        size: file.size, source: "gdrive",
      };
    } catch (e) { return null; }
  }

  return (
    <DriveContext.Provider value={{ connected: !!token, token, email, loading, clearDrive, uploadToDrive }}>
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
  const [moneyTab, setMoneyTab]         = useState("expenses");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Debounce timer ref — avoids hammering Firestore on every keystroke
  const saveTimer = useRef(null);
  // Always-current data ref for use inside intervals
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

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

  // ── Auto Bus Fare: runs on load (catch-up) + every minute (real-time) ────────
  const autoAddBusFare = useCallback((currentData) => {
    const settings = currentData.commuteSettings || {};
    const timeLogs = settings.timeLogs || [];
    if (!settings.busFare || !settings.bankId || timeLogs.length === 0) return;

    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const todayKey = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const dow = now.getDay(); // 0=Sun,6=Sat
    if (dow === 0 || dow === 6) return; // weekend
    const leaves = currentData.commuteLeaves || [];
    if (leaves.includes(todayKey)) return; // on leave

    const nowHHMM = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const txns = currentData.transactions || [];

    const toAdd = [];
    timeLogs.forEach(tl => {
      if (!tl.time) return;
      // Add if current time >= slot time and not already added today
      if (nowHHMM < tl.time) return;
      const alreadyAdded = txns.some(t => t.date === todayKey && t._busfare === true && t._timeLogId === tl.id);
      if (alreadyAdded) return;
      toAdd.push({
        id: Date.now() + Math.random(),
        date: todayKey,
        time: tl.time,
        type: "expense",
        amount: Number(settings.busFare),
        category: settings.category || "Transport",
        note: (settings.note || "Bus fare") + " – " + tl.label,
        bankId: settings.bankId,
        _busfare: true,
        _timeLogId: tl.id,
        _autoAdded: true,
      });
    });

    if (toAdd.length > 0) {
      update(p => ({ transactions: [...(p.transactions || []), ...toAdd] }));
    }
  }, [update]);

  // Run catch-up when data is ready (handles app-was-closed case)
  useEffect(() => {
    if (dataReady) autoAddBusFare(dataRef.current);
  }, [dataReady]); // eslint-disable-line

  // Run every minute to auto-add at exact time
  useEffect(() => {
    if (!dataReady) return;
    const interval = setInterval(() => {
      autoAddBusFare(dataRef.current);
    }, 60000);
    return () => clearInterval(interval);
  }, [dataReady, autoAddBusFare]);

  const totalIncome = data.transactions.filter(t => t.type === "income").reduce((s, t) => s + Number(t.amount || 0), 0);
  const totalExpense = data.transactions.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount || 0), 0);
  // Net worth = sum of all bank balances (linked transactions) + unlinked transactions
  const linkedBankIds = new Set((data.banks || []).map(b => String(b.id)));
  const unlinkedIncome = data.transactions.filter(t => t.type === "income" && (!t.bankId || !linkedBankIds.has(String(t.bankId)))).reduce((s, t) => s + Number(t.amount || 0), 0);
  const unlinkedExpense = data.transactions.filter(t => t.type === "expense" && (!t.bankId || !linkedBankIds.has(String(t.bankId)))).reduce((s, t) => s + Number(t.amount || 0), 0);
  const excludedGoalSavings = (data.needsWants || []).filter(g => g.excludeFromNetWorth && !g.completed).reduce((s, g) => s + Number(g.savedAmount || 0), 0);
  const netWorth = ((data.banks || []).reduce((s, b) => {
    const inc = data.transactions.filter(t => t.type === "income" && String(t.bankId) === String(b.id)).reduce((a, t) => a + Number(t.amount || 0), 0);
    const exp = data.transactions.filter(t => t.type === "expense" && String(t.bankId) === String(b.id)).reduce((a, t) => a + Number(t.amount || 0), 0);
    if (b.type === "Credit Card") {
      const outstanding = (b.openingBalance || 0) + exp - inc;
      return s - outstanding;
    }
    return s + (b.openingBalance || 0) + inc - exp;
  }, 0) + (unlinkedIncome - unlinkedExpense)) - excludedGoalSavings;

  const totalAssets = data.assets.reduce((s, a) => s + Number(a.value || 0), 0);
  const totalLiabilities = data.liabilities.reduce((s, l) => s + Number(l.value || 0), 0);
  // Subtract saved amounts for goals marked "exclude from net worth"



  // ── Auth gates ────────────────────────────────────────────────────────────
  if (firebaseUser === undefined) return <SplashScreen msg="Loading…" />;
  if (firebaseUser === null)      return <SignInPage />;
  if (!dataReady)                 return <SplashScreen msg="Syncing your data…" />;

  if (onboarding) return <Onboarding step={onboardStep} setStep={setOnboardStep} data={data} update={update} done={() => setOnboarding(false)} />;

  // Only Overview + Money tabs

  return (
    <DriveProvider firebaseUser={firebaseUser}>
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

        {/* Money nav item */}
        <button onClick={() => setPage("money")} style={{
          display: "flex", alignItems: "center",
          gap: sidebarCollapsed ? 0 : 10,
          justifyContent: sidebarCollapsed ? "center" : "flex-start",
          padding: sidebarCollapsed ? "0.6rem 0" : "0.6rem 1rem",
          background: page === "money" ? "var(--color-background-secondary)" : "transparent",
          border: "none", cursor: "pointer",
          color: page === "money" ? "var(--color-text-primary)" : "var(--color-text-secondary)",
          fontWeight: page === "money" ? 500 : 400, fontSize: 14,
          borderLeft: page === "money" ? "2px solid #1a6b3c" : "2px solid transparent",
          width: "100%", textAlign: "left", whiteSpace: "nowrap", overflow: "hidden"
        }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>⊕</span>
          {!sidebarCollapsed && "Money"}
        </button>

        {!sidebarCollapsed && (
          <div style={{ marginTop: "auto", padding: "0 0 0.5rem" }}>
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
        {page === "overview" && <Overview data={data} netWorth={netWorth} setPage={setPage} update={update} />}
        {page === "money" && <MoneyPage data={data} update={update} tab={moneyTab} setTab={setMoneyTab} />}
      </main>

      {/* ── Mobile Bottom Navigation Bar ── */}
      {mobile && (
        <nav style={{
          position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 1000,
          background: "var(--color-background-primary)",
          borderTop: "0.5px solid var(--color-border-tertiary)",
          display: "flex", alignItems: "stretch",
          height: 64,
          paddingBottom: "env(safe-area-inset-bottom)",
        }}>
          <button onClick={() => setPage("overview")} style={{
            flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", gap: 3, border: "none", background: "transparent",
            cursor: "pointer", fontSize: 10, fontWeight: 500,
            color: page === "overview" ? "#1a6b3c" : "var(--color-text-secondary)",
          }}>
            <span style={{ fontSize: 22 }}>⊞</span>
            <span>Overview</span>
          </button>
          <button onClick={() => setPage("money")} style={{
            flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", gap: 3, border: "none", background: "transparent",
            cursor: "pointer", fontSize: 10, fontWeight: 500,
            color: page === "money" ? "#1a6b3c" : "var(--color-text-secondary)",
          }}>
            <span style={{ fontSize: 22 }}>⊕</span>
            <span>Money</span>
          </button>
        </nav>
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

function Overview({ data, netWorth, setPage, update }) {
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
  const [newTodo,    setNewTodo]    = useState("");
  const [repeatMode, setRepeatMode] = useState("none");
  const [showRepeat, setShowRepeat] = useState(false);
  const [weeklyDays, setWeeklyDays] = useState([]);

  function toggleWeeklyDay(d) {
    setWeeklyDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);
  }

  function addTodo() {
    const text = newTodo.trim();
    if (!text) return;
    update(p => ({ overviewTodos: [...(p.overviewTodos || []), {
      id: Date.now(), text, done: false,
      repeat: repeatMode,
      weeklyDays: repeatMode === "weekly" && weeklyDays.length > 0 ? weeklyDays : null,
      createdAt: new Date().toISOString(),
      lastReset: new Date().toDateString(),
    }]}));
    setNewTodo(""); setRepeatMode("none"); setShowRepeat(false); setWeeklyDays([]);
  }

  function toggleTodo(id) {
    update(p => ({ overviewTodos: (p.overviewTodos || []).map(t => t.id === id ? { ...t, done: !t.done } : t) }));
  }

  function deleteTodo(id) {
    update(p => ({ overviewTodos: (p.overviewTodos || []).filter(t => t.id !== id) }));
  }

  // Auto-reset repeated tasks based on their schedule
  useEffect(() => {
    const now = new Date();
    const todayStr   = now.toDateString();
    const thisWeek   = `${now.getFullYear()}-W${Math.ceil((now.getDate() + new Date(now.getFullYear(), now.getMonth(), 1).getDay()) / 7)}`;
    const thisMonth  = `${now.getFullYear()}-${now.getMonth()}`;

    const needsReset = (t) => {
      if (!t.done || t.repeat === "none" || !t.repeat) return false;
      const last = t.lastReset || "";
      if (t.repeat === "daily")   return last !== todayStr;
      if (t.repeat === "weekly") {
        if (t.weeklyDays && t.weeklyDays.length > 0) {
          const todayDow = new Date().getDay();
          return last !== todayStr && t.weeklyDays.includes(todayDow);
        }
        return last !== thisWeek;
      }
      if (t.repeat === "monthly") return last !== thisMonth;
      return false;
    };

    const toReset = todos.filter(needsReset);
    if (toReset.length === 0) return;

    update(p => ({ overviewTodos: (p.overviewTodos || []).map(t =>
      toReset.find(r => r.id === t.id)
        ? { ...t, done: false, lastReset: todayStr }
        : t
    )}));
  }, []); // eslint-disable-line — runs once on mount to catch overnight resets

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
        </div>
      ) : (
        /* ── DESKTOP: original grid layout ── */
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 12 }}>
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

        </div>
      )}

      {/* To-Do row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginBottom: 12 }}>

        {/* ── Quick To-Do (right side) ── */}
        <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.1rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, borderBottom: "0.5px solid var(--color-border-tertiary)", paddingBottom: 10 }}>
            <span style={{ fontWeight: 500, fontSize: 15 }}>✅ To-Do</span>
            <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
              {todos.filter(t => t.done).length}/{todos.length} done
            </span>
          </div>

          {/* Input row */}
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input
              value={newTodo}
              onChange={e => setNewTodo(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addTodo()}
              placeholder="Add a task…"
              style={{ flex: 1, fontSize: 13, padding: "6px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", outline: "none", fontFamily: "inherit", background: "var(--color-background-secondary)", color: "var(--color-text-primary)" }}
            />
            {/* Repeat toggle button */}
            <button onClick={() => setShowRepeat(p => !p)}
              title="Set repeat"
              style={{ background: repeatMode !== "none" ? "#e8f5ee" : "var(--color-background-secondary)", color: repeatMode !== "none" ? "#1a6b3c" : "var(--color-text-secondary)", border: `0.5px solid ${repeatMode !== "none" ? "#1a6b3c" : "var(--color-border-secondary)"}`, borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" }}>
              🔁
            </button>
            <button onClick={addTodo}
              style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
              +
            </button>
          </div>

          {/* Repeat picker */}
          {showRepeat && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                {[["none","No repeat"], ["daily","Daily"], ["weekly","Weekly"], ["monthly","Monthly"]].map(([v, l]) => (
                  <button key={v} onClick={() => { setRepeatMode(v); if (v !== "weekly") setWeeklyDays([]); }}
                    style={{ fontSize: 11, padding: "4px 11px", borderRadius: 20, border: `0.5px solid ${repeatMode === v ? "#1a6b3c" : "var(--color-border-secondary)"}`, background: repeatMode === v ? "#1a6b3c" : "var(--color-background-secondary)", color: repeatMode === v ? "#fff" : "var(--color-text-secondary)", cursor: "pointer", fontWeight: repeatMode === v ? 600 : 400 }}>
                    {l}
                  </button>
                ))}
              </div>
              {repeatMode === "weekly" && (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                  {[["S",0],["M",1],["T",2],["W",3],["T",4],["F",5],["S",6]].map(([label, dow]) => (
                    <button key={dow} onClick={() => toggleWeeklyDay(dow)}
                      style={{ width: 28, height: 28, borderRadius: "50%", border: `1.5px solid ${weeklyDays.includes(dow) ? "#1a6b3c" : "var(--color-border-secondary)"}`, background: weeklyDays.includes(dow) ? "#1a6b3c" : "var(--color-background-secondary)", color: weeklyDays.includes(dow) ? "#fff" : "var(--color-text-secondary)", cursor: "pointer", fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {label}
                    </button>
                  ))}
                  <span style={{ fontSize: 10, color: "var(--color-text-secondary)", marginLeft: 2 }}>
                    {weeklyDays.length === 0 ? "(any day)" : ""}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Task list */}
          {todos.length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--color-text-secondary)", fontSize: 12, padding: "1rem 0", fontStyle: "italic" }}>
              No tasks yet — add one above
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }}>
              {/* Pending */}
              {todos.filter(t => !t.done).map(t => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 8, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)" }}>
                  <button onClick={() => toggleTodo(t.id)}
                    style={{ width: 18, height: 18, borderRadius: 4, border: "1.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }} />
                  <span style={{ flex: 1, fontSize: 13, color: "var(--color-text-primary)", wordBreak: "break-word" }}>{t.text}</span>
                  {/* Repeat badge */}
                  {t.repeat && t.repeat !== "none" && (
                    <span style={{ fontSize: 10, background: "#e8f5ee", color: "#1a6b3c", borderRadius: 4, padding: "1px 6px", fontWeight: 500, whiteSpace: "nowrap", flexShrink: 0 }}>
                      🔁 {t.repeat === "weekly" && t.weeklyDays && t.weeklyDays.length > 0
                        ? ["Su","Mo","Tu","We","Th","Fr","Sa"].filter((_,i) => t.weeklyDays.includes(i)).join(", ")
                        : t.repeat}
                    </span>
                  )}
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
                  {t.repeat && t.repeat !== "none" && (
                    <span style={{ fontSize: 10, background: "#f0fdf4", color: "#4a9a6a", borderRadius: 4, padding: "1px 6px", fontWeight: 500, whiteSpace: "nowrap", flexShrink: 0 }}>
                      🔁 {t.repeat}
                    </span>
                  )}
                  <button onClick={() => deleteTodo(t.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#d44", fontSize: 13, opacity: 0.45, padding: "0 2px", lineHeight: 1, flexShrink: 0 }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
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
      <TabBar tabs={["expenses", "income", "transactions", "transfer", "scheduled", "liabilities", "analysis"]} active={tab} setActive={setTab} labels={["Expenses", "Income", "Transactions", "Transfer", "Scheduled", "Liabilities", "Analysis"]} />

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
      {tab === "analysis" && <AnalysisTab data={data} update={update} accounts={accounts} />}
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

// ─── Reusable Transfer History Row (used in both Transactions tab and Transfer tab) ──
function TransferHistoryRow({ t, idx, total, fromAcct, toAcct, accounts, badgeStyle, BG, BG2, BORDER, GREEN, onDelete, onSaveEdit }) {
  const [editing, setEditing] = React.useState(false);
  const [ef, setEf] = React.useState(null);

  function openEdit() {
    setEf({
      pairId: t.transferPairId,
      fromId: String(t.bankId),
      toId: String(t.transferToId),
      amount: String(t.amount),
      date: t.date,
      note: t.note === "Account Transfer" ? "" : (t.note || ""),
    });
    setEditing(true);
  }

  function save() {
    onSaveEdit(ef);
    setEditing(false);
  }

  if (editing && ef) {
    return (
      <div style={{ padding: "14px 16px", borderBottom: idx < total - 1 ? `0.5px solid ${BORDER}` : "none", background: BG2 }}>
        <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 10, color: GREEN }}>✏️ Edit Transfer</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <div>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>From Account</label>
            <select value={ef.fromId} onChange={e => setEf(p => ({ ...p, fromId: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontSize: 12 }}>
              {accounts.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>To Account</label>
            <select value={ef.toId} onChange={e => setEf(p => ({ ...p, toId: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontSize: 12 }}>
              {accounts.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Amount (₹)</label>
            <input type="number" value={ef.amount} onChange={e => setEf(p => ({ ...p, amount: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontSize: 12, fontWeight: 600 }} autoFocus />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Date</label>
            <input type="date" value={ef.date} onChange={e => setEf(p => ({ ...p, date: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontSize: 12 }} />
          </div>
          <div style={{ gridColumn: "span 2" }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Note (optional)</label>
            <input value={ef.note} onChange={e => setEf(p => ({ ...p, note: e.target.value }))} placeholder="e.g. Savings transfer" style={{ width: "100%", boxSizing: "border-box", fontSize: 12 }} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setEditing(false)} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}>Cancel</button>
          <button onClick={save} style={{ background: GREEN, color: "#fff", border: "none", borderRadius: 7, padding: "5px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Save Changes</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", borderBottom: idx < total - 1 ? `0.5px solid ${BORDER}` : "none", transition: "background 0.12s" }}
      onMouseEnter={e => e.currentTarget.style.background = BG2}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
    >
      {/* Icon */}
      <div style={{ width: 44, height: 44, borderRadius: 13, background: "#e8f5ee", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0, border: "0.5px solid #b6ddc233" }}>↔</div>
      {/* Details */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
          <span style={{ ...badgeStyle(t.bankId), borderRadius: 5, padding: "2px 9px", fontSize: 12, fontWeight: 600 }}>{fromAcct?.name || "—"}</span>
          <span style={{ fontWeight: 800, color: GREEN, fontSize: 14 }}>→</span>
          <span style={{ ...(toAcct ? badgeStyle(t.transferToId) : {}), borderRadius: 5, padding: "2px 9px", fontSize: 12, fontWeight: 600, color: toAcct ? undefined : "var(--color-text-secondary)" }}>{toAcct?.name || "—"}</span>
        </div>
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
          {t.date}{t.note && t.note !== "Account Transfer" ? ` · ${t.note}` : ""}
        </div>
      </div>
      {/* Amount + pill */}
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ marginBottom: 3 }}>
          <span style={{ fontSize: 10, fontWeight: 700, background: "#e8f5ee", color: GREEN, borderRadius: 5, padding: "2px 7px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Transfer</span>
        </div>
        <div style={{ fontWeight: 700, fontSize: 15, color: GREEN }}>₹{Number(t.amount).toLocaleString("en-IN")}</div>
      </div>
      {/* Edit */}
      <button onClick={openEdit}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "var(--color-border-primary)", padding: "4px", borderRadius: 6, flexShrink: 0, opacity: 0.45 }}
        title="Edit transfer"
        onMouseEnter={e => { e.currentTarget.style.opacity = "1"; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = "0.45"; }}
      >✏️</button>
      {/* Delete */}
      <button onClick={onDelete}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, color: "var(--color-border-primary)", padding: "4px", borderRadius: 6, flexShrink: 0, opacity: 0.4 }}
        title="Delete transfer"
        onMouseEnter={e => { e.currentTarget.style.color = "#cc2222"; e.currentTarget.style.opacity = "1"; }}
        onMouseLeave={e => { e.currentTarget.style.color = "var(--color-border-primary)"; e.currentTarget.style.opacity = "0.4"; }}
      >🗑</button>
    </div>
  );
}

// ─── Transactions Dashboard Tab ──────────────────────────────────────────────
function TransactionsDashboardTab({ data, update, accounts, setEditTx }) {
  const [search, setSearch]           = useState("");
  const [sortBy, setSortBy]           = useState("date");
  const [showFilter, setShowFilter]   = useState(false);
  const [showSort, setShowSort]       = useState(false);

  // ── Filter state ────────────────────────────────────────────────────────
  const [filterYearMonth, setFilterYearMonth] = useState("all");
  const [filterDateMode, setFilterDateMode]   = useState("ym");
  const [filterDateFrom, setFilterDateFrom]   = useState("");
  const [filterDateTo, setFilterDateTo]       = useState("");
  const [filterCatType, setFilterCatType]     = useState("All");
  const [filterCats, setFilterCats]           = useState([]);
  const [filterAccounts, setFilterAccounts]   = useState([]);

  const allTransactions = data.transactions || [];

  // Available year/month chips derived from real data
  const yearMonthOptions = React.useMemo(() => {
    const years = new Set(), months = new Set();
    allTransactions.forEach(t => {
      if (!t.date) return;
      years.add(t.date.slice(0, 4));
      months.add(t.date.slice(0, 7));
    });
    return {
      years:  [...years].sort((a,b)  => b.localeCompare(a)),
      months: [...months].sort((a,b) => b.localeCompare(a)).slice(0, 12),
    };
  }, [allTransactions]);

  // All unique categories in data
  const allCategories = React.useMemo(() => {
    const s = new Set();
    allTransactions.forEach(t => { if (t.category) s.add(t.category); });
    return [...s].sort();
  }, [allTransactions]);

  // Narrow categories by type toggle
  const displayedCats = React.useMemo(() => {
    if (filterCatType === "Spending") return allCategories.filter(c => allTransactions.some(t => t.category === c && t.type === "expense"));
    if (filterCatType === "Income")   return allCategories.filter(c => allTransactions.some(t => t.category === c && t.type === "income"));
    return allCategories;
  }, [allCategories, filterCatType, allTransactions]);

  // Count active filter sections (for badge)
  const activeFilterCount = [
    (filterDateMode === "ym" && filterYearMonth !== "all") || (filterDateMode === "range" && (filterDateFrom || filterDateTo)),
    filterCatType !== "All",
    filterCats.length > 0,
    filterAccounts.length > 0,
  ].filter(Boolean).length;

  function resetFilters() {
    setFilterYearMonth("all"); setFilterDateMode("ym");
    setFilterDateFrom(""); setFilterDateTo("");
    setFilterCatType("All"); setFilterCats([]); setFilterAccounts([]);
  }
  function toggleCat(c)    { setFilterCats(p    => p.includes(c) ? p.filter(x => x !== c) : [...p, c]); }
  function toggleAcct(id)  { setFilterAccounts(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]); }

  // Month short-label helper
  function fmtYM(ym) {
    const [y, m] = ym.split("-");
    return new Date(+y, +m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
  }

  // Build filtered + sorted transaction list
  const allTx = React.useMemo(() => {
    return allTransactions
      .filter(t => !t.isTransfer)
      .filter(t => {
        if (filterDateMode === "range") {
          if (filterDateFrom && t.date < filterDateFrom) return false;
          if (filterDateTo   && t.date > filterDateTo)   return false;
        } else if (filterYearMonth !== "all") {
          if (!t.date?.startsWith(filterYearMonth)) return false;
        }
        if (filterCatType === "Spending" && t.type !== "expense") return false;
        if (filterCatType === "Income"   && t.type !== "income")  return false;
        if (filterCats.length    > 0 && !filterCats.includes(t.category))       return false;
        if (filterAccounts.length > 0 && !filterAccounts.includes(String(t.bankId))) return false;
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
  const totalIncome  = allTx.filter(t => t.type === "income").reduce((s, t)  => s + Number(t.amount), 0);
  const totalExpense = allTx.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);

  // Light-mode icon background colours
  function getCategoryColorLight(category, type) {
    if (type === "income") return { bg: "#e8f5ee", iconColor: "#1a6b3c" };
    const c = (category || "").toLowerCase();
    if (c.includes("food") || c.includes("snack") || c.includes("juice") || c.includes("tea") || c.includes("restaurant")) return { bg: "#fff3e8", iconColor: "#d4711a" };
    if (c.includes("rent") || c.includes("home"))   return { bg: "#eeefff", iconColor: "#4444cc" };
    if (c.includes("travel") || c.includes("cab") || c.includes("petrol")) return { bg: "#f3e8ff", iconColor: "#8844cc" };
    if (c.includes("health") || c.includes("medical")) return { bg: "#ffe8e8", iconColor: "#cc2222" };
    if (c.includes("card") || c.includes("emi"))    return { bg: "#ffe8e8", iconColor: "#cc3333" };
    if (c.includes("shop") || c.includes("cloth"))  return { bg: "#e8f8f8", iconColor: "#2a9090" };
    return { bg: "#f0f0f0", iconColor: "#888888" };
  }

  const GREEN  = "#1a6b3c";
  const BG     = "var(--color-background-primary)";
  const BG2    = "var(--color-background-secondary)";
  const BORDER = "var(--color-border-tertiary)";

  // Pill chip style helper
  function chipStyle(active) {
    return {
      padding: "5px 14px", borderRadius: 20, fontSize: 13, cursor: "pointer",
      border: active ? `1.5px solid ${GREEN}` : `0.5px solid var(--color-border-secondary)`,
      background: active ? GREEN : BG2,
      color: active ? "#fff" : "var(--color-text-secondary)",
      fontWeight: active ? 600 : 400, transition: "all 0.15s",
    };
  }

  return (
    <div style={{ marginTop: 16 }}>

      {/* ── Summary cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div style={{ background: "linear-gradient(135deg,#e8f5ee,#d1ead9)", borderRadius: 14, padding: "14px 18px", border: "0.5px solid #b6ddc2" }}>
          <div style={{ fontSize: 11, color: GREEN, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Total Income</div>
          <div style={{ fontWeight: 800, fontSize: 20, color: GREEN }}>+₹{totalIncome.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div>
          <div style={{ fontSize: 11, color: "#4a9a6a", marginTop: 4 }}>{allTx.filter(t => t.type === "income").length} entries</div>
        </div>
        <div style={{ background: "linear-gradient(135deg,#fef2f2,#fde8e8)", borderRadius: 14, padding: "14px 18px", border: "0.5px solid #f5c0c0" }}>
          <div style={{ fontSize: 11, color: "#cc2222", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Total Expenses</div>
          <div style={{ fontWeight: 800, fontSize: 20, color: "#cc2222" }}>-₹{totalExpense.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div>
          <div style={{ fontSize: 11, color: "#e05a5a", marginTop: 4 }}>{allTx.filter(t => t.type === "expense").length} entries</div>
        </div>
      </div>

      {/* ── Search + Filter + Sort bar ── */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, background: BG2, borderRadius: 14, padding: "10px 16px", border: `0.5px solid var(--color-border-secondary)` }}>
          <span style={{ fontSize: 15, color: "var(--color-text-secondary)" }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search transactions"
            style={{ flex: 1, background: "none !important", border: "none !important", outline: "none", fontSize: 14, color: "var(--color-text-primary)", padding: "0 !important" }} />
          {search && <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)", padding: 0 }}>✕</button>}
        </div>

        {/* Filter button with badge */}
        <button onClick={() => { setShowFilter(p => !p); setShowSort(false); }} style={{
          width: 42, height: 42, borderRadius: "50%", flexShrink: 0, position: "relative",
          background: activeFilterCount > 0 ? GREEN : BG2,
          border: `0.5px solid var(--color-border-secondary)`,
          cursor: "pointer", fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center",
          color: activeFilterCount > 0 ? "#fff" : "var(--color-text-secondary)",
        }}>
          {activeFilterCount > 0 && (
            <span style={{ position: "absolute", top: -3, right: -3, background: "#ef4444", color: "#fff", borderRadius: "50%", width: 16, height: 16, fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{activeFilterCount}</span>
          )}
          ▽
        </button>

        {/* Sort button */}
        <div style={{ position: "relative", flexShrink: 0 }}>
          <button onClick={() => { setShowSort(p => !p); setShowFilter(false); }} style={{
            width: 42, height: 42, borderRadius: "50%", background: BG2,
            border: `0.5px solid var(--color-border-secondary)`,
            cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)",
          }}>↕</button>
          {showSort && (
            <>
              <div onClick={() => setShowSort(false)} style={{ position: "fixed", inset: 0, zIndex: 498 }} />
              <div style={{ position: "absolute", top: 48, right: 0, background: BG, border: `0.5px solid var(--color-border-secondary)`, borderRadius: 12, zIndex: 499, minWidth: 150, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", overflow: "hidden" }}>
                {[["date","By Date (newest)"], ["amount","By Amount"]].map(([v, l]) => (
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

      {/* ── Active filter chip row ── */}
      {activeFilterCount > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {filterYearMonth !== "all" && filterDateMode === "ym" && (
            <span style={{ ...chipStyle(true), fontSize: 11, padding: "3px 10px", display:"flex", alignItems:"center", gap: 4 }}>
              📅 {filterYearMonth.length === 4 ? filterYearMonth : fmtYM(filterYearMonth)}
              <button onClick={() => setFilterYearMonth("all")} style={{ background:"none", border:"none", cursor:"pointer", color:"#fff", fontSize:11, padding:0 }}>✕</button>
            </span>
          )}
          {filterCatType !== "All" && (
            <span style={{ ...chipStyle(true), fontSize: 11, padding: "3px 10px", display:"flex", alignItems:"center", gap: 4 }}>
              {filterCatType}
              <button onClick={() => setFilterCatType("All")} style={{ background:"none", border:"none", cursor:"pointer", color:"#fff", fontSize:11, padding:0 }}>✕</button>
            </span>
          )}
          {filterCats.map(c => (
            <span key={c} style={{ ...chipStyle(true), fontSize: 11, padding: "3px 10px", display:"flex", alignItems:"center", gap: 4 }}>
              {c}
              <button onClick={() => toggleCat(c)} style={{ background:"none", border:"none", cursor:"pointer", color:"#fff", fontSize:11, padding:0 }}>✕</button>
            </span>
          ))}
          {filterAccounts.map(id => {
            const a = accounts.find(ac => String(ac.id) === id);
            return a ? (
              <span key={id} style={{ ...chipStyle(true), fontSize: 11, padding: "3px 10px", display:"flex", alignItems:"center", gap: 4 }}>
                {a.name}
                <button onClick={() => toggleAcct(id)} style={{ background:"none", border:"none", cursor:"pointer", color:"#fff", fontSize:11, padding:0 }}>✕</button>
              </span>
            ) : null;
          })}
          <button onClick={resetFilters} style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, cursor: "pointer", border: `0.5px solid var(--color-border-secondary)`, background: "none", color: "var(--color-text-secondary)" }}>
            Clear all
          </button>
        </div>
      )}

      {/* ── Transaction list ── */}
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
              <div key={group.label} style={{ background: BG, borderRadius: 16, overflow: "hidden", border: `0.5px solid var(--color-border-secondary)`, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: `0.5px solid ${BORDER}`, background: BG2 }}>
                  <span style={{ fontWeight: 700, fontSize: 15, color: "var(--color-text-primary)" }}>{group.label}</span>
                  <span style={{ fontWeight: 700, fontSize: 14, color: groupNet >= 0 ? GREEN : "#cc2222" }}>
                    {groupNet >= 0 ? "+" : "-"}₹{Math.abs(groupNet).toLocaleString("en-IN", { maximumFractionDigits: 1 })}
                  </span>
                </div>
                {group.items.slice().sort((a, b) => new Date(b.date) - new Date(a.date) || (b.id - a.id)).map((t, idx, arr) => {
                  const acct = accounts.find(b => String(b.id) === String(t.bankId));
                  const { bg, iconColor } = getCategoryColorLight(t.category || t.note, t.type);
                  const emoji = getCategoryIcon(t.category || t.note);
                  const isIncome = t.type === "income";
                  return (
                    <div key={t.id} onClick={() => setEditTx && setEditTx({ ...t })}
                      style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", borderBottom: idx < arr.length - 1 ? `0.5px solid ${BORDER}` : "none", cursor: "pointer", transition: "background 0.12s" }}
                      onMouseEnter={e => e.currentTarget.style.background = BG2}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                    >
                      <div style={{ width: 44, height: 44, borderRadius: 13, background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0, border: `0.5px solid ${iconColor}33` }}>
                        {emoji}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 14, color: "var(--color-text-primary)", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {t.category || t.note || "Uncategorized"}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--color-text-secondary)" }}>
                          {acct && <><span style={{ fontSize: 11 }}>🏛</span><span>{acct.name}</span></>}
                          {t.note && t.category && <span style={{ color: "var(--color-border-primary)" }}>· {t.note}</span>}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ marginBottom: 4 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, background: isIncome ? "#e8f5ee" : "#fff0f0", color: isIncome ? GREEN : "#cc2222", borderRadius: 5, padding: "2px 7px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                              {isIncome ? "Income" : "Expense"}
                            </span>
                          </div>
                          <div style={{ fontWeight: 700, fontSize: 15, color: isIncome ? GREEN : "var(--color-text-primary)" }}>
                            ₹{Number(t.amount).toLocaleString("en-IN", { maximumFractionDigits: 1 })}
                          </div>
                          {t.time && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{t.time}</div>}
                        </div>
                        <button onClick={e => { e.stopPropagation(); update(p => ({ transactions: p.transactions.filter(x => x.id !== t.id) })); }}
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

      {/* ── Transfer History Section ── */}
      {(() => {
        const transfers = (data.transactions || [])
          .filter(t => t.isTransfer && t.transferRole === "out")
          .sort((a, b) => b.date.localeCompare(a.date));
        if (transfers.length === 0) return null;
        function getAcct(id) { return accounts.find(a => String(a.id) === String(id)); }
        function badgeStyle(id) {
          const t = getAcct(id)?.type;
          if (t === "Credit Card") return { background: "#fff3e0", color: "#e65100" };
          if (t === "Cash") return { background: "#f0fdf4", color: "#166534" };
          return { background: "#e8f5ee", color: "#1a6b3c" };
        }
        function deleteTransfer(pairId) {
          if (!window.confirm("Delete this transfer? Both entries will be removed.")) return;
          update(p => ({ transactions: p.transactions.filter(t => t.transferPairId !== pairId) }));
        }
        function saveInlineEdit(ef) {
          const amt = parseFloat(ef.amount);
          if (!amt || amt <= 0) return;
          const note = ef.note.trim() || "Account Transfer";
          update(p => ({
            transactions: p.transactions.map(t => {
              if (t.transferPairId !== ef.pairId) return t;
              if (t.transferRole === "out") return { ...t, bankId: ef.fromId, transferToId: ef.toId, amount: amt, note, date: ef.date };
              if (t.transferRole === "in")  return { ...t, bankId: ef.toId, transferFromId: ef.fromId, amount: amt, note, date: ef.date };
              return t;
            })
          }));
        }
        return (
          <div style={{ marginTop: 28 }}>
            {/* Section header */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1, height: "0.5px", background: "var(--color-border-tertiary)" }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                ↔ Transfer History · {transfers.length}
              </span>
              <div style={{ flex: 1, height: "0.5px", background: "var(--color-border-tertiary)" }} />
            </div>
            <div style={{ background: BG, borderRadius: 16, border: `0.5px solid var(--color-border-secondary)`, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
              {transfers.map((t, idx) => {
                const toAcct = getAcct(t.transferToId);
                const fromAcct = getAcct(t.bankId);
                return (
                  <TransferHistoryRow
                    key={t.id}
                    t={t}
                    idx={idx}
                    total={transfers.length}
                    fromAcct={fromAcct}
                    toAcct={toAcct}
                    accounts={accounts}
                    badgeStyle={badgeStyle}
                    BG={BG} BG2={BG2} BORDER={BORDER} GREEN={GREEN}
                    onDelete={() => deleteTransfer(t.transferPairId)}
                    onSaveEdit={saveInlineEdit}
                  />
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════════════════════════
          FILTER PANEL — bottom sheet on mobile, right-anchored panel on desktop
      ══════════════════════════════════════════════════════════════════ */}
      {showFilter && (
        <>
          {/* Backdrop */}
          <div onClick={() => setShowFilter(false)} style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.25)" }} />

          {/* Panel — slides up from bottom on mobile, floats right on desktop */}
          <div style={{
            position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 501,
            background: BG, borderRadius: "20px 20px 0 0",
            boxShadow: "0 -8px 40px rgba(0,0,0,0.14)",
            maxHeight: "80vh", overflowY: "auto", WebkitOverflowScrolling: "touch",
            border: `0.5px solid var(--color-border-secondary)`,
          }}>
            {/* Drag handle */}
            <div style={{ display: "flex", justifyContent: "center", paddingTop: 12, paddingBottom: 2 }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: "var(--color-border-primary)" }} />
            </div>

            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px 16px" }}>
              <span style={{ fontWeight: 700, fontSize: 18, color: "var(--color-text-primary)" }}>Filter</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={resetFilters} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 14px", borderRadius: 20, border: `0.5px solid var(--color-border-secondary)`, background: BG2, cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)", fontWeight: 500 }}>
                  ↺ Reset
                </button>
                <button onClick={() => setShowFilter(false)} style={{ width: 32, height: 32, borderRadius: "50%", border: `0.5px solid var(--color-border-secondary)`, background: BG2, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)" }}>✕</button>
              </div>
            </div>

            <div style={{ padding: "0 20px 32px", display: "flex", flexDirection: "column", gap: 24 }}>

              {/* ── Section 1: Date ── */}
              <div>
                {/* Sub-tabs: Year/month vs Date range */}
                <div style={{ display: "flex", gap: 20, marginBottom: 14 }}>
                  {[["ym","Year / month"],["range","Date range"]].map(([v, lbl]) => (
                    <button key={v} onClick={() => setFilterDateMode(v)} style={{
                      fontSize: 14, fontWeight: filterDateMode === v ? 700 : 400,
                      color: filterDateMode === v ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                      background: "none", border: "none", cursor: "pointer", padding: 0,
                      borderBottom: filterDateMode === v ? `2px solid ${GREEN}` : "2px solid transparent", paddingBottom: 3,
                    }}>{lbl}</button>
                  ))}
                </div>

                {filterDateMode === "ym" ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button onClick={() => setFilterYearMonth("all")} style={chipStyle(filterYearMonth === "all")}>All</button>
                    {yearMonthOptions.years.map(y  => (
                      <button key={y}  onClick={() => setFilterYearMonth(filterYearMonth === y  ? "all" : y)}  style={chipStyle(filterYearMonth === y)}>{y}</button>
                    ))}
                    {yearMonthOptions.months.map(ym => (
                      <button key={ym} onClick={() => setFilterYearMonth(filterYearMonth === ym ? "all" : ym)} style={chipStyle(filterYearMonth === ym)}>{fmtYM(ym)}</button>
                    ))}
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>From</label>
                      <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>To</label>
                      <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} />
                    </div>
                  </div>
                )}
              </div>

              {/* ── Section 2: Category ── */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <span style={{ fontWeight: 700, fontSize: 15, color: "var(--color-text-primary)" }}>Category</span>
                  {filterCats.length > 0 && (
                    <button onClick={() => setFilterCats([])} style={{ fontSize: 12, color: GREEN, background: "none", border: "none", cursor: "pointer" }}>○ Select all</button>
                  )}
                </div>
                {/* All / Spending / Income segmented toggle */}
                <div style={{ display: "flex", background: BG2, borderRadius: 22, padding: 3, gap: 2, marginBottom: 12, border: `0.5px solid var(--color-border-secondary)` }}>
                  {["All","Spending","Income"].map(v => (
                    <button key={v} onClick={() => { setFilterCatType(v); setFilterCats([]); }}
                      style={{ flex: 1, padding: "7px 0", borderRadius: 18, border: "none", cursor: "pointer", fontSize: 13,
                        fontWeight: filterCatType === v ? 600 : 400,
                        background: filterCatType === v ? BG : "transparent",
                        color: filterCatType === v ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                        boxShadow: filterCatType === v ? "0 1px 4px rgba(0,0,0,0.10)" : "none", transition: "all 0.15s" }}>
                      {v}
                    </button>
                  ))}
                </div>
                {/* Category chips */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {displayedCats.length === 0
                    ? <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>No categories found</span>
                    : displayedCats.map(cat => (
                        <button key={cat} onClick={() => toggleCat(cat)} style={{
                          padding: "6px 16px", borderRadius: 20, fontSize: 13, cursor: "pointer",
                          border: filterCats.includes(cat) ? `1.5px solid ${GREEN}` : `0.5px solid var(--color-border-secondary)`,
                          background: filterCats.includes(cat) ? "#e8f5ee" : BG2,
                          color: filterCats.includes(cat) ? GREEN : "var(--color-text-secondary)",
                          fontWeight: filterCats.includes(cat) ? 600 : 400, transition: "all 0.15s",
                        }}>{cat}</button>
                      ))
                  }
                </div>
              </div>

              {/* ── Section 3: Payment Mode ── */}
              {accounts.length > 0 && (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <span style={{ fontWeight: 700, fontSize: 15, color: "var(--color-text-primary)" }}>Payment mode</span>
                    {filterAccounts.length > 0 && (
                      <button onClick={() => setFilterAccounts([])} style={{ fontSize: 12, color: GREEN, background: "none", border: "none", cursor: "pointer" }}>○ Select all</button>
                    )}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {accounts.map(a => {
                      const active = filterAccounts.includes(String(a.id));
                      return (
                        <button key={a.id} onClick={() => toggleAcct(String(a.id))} style={{
                          padding: "6px 16px", borderRadius: 20, fontSize: 13, cursor: "pointer",
                          border: active ? `1.5px solid ${GREEN}` : `0.5px solid var(--color-border-secondary)`,
                          background: active ? "#e8f5ee" : BG2,
                          color: active ? GREEN : "var(--color-text-secondary)",
                          fontWeight: active ? 600 : 400, transition: "all 0.15s",
                        }}>{a.name}</button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── Apply / close ── */}
              <button onClick={() => setShowFilter(false)} style={{
                width: "100%", background: GREEN, color: "#fff", border: "none",
                borderRadius: 12, padding: "14px 0", fontSize: 15, fontWeight: 700,
                cursor: "pointer", letterSpacing: "0.02em",
              }}>
                Show {allTx.length} Transaction{allTx.length !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        </>
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
          <div onClick={() => setShowFilter(false)} style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.35)", backdropFilter: "blur(2px)" }} />
          {/* Sheet */}
          <div style={{
            position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 501,
            background: BG, borderRadius: "20px 20px 0 0",
            boxShadow: "0 -8px 40px rgba(0,0,0,0.18)",
            maxHeight: "82vh", overflowY: "auto",
            border: `0.5px solid ${BORDER}`,
            WebkitOverflowScrolling: "touch",
          }}>
            {/* Handle bar */}
            <div style={{ display: "flex", justifyContent: "center", paddingTop: 12, paddingBottom: 4 }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: "var(--color-border-primary)" }} />
            </div>

            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px 16px" }}>
              <span style={{ fontWeight: 700, fontSize: 18 }}>Filter</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={resetFilters} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 14px", borderRadius: 20, border: `0.5px solid ${BORDER}`, background: BG2, cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)", fontWeight: 500 }}>
                  ↺ Reset
                </button>
                <button onClick={() => setShowFilter(false)} style={{ width: 32, height: 32, borderRadius: "50%", border: `0.5px solid ${BORDER}`, background: BG2, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)" }}>✕</button>
              </div>
            </div>

            <div style={{ padding: "0 20px 32px", display: "flex", flexDirection: "column", gap: 24 }}>

              {/* ── Section 1: Date ── */}
              <div>
                <div style={{ display: "flex", gap: 20, marginBottom: 14 }}>
                  <button onClick={() => setFilterDateMode("ym")} style={{ fontSize: 14, fontWeight: filterDateMode === "ym" ? 700 : 400, color: filterDateMode === "ym" ? "var(--color-text-primary)" : "var(--color-text-secondary)", background: "none", border: "none", cursor: "pointer", padding: 0, borderBottom: filterDateMode === "ym" ? `2px solid ${GREEN}` : "2px solid transparent", paddingBottom: 2 }}>
                    Year / month
                  </button>
                  <button onClick={() => setFilterDateMode("range")} style={{ fontSize: 14, fontWeight: filterDateMode === "range" ? 700 : 400, color: filterDateMode === "range" ? "var(--color-text-primary)" : "var(--color-text-secondary)", background: "none", border: "none", cursor: "pointer", padding: 0, borderBottom: filterDateMode === "range" ? `2px solid ${GREEN}` : "2px solid transparent", paddingBottom: 2 }}>
                    Date range
                  </button>
                </div>

                {filterDateMode === "ym" ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button onClick={() => setFilterYearMonth("all")} style={chip(filterYearMonth === "all")}>All</button>
                    {yearMonthOptions.years.map(y => (
                      <button key={y} onClick={() => setFilterYearMonth(filterYearMonth === y ? "all" : y)} style={chip(filterYearMonth === y)}>{y}</button>
                    ))}
                    {yearMonthOptions.months.map(ym => (
                      <button key={ym} onClick={() => setFilterYearMonth(filterYearMonth === ym ? "all" : ym)} style={chip(filterYearMonth === ym)}>{fmtYM(ym)}</button>
                    ))}
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>From</label>
                      <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>To</label>
                      <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} />
                    </div>
                  </div>
                )}
              </div>

              {/* ── Section 2: Category ── */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>Category</span>
                  {filterCats.length > 0 && (
                    <button onClick={() => setFilterCats([])} style={{ fontSize: 12, color: GREEN, background: "none", border: "none", cursor: "pointer", padding: 0 }}>○ Select all</button>
                  )}
                </div>
                {/* All / Spending / Income toggle */}
                <div style={{ display: "flex", background: BG2, borderRadius: 22, padding: 3, gap: 2, marginBottom: 12, border: `0.5px solid ${BORDER}` }}>
                  {["All", "Spending", "Income"].map(v => (
                    <button key={v} onClick={() => { setFilterCatType(v); setFilterCats([]); }}
                      style={{ flex: 1, padding: "6px 0", borderRadius: 18, border: "none", cursor: "pointer", fontSize: 13, fontWeight: filterCatType === v ? 600 : 400, background: filterCatType === v ? BG : "transparent", color: filterCatType === v ? "var(--color-text-primary)" : "var(--color-text-secondary)", boxShadow: filterCatType === v ? "0 1px 4px rgba(0,0,0,0.1)" : "none", transition: "all 0.15s" }}>
                      {v}
                    </button>
                  ))}
                </div>
                {/* Category chips */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {displayedCats.length === 0 ? (
                    <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>No categories yet</span>
                  ) : displayedCats.map(cat => (
                    <button key={cat} onClick={() => toggleCat(cat)}
                      style={{ padding: "6px 16px", borderRadius: 20, fontSize: 13, cursor: "pointer", border: filterCats.includes(cat) ? `1.5px solid ${GREEN}` : `0.5px solid ${BORDER}`, background: filterCats.includes(cat) ? "#e8f5ee" : BG2, color: filterCats.includes(cat) ? GREEN : "var(--color-text-secondary)", fontWeight: filterCats.includes(cat) ? 600 : 400, transition: "all 0.15s" }}>
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Section 3: Payment Mode ── */}
              {accounts.length > 0 && (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <span style={{ fontWeight: 700, fontSize: 15 }}>Payment mode</span>
                    {filterAccounts.length > 0 && (
                      <button onClick={() => setFilterAccounts([])} style={{ fontSize: 12, color: GREEN, background: "none", border: "none", cursor: "pointer", padding: 0 }}>○ Select all</button>
                    )}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {accounts.map(a => {
                      const active = filterAccounts.includes(String(a.id));
                      return (
                        <button key={a.id} onClick={() => toggleAccount(String(a.id))}
                          style={{ padding: "6px 16px", borderRadius: 20, fontSize: 13, cursor: "pointer", border: active ? `1.5px solid ${GREEN}` : `0.5px solid ${BORDER}`, background: active ? "#e8f5ee" : BG2, color: active ? GREEN : "var(--color-text-secondary)", fontWeight: active ? 600 : 400, transition: "all 0.15s" }}>
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── Apply button ── */}
              <button onClick={() => setShowFilter(false)} style={{ width: "100%", background: GREEN, color: "#fff", border: "none", borderRadius: 12, padding: "14px 0", fontSize: 15, fontWeight: 700, cursor: "pointer", letterSpacing: "0.02em" }}>
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

function StatCard({ label, value, sub, icon, danger, pnl, big, accent, tooltip }) {
  const color = pnl !== undefined ? (pnl >= 0 ? "#1a6b3c" : "#d44") : danger ? "#d44" : "var(--color-text-primary)";
  return (
    <div title={tooltip} style={{ background: accent ? "#e8f5ee" : "var(--color-background-secondary)", borderRadius: 12, padding: big ? "1.2rem" : "0.9rem", border: "0.5px solid var(--color-border-tertiary)", cursor: tooltip ? "help" : "default" }}>
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
    <div style={{ overflowX: "auto", overflowY: "hidden", WebkitOverflowScrolling: "touch", marginBottom: 4 }}>
      <div style={{ display: "flex", borderBottom: "0.5px solid var(--color-border-tertiary)", minWidth: "max-content" }}>
        {tabs.map((t, i) => (
          <button key={t} onClick={() => setActive(t)} style={{ padding: "8px 14px", background: "none", border: "none", cursor: "pointer", fontSize: 14, color: active === t ? "var(--color-text-primary)" : "var(--color-text-secondary)", fontWeight: active === t ? 500 : 400, borderBottom: active === t ? "2px solid #1a6b3c" : "2px solid transparent", marginBottom: -1, whiteSpace: "nowrap" }}>
            {labels ? labels[i] : t}
          </button>
        ))}
      </div>
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
// ─── Portfolio Hub — tabs: Overall / Indian Stocks / US Stocks / Mutual Funds ─
