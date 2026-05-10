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
  transactions: [],
  banks: [],
  liabilities: [],
  scheduledPayments: [],
  liabilityTypes: ["Credit Card", "Personal Loan", "Car Loan", "Home Loan", "Other"],
  categories: { expense: ["Food", "Rent", "Travel", "Shopping", "Health", "Bills", "EMI", "Other"], income: ["Salary", "Freelance", "Investment", "Business", "Gift", "Other"] },
  overviewTodos: [],
};




const fmt = (n) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n || 0);
const fmtCur = (n) => "₹" + fmt(n);
const fmtPct = (n) => (n >= 0 ? "+" : "") + (n || 0).toFixed(2) + "%";

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
  const [settingsTab, setSettingsTab]   = useState("profile");
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


  // Net worth = bank balances
  const linkedBankIds = new Set((data.banks || []).map(b => String(b.id)));
  const unlinkedIncome = data.transactions.filter(t => t.type === "income" && (!t.bankId || !linkedBankIds.has(String(t.bankId)))).reduce((s, t) => s + Number(t.amount || 0), 0);
  const unlinkedExpense = data.transactions.filter(t => t.type === "expense" && (!t.bankId || !linkedBankIds.has(String(t.bankId)))).reduce((s, t) => s + Number(t.amount || 0), 0);
  const netWorth = (data.banks || []).reduce((s, b) => {
    const inc = data.transactions.filter(t => t.type === "income" && String(t.bankId) === String(b.id)).reduce((a, t) => a + Number(t.amount || 0), 0);
    const exp = data.transactions.filter(t => t.type === "expense" && String(t.bankId) === String(b.id)).reduce((a, t) => a + Number(t.amount || 0), 0);
    if (b.type === "Credit Card") return s - ((b.openingBalance || 0) + exp - inc);
    return s + (b.openingBalance || 0) + inc - exp;
  }, 0) + (unlinkedIncome - unlinkedExpense);

  // ── Auth gates ────────────────────────────────────────────────────────────
  if (firebaseUser === undefined) return <SplashScreen msg="Loading…" />;
  if (firebaseUser === null)      return <SignInPage />;
  if (!dataReady)                 return <SplashScreen msg="Syncing your data…" />;

  // Only Overview, Money, Settings tabs

  return (
    <>
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

        {/* Money */}
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

            <button onClick={() => setPage("settings")} style={{
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
        {page === "overview" && <Overview data={data} netWorth={netWorth} setPage={setPage} update={update} />}
        {page === "money" && <MoneyPage data={data} update={update} tab={moneyTab} setTab={setMoneyTab} />}
        {page === "settings" && <SettingsPage data={data} update={update} tab={settingsTab} setTab={setSettingsTab} />}
      </main>

      {/* ── Mobile Bottom Navigation Bar ── */}
      {mobile && (
        <nav style={{
          position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 1000,
          background: "var(--color-background-primary)",
          borderTop: "0.5px solid var(--color-border-tertiary)",
          display: "flex", alignItems: "stretch", height: 64,
          paddingBottom: "env(safe-area-inset-bottom)",
        }}>
          {[["overview","⊞","Overview"],["money","⊕","Money"],["settings","⚙️","Settings"]].map(([id, icon, label]) => (
            <button key={id} onClick={() => setPage(id)} style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", gap: 3, border: "none", background: "transparent",
              cursor: "pointer", fontSize: 10, fontWeight: 500,
              color: page === id ? "#1a6b3c" : "var(--color-text-secondary)",
            }}>
              <span style={{ fontSize: 22 }}>{icon}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
    </>
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

      {/* To-Do */}
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

function SettingsPage({ data, update, tab, setTab }) {
  const cardStyle = { background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1.2rem 1.4rem", marginBottom: 14 };
  const sectionTitle = (t) => <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>{t}</div>;
  return (
    <div>
      <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26, marginBottom: 20 }}>Settings</h1>
      <TabBar tabs={["profile", "money"]} active={tab} setActive={setTab} labels={["Profile", "Money Settings"]} />
      <div style={{ marginTop: 16 }}>
        {tab === "profile" && <ProfilePage data={data} update={update} />}
        {tab === "money" && <AccountSettings data={data} update={update} cardStyle={cardStyle} sectionTitle={sectionTitle} />}
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

function TransferTab({ data, update, accounts }) {
  const [form, setForm] = useState({ fromId: "", toId: "", amount: "", note: "", date: today() });
  const [error, setError] = useState("");
  const [editTransfer, setEditTransfer] = useState(null); // { pairId, fromId, toId, amount, note, date }

  const transfers = (data.transactions || [])
    .filter(t => t.isTransfer && t.transferRole === "out")
    .sort((a, b) => b.date.localeCompare(a.date));

  function getAcctName(id) {
    const a = accounts.find(a => String(a.id) === String(id));
    return a ? a.name : "—";
  }
  function getAcctType(id) {
    return accounts.find(a => String(a.id) === String(id))?.type || "Bank";
  }
  function badgeStyle(id) {
    const t = getAcctType(id);
    if (t === "Credit Card") return { background: "#fff3e0", color: "#e65100" };
    if (t === "Cash") return { background: "#f0fdf4", color: "#166534" };
    return { background: "#e8f5ee", color: "#1a6b3c" };
  }

  function doTransfer() {
    setError("");
    const amt = parseFloat(form.amount);
    if (!form.fromId) return setError("Select a source account.");
    if (!form.toId)   return setError("Select a destination account.");
    if (form.fromId === form.toId) return setError("Source and destination can't be the same.");
    if (!amt || amt <= 0) return setError("Enter a valid amount.");
    const pairId = "tf_" + Date.now();
    const note   = form.note.trim() || "Account Transfer";
    const date   = form.date || today();
    update(p => ({
      transactions: [
        ...p.transactions,
        { id: Date.now(),     type: "expense", amount: amt, category: "Transfer", note, date, bankId: form.fromId, isTransfer: true, transferRole: "out", transferPairId: pairId, transferToId: form.toId },
        { id: Date.now() + 1, type: "income",  amount: amt, category: "Transfer", note, date, bankId: form.toId,   isTransfer: true, transferRole: "in",  transferPairId: pairId, transferFromId: form.fromId },
      ]
    }));
    setForm(p => ({ ...p, amount: "", note: "" }));
  }

  function deleteTransfer(pairId) {
    if (!window.confirm("Delete this transfer? Both debit and credit entries will be removed.")) return;
    update(p => ({ transactions: p.transactions.filter(t => t.transferPairId !== pairId) }));
  }

  function openEditTransfer(t) {
    setEditTransfer({ pairId: t.transferPairId, fromId: String(t.bankId), toId: String(t.transferToId), amount: String(t.amount), note: t.note === "Account Transfer" ? "" : (t.note || ""), date: t.date });
  }

  function saveEditTransfer() {
    if (!editTransfer) return;
    const amt = parseFloat(editTransfer.amount);
    if (!amt || amt <= 0) return;
    const note = editTransfer.note.trim() || "Account Transfer";
    update(p => ({
      transactions: p.transactions.map(t => {
        if (t.transferPairId !== editTransfer.pairId) return t;
        if (t.transferRole === "out") return { ...t, bankId: editTransfer.fromId, transferToId: editTransfer.toId, amount: amt, note, date: editTransfer.date };
        if (t.transferRole === "in")  return { ...t, bankId: editTransfer.toId, transferFromId: editTransfer.fromId, amount: amt, note, date: editTransfer.date };
        return t;
      })
    }));
    setEditTransfer(null);
  }

  const acctGroups = [
    { label: "🏦 Bank Accounts", list: accounts.filter(a => a.type === "Bank") },
    { label: "💳 Credit Cards",  list: accounts.filter(a => a.type === "Credit Card") },
    { label: "💵 Cash",          list: accounts.filter(a => a.type === "Cash") },
  ].filter(g => g.list.length > 0);

  return (
    <div>
      {/* Edit Transfer Modal */}
      {editTransfer && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 16, padding: "1.5rem", width: "min(400px, 90vw)", border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 16 }}>✏️ Edit Transfer</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>From Account</label>
                <select value={editTransfer.fromId} onChange={e => setEditTransfer(p => ({ ...p, fromId: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
                  {accounts.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>To Account</label>
                <select value={editTransfer.toId} onChange={e => setEditTransfer(p => ({ ...p, toId: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
                  {accounts.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Amount (₹)</label>
                <input type="number" value={editTransfer.amount} onChange={e => setEditTransfer(p => ({ ...p, amount: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontWeight: 600 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Date</label>
                <input type="date" value={editTransfer.date} onChange={e => setEditTransfer(p => ({ ...p, date: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Note (optional)</label>
                <input value={editTransfer.note} onChange={e => setEditTransfer(p => ({ ...p, note: e.target.value }))} placeholder="e.g. Savings transfer" style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => setEditTransfer(null)} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "8px 16px", cursor: "pointer", color: "var(--color-text-secondary)" }}>Cancel</button>
              <button onClick={saveEditTransfer} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontWeight: 600 }}>Save Changes</button>
            </div>
          </div>
        </div>
      )}
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 16, marginTop: 16 }}>

      {/* Left: form */}
      <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1.2rem" }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
          <span>↔</span> Transfer Money
        </div>

        {accounts.length < 2 && (
          <div style={{ background: "#fef9c3", border: "0.5px solid #fbbf24", borderRadius: 8, padding: "10px 12px", fontSize: 12, color: "#92400e", marginBottom: 14 }}>
            ⚠ You need at least 2 accounts to make a transfer.
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>From Account *</label>
          <select value={form.fromId} onChange={e => setForm(p => ({ ...p, fromId: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
            <option value="">— Select source —</option>
            {acctGroups.map(g => (
              <optgroup key={g.label} label={g.label}>
                {g.list.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </optgroup>
            ))}
          </select>
        </div>

        <div style={{ textAlign: "center", fontSize: 22, color: "#1a6b3c", margin: "2px 0 10px", fontWeight: 700 }}>↓</div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>To Account *</label>
          <select value={form.toId} onChange={e => setForm(p => ({ ...p, toId: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
            <option value="">— Select destination —</option>
            {acctGroups.map(g => (
              <optgroup key={g.label} label={g.label}>
                {g.list.filter(a => String(a.id) !== String(form.fromId)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </optgroup>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Amount (₹) *</label>
          <input type="number" placeholder="e.g. 5000" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Note (optional)</label>
          <input type="text" placeholder="e.g. Savings transfer, Bill payment" value={form.note} onChange={e => setForm(p => ({ ...p, note: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Date</label>
          <input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
        </div>

        {error && (
          <div style={{ fontSize: 12, color: "#d44", marginBottom: 10, background: "#fdf0f0", borderRadius: 6, padding: "6px 10px" }}>⚠ {error}</div>
        )}

        {/* Live preview */}
        {form.fromId && form.toId && parseFloat(form.amount) > 0 && (
          <div style={{ background: "#f0f9ff", border: "0.5px solid #bae6fd", borderRadius: 8, padding: "10px 12px", marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#0369a1", marginBottom: 6 }}>📋 Preview</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ ...badgeStyle(form.fromId), borderRadius: 5, padding: "2px 8px", fontSize: 12, fontWeight: 500 }}>{getAcctName(form.fromId)}</span>
              <span style={{ fontWeight: 700, color: "#0369a1", fontSize: 16 }}>→</span>
              <span style={{ ...badgeStyle(form.toId), borderRadius: 5, padding: "2px 8px", fontSize: 12, fontWeight: 500 }}>{getAcctName(form.toId)}</span>
              <span style={{ marginLeft: "auto", fontWeight: 700, color: "#0369a1", fontSize: 14 }}>₹{parseFloat(form.amount).toLocaleString("en-IN")}</span>
            </div>
            <div style={{ fontSize: 10, color: "#64748b", marginTop: 6 }}>
              This will create an expense on <b>{getAcctName(form.fromId)}</b> and an income on <b>{getAcctName(form.toId)}</b>. Both are hidden from Expenses/Income tabs.
            </div>
          </div>
        )}

        <button onClick={doTransfer} disabled={accounts.length < 2}
          style={{ width: "100%", background: accounts.length < 2 ? "#ccc" : "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "10px 0", cursor: accounts.length < 2 ? "not-allowed" : "pointer", fontSize: 14, fontWeight: 600 }}>
          ↔ Transfer
        </button>
      </div>

      {/* Right: history */}
      <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1.2rem" }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 14 }}>
          Transfer History
          <span style={{ fontSize: 11, fontWeight: 400, color: "var(--color-text-secondary)", marginLeft: 8 }}>{transfers.length} transfers</span>
        </div>

        {transfers.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3.5rem 1rem", color: "var(--color-text-secondary)", fontSize: 13 }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>↔</div>
            No transfers yet.<br/>Use the form to move money between accounts.
          </div>
        ) : (
          <div style={{ margin: "0 -1.2rem -1.2rem" }}>
            {transfers.map((t, idx) => {
              const toAcct = accounts.find(a => String(a.id) === String(t.transferToId));
              const fromAcct = accounts.find(a => String(a.id) === String(t.bankId));
              function bStyle(id) {
                const type = accounts.find(a => String(a.id) === String(id))?.type;
                if (type === "Credit Card") return { background: "#fff3e0", color: "#e65100" };
                if (type === "Cash") return { background: "#f0fdf4", color: "#166534" };
                return { background: "#e8f5ee", color: "#1a6b3c" };
              }
              return (
                <TransferHistoryRow
                  key={t.id}
                  t={t}
                  idx={idx}
                  total={transfers.length}
                  fromAcct={fromAcct}
                  toAcct={toAcct}
                  accounts={accounts}
                  badgeStyle={bStyle}
                  BG="var(--color-background-primary)"
                  BG2="var(--color-background-secondary)"
                  BORDER="var(--color-border-tertiary)"
                  GREEN="#1a6b3c"
                  onDelete={() => deleteTransfer(t.transferPairId)}
                  onSaveEdit={(ef) => {
                    const amt = parseFloat(ef.amount);
                    if (!amt || amt <= 0) return;
                    const note = ef.note.trim() || "Account Transfer";
                    update(p => ({
                      transactions: p.transactions.map(tx => {
                        if (tx.transferPairId !== ef.pairId) return tx;
                        if (tx.transferRole === "out") return { ...tx, bankId: ef.fromId, transferToId: ef.toId, amount: amt, note, date: ef.date };
                        if (tx.transferRole === "in")  return { ...tx, bankId: ef.toId, transferFromId: ef.fromId, amount: amt, note, date: ef.date };
                        return tx;
                      })
                    }));
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
    </div>
  );
}

// ─── Scheduled Payments Tab ──────────────────────────────────────────────────

// ═══════════════════════════ ANALYSIS TAB ═══════════════════════════════════
function AnalysisTab({ data, update, accounts }) {
  const [view,     setView]     = useState("graph");
  const [period,   setPeriod]   = useState("6M");
  const [calYear,  setCalYear]  = useState(new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [calDay,   setCalDay]   = useState(null);

  // ── Office / commute settings ──────────────────────────────────────────────
  const [showCommuteSetup, setShowCommuteSetup] = useState(false);
  const commuteSettings = data.commuteSettings || { busFare: 0, bankId: "", category: "Transport", note: "Bus fare" };
  // leaves: Set of date strings "YYYY-MM-DD" stored in data.commuteLeaves
  const commuteLeaves = data.commuteLeaves || [];

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
          <svg width={240} height={220} style={{flexShrink:0,maxWidth:"100%"}}>
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

    const pad = n => String(n).padStart(2,"0");

    const dayMap={};
    txns.forEach(t=>{
      if(t.isTransfer) return;
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

    const selTxns=calDay?(dayMap[calDay]?.txns||[]).filter(t=>!t.isTransfer):[];
    const today=new Date();

    function prev(){if(calMonth===0){setCalMonth(11);setCalYear(y=>y-1);}else setCalMonth(m=>m-1);setCalDay(null);}
    function next(){if(calMonth===11){setCalMonth(0);setCalYear(y=>y+1);}else setCalMonth(m=>m+1);setCalDay(null);}

    const mIncome=Object.values(dayMap).reduce((s,d)=>s+d.income,0);
    const mExpense=Object.values(dayMap).reduce((s,d)=>s+d.expense,0);

    return (
      <div>
        <div style={{display:"flex",gap:24,flexWrap:"wrap",alignItems:"flex-start"}}>
          {/* Calendar grid */}
          <div style={{flex:"1 1 auto",minWidth:0,maxWidth:"100%"}}>
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
                const dow=new Date(calYear,calMonth,day).getDay();
                const isWeekend=dow===0||dow===6;
                return (
                  <div key={day} onClick={()=>setCalDay(isSel?null:day)}
                    style={{borderRadius:8,padding:"4px 3px",minHeight:58,cursor:"pointer",
                      background:isSel?"#1a6b3c":isToday?"#f0fdf4":isWeekend?"#f8f8f8":"var(--color-background-secondary)",
                      border:isSel?"2px solid #1a6b3c":isToday?"1.5px solid #bbf7d0":isWeekend?"1px solid #e5e7eb":"1px solid var(--color-border-tertiary)",
                      display:"flex",flexDirection:"column",alignItems:"center",gap:1,transition:"background 0.1s"}}>
                    <span style={{fontSize:11,fontWeight:isToday||isSel?700:400,
                      color:isSel?"#fff":isWeekend?"#9ca3af":isToday?"#1a6b3c":"var(--color-text-primary)"}}>
                      {day}
                    </span>
                    {info?.income>0&&<span style={{fontSize:7,background:isSel?"rgba(255,255,255,0.2)":"#dcfce7",color:isSel?"#fff":"#166534",borderRadius:3,padding:"0 3px",lineHeight:"13px"}}>+{fmtCur(info.income)}</span>}
                    {info?.expense>0&&<span style={{fontSize:7,background:isSel?"rgba(255,255,255,0.2)":"#fee2e2",color:isSel?"#fff":"#991b1b",borderRadius:3,padding:"0 3px",lineHeight:"13px"}}>-{fmtCur(info.expense)}</span>}
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

          {/* Right panel — selected day transactions */}
          <div style={{flex:1,minWidth:220}}>
            {calDay ? (
              <>
                <div style={{fontWeight:700,fontSize:14,marginBottom:8}}>
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
              <div style={{color:"var(--color-text-secondary)",fontSize:13,paddingTop:8,display:"flex",flexDirection:"column",gap:8}}>
                <div style={{fontSize:28,marginBottom:4}}>📅</div>
                <div>Click any day to see transactions.</div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────
  const views=[
    {id:"graph",     label:"📈 Income vs Expense"},
    {id:"calendar",  label:"📅 Calendar"},
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
        {view==="calendar" && <CalendarView/>}

      </div>
    </div>
  );
}
// ═══════════════════════════════════════════════════════════════════════════

function ScheduledPaymentsTab({ data, update, accounts }) {
  const payments = data.scheduledPayments || [];
  const categories = data.categories || { expense: ["Food","Rent","Travel","Shopping","Health","Bills","EMI","Other"], income: ["Salary","Freelance","Investment","Business","Gift","Other"] };
  const [form, setForm] = useState({ name: "", flowType: "expense", type: "EMI", amount: "", day: "", startDate: new Date().toISOString().slice(0, 10), freq: "monthly", customEveryN: "1", customUnit: "months", customWeekDays: [], autoTime: "", tenure: "", notes: "", accountId: "" });
  const [view, setView] = useState("list");
  const [editingPayment, setEditingPayment] = useState(null); // holds the payment being edited
  const [editForm, setEditForm] = useState(null);

  function startEdit(p) {
    setEditingPayment(p.id);
    setEditForm({ name: p.name, flowType: p.flowType, type: p.type, amount: String(p.amount), day: String(p.day), startDate: p.startDate || p.startMonth + "-01", freq: p.freq, customEveryN: p.customEveryN || "1", customUnit: p.customUnit || "months", customWeekDays: p.customWeekDays || [], autoTime: p.autoTime || "", tenure: p.tenure ? String(p.tenure) : "", notes: p.notes || "", accountId: p.accountId || "" });
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
    const needsDay = !(form.freq === 'custom' && form.customUnit === 'weeks');
    if (!form.name.trim() || !form.amount || (needsDay && !form.day)) return;
    const isWeekly = form.freq === "custom" && form.customUnit === "weeks";
    const sd = new Date(form.startDate);
    update(p => ({ scheduledPayments: [...(p.scheduledPayments || []), {
      id: Date.now(), ...form,
      amount: parseFloat(form.amount),
      day: isWeekly ? (sd.getDate()) : parseInt(form.day),
      startMonth: form.startDate.slice(0, 7),
      startDate: form.startDate,
      autoTime: form.autoTime || "",
      tenure: form.tenure ? parseInt(form.tenure) : null,
      paid: []
    }] }));
    setForm(p => ({ ...p, name: "", amount: "", day: "", notes: "", tenure: "" }));
  }

  // ── Auto-pay: mark due/overdue payments as paid and log transactions ────────
  useEffect(() => {
    if (!payments.length) return;
    const now = new Date();
    const nowDate = new Date(now); nowDate.setHours(0,0,0,0);
    const nowHHMM = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

    const updates = [];
    payments.forEach(pay => {
      // For custom weekly payments with multiple days, get all due keys
      if (pay.freq === "custom" && pay.customUnit === "weeks" && pay.customWeekDays && pay.customWeekDays.length > 0) {
        const allDueKeys = getAllDueKeysForWeekly(pay, nowDate);
        allDueKeys.forEach(key => {
          if (pay.paid.includes(key)) return; // already paid
          
          const parts = key.split("-").map(Number);
          const dueDate = new Date(parts[0], parts[1]-1, parts[2]);
          dueDate.setHours(0,0,0,0);
          
          // If autoTime set, only trigger after that time today (or if overdue from past days)
          if (pay.autoTime && dueDate.getTime() === nowDate.getTime()) {
            if (nowHHMM < pay.autoTime) return; // not time yet
          }
          
          updates.push({ pay, key });
        });
      } else {
        // Original logic for non-weekly payments
        const key = getNextDueKey(pay);
        if (!key) return;
        // Determine due date from key
        let dueDate;
        if (pay.freq === "custom" && pay.customUnit === "weeks") {
          const parts = key.split("-").map(Number);
          dueDate = parts.length === 3 ? new Date(parts[0], parts[1]-1, parts[2]) : null;
        } else {
          const [ky, km] = key.split("-").map(Number);
          dueDate = new Date(ky, km-1, pay.day);
        }
        if (!dueDate) return;
        dueDate.setHours(0,0,0,0);
        if (dueDate > nowDate) return; // not due yet
        if (pay.paid.includes(key)) return; // already paid
        // If autoTime set, only trigger after that time today (or if overdue from past days)
        if (pay.autoTime && dueDate.getTime() === nowDate.getTime()) {
          if (nowHHMM < pay.autoTime) return; // not time yet
        }
        updates.push({ pay, key });
      }
    });

    if (!updates.length) return;

    update(p => {
      let scheduledPayments = p.scheduledPayments || [];
      let transactions = p.transactions || [];

      updates.forEach(({ pay, key }) => {
        const current = scheduledPayments.find(x => x.id === pay.id);
        if (!current || current.paid.includes(key)) return;

        // Derive txDate from key
        let txDate;
        if (pay.freq === "custom" && pay.customUnit === "weeks" && key.split("-").length === 3) {
          txDate = key;
        } else {
          const [ky, km] = key.split("-").map(Number);
          txDate = `${ky}-${pad2(km)}-${pad2(pay.day)}`;
        }
        const txType = pay.flowType === "income" ? "income" : "expense";

        const alreadyLogged = transactions.some(t => t.scheduledPaymentId === pay.id && t.scheduledPeriodKey === key);
        if (!alreadyLogged) {
          transactions = [...transactions, {
            id: Date.now() + Math.random(),
            type: txType,
            amount: pay.amount,
            category: pay.type || (txType === "income" ? "Income" : "EMI"),
            note: pay.name + (pay.notes ? ` — ${pay.notes}` : "") + " (auto)",
            date: txDate,
            time: pay.autoTime || "",
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

  // Per-minute interval: auto-add scheduled payments with autoTime set
  useEffect(() => {
    const interval = setInterval(() => {
      // Re-run the same auto-pay logic every minute for time-based triggers
      const payments = data.scheduledPayments || [];
      if (!payments.some(p => p.autoTime)) return; // skip if no timed payments
      const now = new Date();
      const nowDate = new Date(now); nowDate.setHours(0,0,0,0);
      const nowHHMM = pad2(now.getHours()) + ":" + pad2(now.getMinutes());

      const updates = [];
      payments.forEach(pay => {
        if (!pay.autoTime) return;
        
        // For custom weekly payments with multiple days, get all due keys
        if (pay.freq === "custom" && pay.customUnit === "weeks" && pay.customWeekDays && pay.customWeekDays.length > 0) {
          const allDueKeys = getAllDueKeysForWeekly(pay, nowDate);
          allDueKeys.forEach(key => {
            if (pay.paid.includes(key)) return;
            
            const parts = key.split("-").map(Number);
            const dueDate = new Date(parts[0], parts[1]-1, parts[2]);
            dueDate.setHours(0,0,0,0);
            
            if (dueDate.getTime() !== nowDate.getTime()) return; // only trigger on exact due date
            if (nowHHMM < pay.autoTime) return;
            updates.push({ pay, key });
          });
        } else {
          // Original logic for non-weekly payments
          const key = getNextDueKey(pay);
          if (!key) return;
          let dueDate;
          if (pay.freq === "custom" && pay.customUnit === "weeks") {
            const parts = key.split("-").map(Number);
            dueDate = parts.length === 3 ? new Date(parts[0], parts[1]-1, parts[2]) : null;
          } else {
            const [ky, km] = key.split("-").map(Number);
            dueDate = new Date(ky, km-1, pay.day);
          }
          if (!dueDate) return;
          dueDate.setHours(0,0,0,0);
          if (dueDate.getTime() !== nowDate.getTime()) return; // only trigger on exact due date
          if (pay.paid.includes(key)) return;
          if (nowHHMM < pay.autoTime) return;
          updates.push({ pay, key });
        }
      });

      if (!updates.length) return;

      update(p => {
        let scheduledPayments = p.scheduledPayments || [];
        let transactions = p.transactions || [];
        updates.forEach(({ pay, key }) => {
          const current = scheduledPayments.find(x => x.id === pay.id);
          if (!current || current.paid.includes(key)) return;
          let txDate;
          if (pay.freq === "custom" && pay.customUnit === "weeks" && key.split("-").length === 3) {
            txDate = key;
          } else {
            const [ky, km] = key.split("-").map(Number);
            txDate = ky + "-" + pad2(km) + "-" + pad2(pay.day);
          }
          const txType = pay.flowType === "income" ? "income" : "expense";
          const alreadyLogged = transactions.some(t => t.scheduledPaymentId === pay.id && t.scheduledPeriodKey === key);
          if (!alreadyLogged) {
            transactions = [...transactions, {
              id: Date.now() + Math.random(), type: txType, amount: pay.amount,
              category: pay.type || (txType === "income" ? "Income" : "EMI"),
              note: pay.name + (pay.notes ? " — " + pay.notes : "") + " (auto)",
              date: txDate, time: pay.autoTime, bankId: pay.accountId || "",
              scheduledPaymentId: pay.id, scheduledPeriodKey: key,
            }];
          }
          scheduledPayments = scheduledPayments.map(x => x.id === pay.id ? { ...x, paid: [...x.paid, key] } : x);
        });
        return { scheduledPayments, transactions };
      });
    }, 60000);
    return () => clearInterval(interval);
  }); // eslint-disable-line

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

  function pad2(n) { return String(n).padStart(2,"0"); }
  function dateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }

  // Get all due keys for custom weekly payments (multiple days in same week)
  function getAllDueKeysForWeekly(p, nowDate) {
    if (p.freq !== "custom" || p.customUnit !== "weeks" || !p.customWeekDays || p.customWeekDays.length === 0) {
      return [];
    }
    
    const startStr = p.startDate || (p.startMonth + "-01");
    const [sy, sm, sd] = startStr.split("-").map(Number);
    let d = new Date(sy, sm-1, sd);
    d.setHours(0,0,0,0);
    
    const everyN = parseInt(p.customEveryN || 1);
    const dueKeys = [];
    let ct = 0;
    
    // Calculate which week we're in relative to start date
    const weekStartDate = new Date(sy, sm-1, sd);
    weekStartDate.setHours(0,0,0,0);
    
    while (ct < 500 && d <= nowDate) {
      const currentWeekDay = d.getDay() === 0 ? 7 : d.getDay();
      
      // Check if this day is in the selected weekdays
      if (p.customWeekDays.includes(currentWeekDay)) {
        const daysSinceStart = Math.floor((d - weekStartDate) / (1000 * 60 * 60 * 24));
        const weeksSinceStart = Math.floor(daysSinceStart / 7);
        
        // Only include dates that fall on the correct week interval
        if (weeksSinceStart % everyN === 0) {
          const k = dateKey(d);
          if (!p.paid.includes(k) && d <= nowDate) {
            dueKeys.push(k);
          }
        }
      }
      d.setDate(d.getDate() + 1);
      ct++;
    }
    
    return dueKeys;
  }

  function getNextDueKey(p) {
    const now = new Date(); now.setHours(0,0,0,0);
    const startStr = p.startDate || (p.startMonth + "-01");
    const [sy, sm, sd] = startStr.split("-").map(Number);

    // Custom weekly with specific days
    if (p.freq === "custom" && p.customUnit === "weeks" && (p.customWeekDays||[]).length > 0) {
      let d = new Date(sy, sm-1, sd);
      const everyN = parseInt(p.customEveryN||1);
      let ct = 0;
      while (ct < 500) {
        if (d.getDay && p.customWeekDays.includes(d.getDay()===0?7:d.getDay())) {
          const k = dateKey(d);
          if (!p.paid.includes(k)) return k;
        }
        d.setDate(d.getDate() + 1); ct++;
      }
      return null;
    }

    if (p.freq === "once") return startStr.slice(0,7);
    if (p.freq === "annually") {
      let y = sy;
      while (new Date(y, sm-1, p.day) < now) y++;
      return `${y}-${pad2(sm)}`;
    }
    if (p.freq === "quarterly") {
      let d = new Date(sy, sm-1, p.day);
      while (d < now) d.setMonth(d.getMonth()+3);
      return `${d.getFullYear()}-${pad2(d.getMonth()+1)}`;
    }
    // monthly
    let d = new Date(sy, sm-1, p.day), ct = 0;
    while (ct < 300) {
      const k = `${d.getFullYear()}-${pad2(d.getMonth()+1)}`;
      if (!p.paid.includes(k)) return k;
      d.setMonth(d.getMonth()+1); ct++;
    }
    return null;
  }

  function getDueDate(p) {
    const key = getNextDueKey(p);
    if (!key) return null;
    // weekly custom returns full date key YYYY-MM-DD
    if (p.freq === "custom" && p.customUnit === "weeks") {
      const parts = key.split("-").map(Number);
      return parts.length === 3 ? new Date(parts[0], parts[1]-1, parts[2]) : null;
    }
    const [y, m] = key.split("-").map(Number);
    return new Date(y, m-1, p.day);
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
            <div style={{ display: "grid", gridTemplateColumns: editForm.freq === "custom" && editForm.customUnit === "weeks" ? "1fr" : "1fr 1fr", gap: 8 }}>
              <LabelInput label="Amount (₹)" placeholder="e.g. 12500" value={editForm.amount} onChange={v => setEditForm(p => ({ ...p, amount: v }))} />
              {!(editForm.freq === "custom" && editForm.customUnit === "weeks") && (
                <LabelInput label="Day of month (1–31)" placeholder="e.g. 5" value={editForm.day} onChange={v => setEditForm(p => ({ ...p, day: v }))} />
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Start Date</label>
                <input type="date" value={editForm.startDate || ""} onChange={e => setEditForm(p => ({ ...p, startDate: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Auto-add Time (optional)</label>
                <input type="time" value={editForm.autoTime || ""} onChange={e => setEditForm(p => ({ ...p, autoTime: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
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
                  <select value={editForm.customUnit} onChange={e => setEditForm(p => ({ ...p, customUnit: e.target.value, customWeekDays: [] }))} style={{ flex: 1 }}>
                    <option value="days">Day(s)</option><option value="weeks">Week(s)</option>
                    <option value="months">Month(s)</option><option value="years">Year(s)</option>
                  </select>
                </div>
              )}
              {editForm.freq === "custom" && editForm.customUnit === "weeks" && (
                <div style={{ marginTop: 8 }}>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>On which days?</label>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d, i) => {
                      const val = i + 1;
                      const selected = (editForm.customWeekDays || []).includes(val);
                      return (
                        <button key={d} onClick={() => setEditForm(p => ({
                          ...p,
                          customWeekDays: selected
                            ? (p.customWeekDays || []).filter(x => x !== val)
                            : [...(p.customWeekDays || []), val]
                        }))}
                          style={{ padding: "5px 10px", borderRadius: 6, border: "0.5px solid", fontSize: 12, cursor: "pointer", fontWeight: selected ? 600 : 400,
                            borderColor: selected ? "#1a6b3c" : "var(--color-border-secondary)",
                            background: selected ? "#e8f5ee" : "transparent",
                            color: selected ? "#1a6b3c" : "var(--color-text-secondary)" }}>
                          {d}
                        </button>
                      );
                    })}
                  </div>
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))", gap: 16, alignItems: "start" }}>
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
          <div style={{ display: "grid", gridTemplateColumns: form.freq === "custom" && form.customUnit === "weeks" ? "1fr" : "1fr 1fr", gap: 8 }}>
            <LabelInput label="Amount (₹)" placeholder="e.g. 12500" value={form.amount} onChange={v => setForm(p => ({ ...p, amount: v }))} />
            {!(form.freq === "custom" && form.customUnit === "weeks") && (
              <LabelInput label="Day of month (1–31)" placeholder="e.g. 5" value={form.day} onChange={v => setForm(p => ({ ...p, day: v }))} />
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Start Date</label>
              <input type="date" value={form.startDate} onChange={e => setForm(p => ({ ...p, startDate: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Auto-add Time (optional)</label>
              <input type="time" value={form.autoTime} onChange={e => setForm(p => ({ ...p, autoTime: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
            </div>
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
                <select value={form.customUnit} onChange={e => setForm(p => ({ ...p, customUnit: e.target.value, customWeekDays: [] }))} style={{ flex: 1, boxSizing: "border-box" }}>
                  <option value="days">Day(s)</option>
                  <option value="weeks">Week(s)</option>
                  <option value="months">Month(s)</option>
                  <option value="years">Year(s)</option>
                </select>
              </div>
            )}
            {form.freq === "custom" && form.customUnit === "weeks" && (
              <div style={{ marginTop: 8 }}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>On which days?</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d, i) => {
                    const val = i + 1;
                    const selected = (form.customWeekDays || []).includes(val);
                    return (
                      <button key={d} onClick={() => setForm(p => ({
                        ...p,
                        customWeekDays: selected
                          ? (p.customWeekDays || []).filter(x => x !== val)
                          : [...(p.customWeekDays || []), val]
                      }))}
                        style={{ padding: "5px 10px", borderRadius: 6, border: "0.5px solid", fontSize: 12, cursor: "pointer", fontWeight: selected ? 600 : 400,
                          borderColor: selected ? "#1a6b3c" : "var(--color-border-secondary)",
                          background: selected ? "#e8f5ee" : "transparent",
                          color: selected ? "#1a6b3c" : "var(--color-text-secondary)" }}>
                        {d}
                      </button>
                    );
                  })}
                </div>
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
                        {p.flowType === "income" ? "📥" : "📤"} {p.type} · {p.freq === "custom" ? `every ${p.customEveryN || 1} ${p.customUnit || "months"}${p.customUnit === "weeks" && p.customWeekDays && p.customWeekDays.length > 0 ? " on " + ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].filter((_,i) => p.customWeekDays.includes(i+1)).join(", ") : ""}` : p.freq}{p.tenure ? ` · ${p.tenure}mo` : ""}
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
    notes: "",
    interestRate: "",
  });
  
  const [editLiability, setEditLiability] = useState(null);
  const [amountMode, setAmountMode] = useState("monthly"); // "monthly" | "total"
  const [totalAmountInput, setTotalAmountInput] = useState("");
  const [addPaymentMode, setAddPaymentMode] = useState("split"); // "split" | "interestOnly"

  // EMI formula: P * r * (1+r)^n / ((1+r)^n - 1)
  function calcEMI(principal, annualRatePct, months) {
    if (!principal || !months) return 0;
    if (!annualRatePct || annualRatePct <= 0) return principal / months;
    const r = annualRatePct / 12 / 100;
    const n = months;
    return (principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  }

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
      interestRate: parseFloat(liabilityForm.interestRate) || 0,
      active: true,
      _paymentMode: addPaymentMode,
      ...(addPaymentMode === "interestOnly" ? {
        capitalAmount: parseFloat(liabilityForm.capitalAmount) || parseFloat(totalAmountInput) || 0,
        capitalPaymentDay: parseInt(liabilityForm.capitalPaymentDay) || 0,
        capitalPaid: false,
      } : {})
    };
    
    update(p => ({ emis: [...(p.emis || []), newLiability] }));
    setLiabilityForm({ name: "", type: "Credit Card", amount: "", totalMonths: "", paymentDay: "", accountId: "", startDate: today(), notes: "", interestRate: "", capitalAmount: "", capitalPaymentDay: "" });
    setAddPaymentMode("split");
    setTotalAmountInput("");
    setAmountMode("monthly");
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
    const txId = Date.now();
    const newTransaction = {
      id: txId,
      type: "expense",
      amount: liability.amount,
      category: "EMI",
      note: `${liability.name} - Manual payment (Month ${liability.paidMonths + 1}/${liability.totalMonths})`,
      date: today(),
      bankId: liability.accountId,
      emiId: liability.id,
      _emiPayment: true,
    };
    update(p => ({
      emis: p.emis.map(e => e.id === liability.id
        ? { ...e, paidMonths: e.paidMonths + 1, paidTxIds: [...(e.paidTxIds || []), txId] }
        : e),
      transactions: [...p.transactions, newTransaction]
    }));
  }

  function markCapitalPaid(liability) {
    if (liability.capitalPaid) return;
    const capitalAmt = parseFloat(liability.capitalAmount) || 0;
    if (!capitalAmt) return;
    const txId = Date.now();
    const newTransaction = {
      id: txId,
      type: "expense",
      amount: capitalAmt,
      category: "EMI",
      note: `${liability.name} - Capital payment`,
      date: today(),
      bankId: liability.accountId,
      emiId: liability.id,
      _capitalPayment: true
    };
    update(p => ({
      emis: p.emis.map(e => e.id === liability.id
        ? { ...e, capitalPaid: true, capitalPaidTxId: txId }
        : e),
      transactions: [...p.transactions, newTransaction]
    }));
  }

  function unmarkCapitalPaid(liability) {
    if (!window.confirm("Undo capital paid? This will remove the capital payment transaction.")) return;
    update(p => ({
      emis: p.emis.map(e => e.id === liability.id
        ? { ...e, capitalPaid: false, capitalPaidTxId: null }
        : e),
      transactions: p.transactions.filter(t => t.id !== liability.capitalPaidTxId)
    }));
  }


  const activeLiabilities = liabilities.filter(e => e.active && e.paidMonths < e.totalMonths);
  const completedLiabilities = liabilities.filter(e => !e.active || e.paidMonths >= e.totalMonths);

  // ── Auto-mark Capital Paid when all interest months are completed ──────────
  useEffect(() => {
    const emis = data.emis || [];
    const existingTxIds = new Set((data.transactions || []).map(t => t.id));

    // Find interestOnly liabilities where all months paid but capital not yet done
    const ready = emis.filter(l =>
      l._paymentMode === "interestOnly" &&
      parseFloat(l.capitalAmount) > 0 &&
      !l.capitalPaid &&
      l.paidMonths >= l.totalMonths
    );
    if (ready.length === 0) return;

    const newTxs      = [];
    const emiUpdates  = {};

    ready.forEach(l => {
      // Deterministic txId — same value every render, never duplicates
      const txId = Number(String(l.id).slice(-9)) * 10 + 7;
      if (!existingTxIds.has(txId)) {
        newTxs.push({
          id: txId,
          type: "expense",
          amount: parseFloat(l.capitalAmount),
          category: "EMI",
          note: `${l.name} - Capital payment (auto)`,
          date: today(),
          bankId: l.accountId,
          emiId: l.id,
          _capitalPayment: true,
        });
      }
      emiUpdates[l.id] = { ...l, capitalPaid: true, capitalPaidTxId: txId };
    });

    update(p => ({
      ...p,
      emis: p.emis.map(e => emiUpdates[e.id] || e),
      transactions: newTxs.length > 0 ? [...p.transactions, ...newTxs] : p.transactions,
    }));
  }, [(data.emis || []).map(e => `${e.id}:${e.paidMonths}:${e.capitalPaid}`).join("|")]); // eslint-disable-line
  useEffect(() => {
    const txIdSet = new Set((data.transactions || []).map(t => String(t.id)));
    let changed = false;

    const updatedEmis = (data.emis || []).map(l => {
      let updated = { ...l };

      // Capital paid: reset if the capital payment transaction no longer exists
      if (l.capitalPaid && l.capitalPaidTxId && !txIdSet.has(String(l.capitalPaidTxId))) {
        updated = { ...updated, capitalPaid: false, capitalPaidTxId: null };
        changed = true;
      }

      // Interest/EMI months: count only paidTxIds that still exist in transactions
      if (l.paidMonths > 0 && (l.paidTxIds || []).length > 0) {
        const survivingIds = (l.paidTxIds || []).filter(id => txIdSet.has(String(id)));
        if (survivingIds.length !== l.paidMonths) {
          updated = { ...updated, paidMonths: survivingIds.length, paidTxIds: survivingIds };
          changed = true;
        }
      }

      return updated;
    });

    if (changed) update(p => ({ ...p, emis: updatedEmis }));
  }, [(data.transactions || []).length]); // re-run whenever a transaction is added or deleted

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
    const monthsInYear = Math.min(remaining, 12);
    let total = l.amount * monthsInYear;
    // For interest-only loans, also add capital if it falls due within next 12 months and not yet paid
    if (l._paymentMode === "interestOnly" && !l.capitalPaid) {
      const capitalAmt = parseFloat(l.capitalAmount) || 0;
      if (capitalAmt > 0 && remaining <= 12) {
        total += capitalAmt;
      }
    }
    return s + total;
  }, 0);

  return (
    <div style={{ marginTop: 16 }}>
      {/* Summary Strip — matching Scheduled Payments look */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(140px, 100%), 1fr))", gap: 10, marginBottom: 16 }}>
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
                  {(data.liabilityTypes && data.liabilityTypes.length > 0 ? data.liabilityTypes : ["Credit Card", "Personal Loan", "Car Loan", "Home Loan", "Other"]).map(t => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                    {editLiability._amountMode === "total" ? "Total/Principal Amount (₹)" : "Monthly Amount (₹)"}
                  </label>
                  <div style={{ display: "flex", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: 2, gap: 1 }}>
                    <button onClick={() => setEditLiability(p => ({ ...p, _amountMode: "monthly", _totalInput: "" }))}
                      style={{ padding: "2px 8px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 10, fontWeight: 600,
                        background: editLiability._amountMode !== "total" ? "#1a6b3c" : "transparent",
                        color: editLiability._amountMode !== "total" ? "#fff" : "var(--color-text-secondary)" }}>Monthly</button>
                    <button onClick={() => setEditLiability(p => ({ ...p, _amountMode: "total", _totalInput: String((parseFloat(p.amount)||0) * (parseFloat(p.totalMonths)||0) || "") }))}
                      style={{ padding: "2px 8px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 10, fontWeight: 600,
                        background: editLiability._amountMode === "total" ? "#1a6b3c" : "transparent",
                        color: editLiability._amountMode === "total" ? "#fff" : "var(--color-text-secondary)" }}>Total</button>
                  </div>
                </div>
                {editLiability._amountMode === "total" ? (
                  <div>
                    <input type="number" placeholder="e.g. 60000" value={editLiability._totalInput || ""}
                      onChange={e => {
                        const principal = parseFloat(e.target.value) || 0;
                        const months = parseFloat(editLiability.totalMonths) || 0;
                        const rate = parseFloat(editLiability.interestRate) || 0;
                        setEditLiability(p => ({
                          ...p, _totalInput: e.target.value,
                          amount: principal > 0
                            ? p._paymentMode === "interestOnly" && rate > 0
                              ? (principal * rate / 12 / 100).toFixed(2)
                              : months > 0 ? calcEMI(principal, rate, months).toFixed(2) : p.amount
                            : p.amount
                        }));
                      }}
                      style={{ width: "100%", boxSizing: "border-box" }} />
                    {editLiability._totalInput && editLiability.totalMonths && (
                      <div style={{ fontSize: 11, color: editLiability._paymentMode === "interestOnly" ? "#f59e0b" : "#1a6b3c", fontWeight: 600, marginTop: 3 }}>
                        = ₹{editLiability.amount ? Number(editLiability.amount).toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—"} / month
                        {editLiability._paymentMode === "interestOnly"
                          ? <span style={{ color: "#f59e0b", marginLeft: 6 }}>(interest only · {editLiability.interestRate}% p.a.)</span>
                          : editLiability.interestRate > 0 && (
                            <span style={{ color: "#f59e0b", marginLeft: 6 }}>
                              (incl. {editLiability.interestRate}% p.a.)
                            </span>
                          )
                        }
                      </div>
                    )}
                  </div>
                ) : (
                  <input type="number" value={editLiability.amount} onChange={e => setEditLiability(p => ({ ...p, amount: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
                )}
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Interest Rate (% p.a.)</label>
                <input type="number" placeholder="e.g. 12" value={editLiability.interestRate || ""}
                  onChange={e => {
                    const rate = parseFloat(e.target.value) || 0;
                    const principal = parseFloat(editLiability._totalInput) || 0;
                    const months = parseFloat(editLiability.totalMonths) || 0;
                    setEditLiability(p => ({
                      ...p, interestRate: e.target.value,
                      ...(p._amountMode === "total" && principal > 0
                        ? p._paymentMode === "interestOnly" && rate > 0
                          ? { amount: (principal * rate / 12 / 100).toFixed(2) }
                          : months > 0 ? { amount: calcEMI(principal, rate, months).toFixed(2) } : {}
                        : {})
                    }));
                  }}
                  style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Total Months</label>
                  <div style={{ display: "flex", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: 2, gap: 1 }}>
                    <button onClick={() => {
                      const principal = parseFloat(editLiability._totalInput) || 0;
                      const rate = parseFloat(editLiability.interestRate) || 0;
                      const months = parseFloat(editLiability.totalMonths) || 0;
                      setEditLiability(p => ({
                        ...p, _paymentMode: "split",
                        amount: p._amountMode === "total" && principal > 0 && months > 0
                          ? calcEMI(principal, rate, months).toFixed(2)
                          : p.amount
                      }));
                    }}
                      style={{ padding: "2px 8px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 10, fontWeight: 600,
                        background: (editLiability._paymentMode || "split") === "split" ? "#1a6b3c" : "transparent",
                        color: (editLiability._paymentMode || "split") === "split" ? "#fff" : "var(--color-text-secondary)" }}>Split</button>
                    <button onClick={() => {
                      const principal = parseFloat(editLiability._totalInput) || 0;
                      const rate = parseFloat(editLiability.interestRate) || 0;
                      setEditLiability(p => ({
                        ...p, _paymentMode: "interestOnly",
                        amount: principal > 0 && rate > 0
                          ? (principal * rate / 12 / 100).toFixed(2)
                          : p.amount
                      }));
                    }}
                      style={{ padding: "2px 8px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 10, fontWeight: 600,
                        background: editLiability._paymentMode === "interestOnly" ? "#f59e0b" : "transparent",
                        color: editLiability._paymentMode === "interestOnly" ? "#fff" : "var(--color-text-secondary)" }}>Interest Only</button>
                  </div>
                </div>
                <input type="number" value={editLiability.totalMonths}
                  onChange={e => {
                    const months = parseFloat(e.target.value) || 0;
                    const principal = parseFloat(editLiability._totalInput) || 0;
                    const rate = parseFloat(editLiability.interestRate) || 0;
                    setEditLiability(p => ({
                      ...p, totalMonths: e.target.value,
                      amount: p._amountMode === "total" && principal > 0 && months > 0 && (p._paymentMode || "split") === "split"
                        ? calcEMI(principal, rate, months).toFixed(2)
                        : p.amount
                    }));
                  }}
                  style={{ width: "100%", boxSizing: "border-box" }} />
                {editLiability._paymentMode === "interestOnly" && editLiability._totalInput && editLiability.interestRate > 0 && (
                  <div style={{ fontSize: 11, color: "#f59e0b", fontWeight: 600, marginTop: 3 }}>
                    ⓘ Monthly = interest only · capital (₹{Number(editLiability._totalInput).toLocaleString("en-IN")}) due at end
                  </div>
                )}
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
                  {editLiability._paymentMode === "interestOnly" ? "🗓 Interest Due Day" : "Payment Day"}
                </label>
                <input type="number" min="1" max="31" value={editLiability.paymentDay} onChange={e => setEditLiability(p => ({ ...p, paymentDay: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Start Date</label>
                <input type="date" value={editLiability.startDate || ""} onChange={e => setEditLiability(p => ({ ...p, startDate: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </div>
              {editLiability._paymentMode === "interestOnly" && (
                <div style={{ gridColumn: "span 2", background: "#fffbeb", border: "0.5px solid #f59e0b", borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#92400e", marginBottom: 8 }}>💰 Capital Payment Settings</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div>
                      <label style={{ fontSize: 12, color: "#92400e", display: "block", marginBottom: 4 }}>Capital Due Day</label>
                      <input type="number" min="1" max="31" placeholder="e.g. 10"
                        value={editLiability.capitalPaymentDay || ""}
                        onChange={e => setEditLiability(p => ({ ...p, capitalPaymentDay: e.target.value }))}
                        style={{ width: "100%", boxSizing: "border-box", borderColor: "#f59e0b" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#92400e", display: "block", marginBottom: 4 }}>Capital Amount (₹)</label>
                      <input type="number" placeholder="e.g. 30000"
                        value={editLiability.capitalAmount || editLiability._totalInput || ""}
                        onChange={e => setEditLiability(p => ({ ...p, capitalAmount: e.target.value }))}
                        style={{ width: "100%", boxSizing: "border-box", borderColor: "#f59e0b" }} />
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "#92400e", marginTop: 6 }}>
                    ⓘ Interest paid monthly on day {editLiability.paymentDay || "—"} · Capital paid on day {editLiability.capitalPaymentDay || "—"}
                  </div>
                </div>
              )}
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Name</label>
            <input placeholder="e.g. HDFC Credit Card, Personal Loan" value={liabilityForm.name} onChange={e => setLiabilityForm(p => ({ ...p, name: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Type</label>
            <select value={liabilityForm.type} onChange={e => setLiabilityForm(p => ({ ...p, type: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
              {(data.liabilityTypes && data.liabilityTypes.length > 0 ? data.liabilityTypes : ["Credit Card", "Personal Loan", "Car Loan", "Home Loan", "Other"]).map(t => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            {/* Amount mode toggle */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                {amountMode === "monthly" ? "Monthly Amount (₹)" : "Total/Principal Amount (₹)"}
              </label>
              <div style={{ display: "flex", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: 2, gap: 1 }}>
                <button onClick={() => { setAmountMode("monthly"); setTotalAmountInput(""); }}
                  style={{ padding: "2px 8px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 10, fontWeight: 600,
                    background: amountMode === "monthly" ? "#1a6b3c" : "transparent",
                    color: amountMode === "monthly" ? "#fff" : "var(--color-text-secondary)" }}>Monthly</button>
                <button onClick={() => { setAmountMode("total"); setLiabilityForm(p => ({ ...p, amount: "" })); }}
                  style={{ padding: "2px 8px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 10, fontWeight: 600,
                    background: amountMode === "total" ? "#1a6b3c" : "transparent",
                    color: amountMode === "total" ? "#fff" : "var(--color-text-secondary)" }}>Total</button>
              </div>
            </div>
            {amountMode === "monthly" ? (
              <input type="number" placeholder="e.g. 5000" value={liabilityForm.amount}
                onChange={e => setLiabilityForm(p => ({ ...p, amount: e.target.value }))}
                style={{ width: "100%", boxSizing: "border-box" }} />
            ) : (
              <div style={{ position: "relative" }}>
                <input type="number" placeholder="e.g. 60000" value={totalAmountInput}
                  onChange={e => {
                    const principal = parseFloat(e.target.value) || 0;
                    const months = parseFloat(liabilityForm.totalMonths) || 0;
                    const rate = parseFloat(liabilityForm.interestRate) || 0;
                    setTotalAmountInput(e.target.value);
                    if (principal > 0 && months > 0) {
                      setLiabilityForm(p => ({ ...p, amount: calcEMI(principal, rate, months).toFixed(2) }));
                    } else {
                      setLiabilityForm(p => ({ ...p, amount: "" }));
                    }
                  }}
                  style={{ width: "100%", boxSizing: "border-box" }} />
                {totalAmountInput && liabilityForm.totalMonths && (
                  <div style={{ fontSize: 11, color: addPaymentMode === "interestOnly" ? "#f59e0b" : "#1a6b3c", fontWeight: 600, marginTop: 3 }}>
                    = ₹{liabilityForm.amount ? Number(liabilityForm.amount).toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—"} / month
                    {addPaymentMode === "interestOnly"
                      ? <span style={{ color: "#f59e0b", marginLeft: 6 }}>(interest only · {liabilityForm.interestRate}% p.a.)</span>
                      : liabilityForm.interestRate > 0 && (
                        <span style={{ color: "#f59e0b", marginLeft: 6 }}>
                          (incl. {liabilityForm.interestRate}% p.a. interest)
                        </span>
                      )
                    }
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(140px, 100%), 1fr))", gap: 10, marginBottom: 10 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                {addPaymentMode === "interestOnly" ? "🗓 Interest Due Day" : "Total Months"}
              </label>
              <div style={{ display: "flex", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: 2, gap: 1 }}>
                <button onClick={() => {
                  setAddPaymentMode("split");
                  const principal = parseFloat(totalAmountInput) || 0;
                  const rate = parseFloat(liabilityForm.interestRate) || 0;
                  const months = parseFloat(liabilityForm.totalMonths) || 0;
                  if (amountMode === "total" && principal > 0 && months > 0)
                    setLiabilityForm(p => ({ ...p, amount: calcEMI(principal, rate, months).toFixed(2) }));
                }} style={{ padding: "2px 8px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 10, fontWeight: 600,
                  background: addPaymentMode === "split" ? "#1a6b3c" : "transparent",
                  color: addPaymentMode === "split" ? "#fff" : "var(--color-text-secondary)" }}>Split</button>
                <button onClick={() => {
                  setAddPaymentMode("interestOnly");
                  const principal = parseFloat(totalAmountInput) || 0;
                  const rate = parseFloat(liabilityForm.interestRate) || 0;
                  if (amountMode === "total" && principal > 0 && rate > 0)
                    setLiabilityForm(p => ({ ...p, amount: (principal * rate / 12 / 100).toFixed(2) }));
                }} style={{ padding: "2px 8px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 10, fontWeight: 600,
                  background: addPaymentMode === "interestOnly" ? "#f59e0b" : "transparent",
                  color: addPaymentMode === "interestOnly" ? "#fff" : "var(--color-text-secondary)" }}>Interest Only</button>
              </div>
            </div>
            <input type="number" placeholder="e.g. 12" value={liabilityForm.totalMonths}
              onChange={e => {
                const months = parseFloat(e.target.value) || 0;
                const principal = parseFloat(totalAmountInput) || 0;
                const rate = parseFloat(liabilityForm.interestRate) || 0;
                setLiabilityForm(p => ({
                  ...p,
                  totalMonths: e.target.value,
                  ...(amountMode === "total" && principal > 0 && months > 0 && addPaymentMode === "split"
                    ? { amount: calcEMI(principal, rate, months).toFixed(2) }
                    : {})
                }));
              }}
              style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Interest Rate (% p.a.)</label>
            <input type="number" placeholder="e.g. 12" value={liabilityForm.interestRate}
              onChange={e => {
                const rate = parseFloat(e.target.value) || 0;
                const principal = parseFloat(totalAmountInput) || 0;
                const months = parseFloat(liabilityForm.totalMonths) || 0;
                setLiabilityForm(p => ({
                  ...p,
                  interestRate: e.target.value,
                  ...(amountMode === "total" && principal > 0
                    ? addPaymentMode === "interestOnly" && rate > 0
                      ? { amount: (principal * rate / 12 / 100).toFixed(2) }
                      : months > 0 ? { amount: calcEMI(principal, rate, months).toFixed(2) } : {}
                    : {})
                }));
              }}
              style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
              {addPaymentMode === "interestOnly" ? "🗓 Interest Due Day" : "Payment Day"}
            </label>
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
        {addPaymentMode === "interestOnly" && (
          <div style={{ marginBottom: 10, background: "#fffbeb", border: "0.5px solid #f59e0b", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#92400e", marginBottom: 8 }}>💰 Capital Payment Settings</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: "#92400e", display: "block", marginBottom: 4 }}>Capital Due Day</label>
                <input type="number" min="1" max="31" placeholder="e.g. 10"
                  value={liabilityForm.capitalPaymentDay || ""}
                  onChange={e => setLiabilityForm(p => ({ ...p, capitalPaymentDay: e.target.value }))}
                  style={{ width: "100%", boxSizing: "border-box", borderColor: "#f59e0b" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#92400e", display: "block", marginBottom: 4 }}>Capital Amount (₹)</label>
                <input type="number" placeholder="e.g. 30000"
                  value={liabilityForm.capitalAmount || totalAmountInput || ""}
                  onChange={e => setLiabilityForm(p => ({ ...p, capitalAmount: e.target.value }))}
                  style={{ width: "100%", boxSizing: "border-box", borderColor: "#f59e0b" }} />
              </div>
            </div>
            <div style={{ fontSize: 11, color: "#92400e", marginTop: 6 }}>
              ⓘ Interest paid monthly on day {liabilityForm.paymentDay || "—"} · Capital paid on day {liabilityForm.capitalPaymentDay || "—"}
            </div>
          </div>
        )}
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
                        {liability.type} · {liability._paymentMode === "interestOnly"
                          ? <>Interest {fmtCur(liability.amount)}/month (day {liability.paymentDay}{liability.paymentDay==1?'st':liability.paymentDay==2?'nd':liability.paymentDay==3?'rd':'th'}) · Capital {fmtCur(liability.capitalAmount || 0)} (day {liability.capitalPaymentDay || "—"})</>
                          : <>{fmtCur(liability.amount)}/month · Due on {liability.paymentDay}{liability.paymentDay === 1 ? 'st' : liability.paymentDay === 2 ? 'nd' : liability.paymentDay === 3 ? 'rd' : 'th'}</>
                        }
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
                      {liability.paidMonths >= liability.totalMonths ? "✓ Completed" : liability._paymentMode === "interestOnly" ? "💳 Mark Interest Paid" : "💳 Mark Payment Made"}
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
                  {liability._paymentMode === "interestOnly" && liability.capitalAmount && (
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button
                        onClick={() => markCapitalPaid(liability)}
                        disabled={!!liability.capitalPaid}
                        style={{
                          flex: 1,
                          background: liability.capitalPaid ? "var(--color-background-secondary)" : "#fffbeb",
                          color: liability.capitalPaid ? "var(--color-text-secondary)" : "#92400e",
                          border: `0.5px solid ${liability.capitalPaid ? "var(--color-border-secondary)" : "#f59e0b"}`,
                          borderRadius: 8, padding: "7px", cursor: liability.capitalPaid ? "not-allowed" : "pointer",
                          fontSize: 13, fontWeight: 500
                        }}
                      >
                        {liability.capitalPaid ? "✓ Capital Paid" : `💰 Mark Capital Paid (${fmtCur(liability.capitalAmount)})`}
                      </button>
                      {liability.capitalPaid && (
                        <button
                          onClick={() => unmarkCapitalPaid(liability)}
                          title="Undo capital paid"
                          style={{
                            background: "none",
                            border: "0.5px solid #d44",
                            borderRadius: 8, padding: "7px 12px",
                            cursor: "pointer", fontSize: 12,
                            color: "#d44", whiteSpace: "nowrap",
                          }}
                        >
                          ↩ Undo
                        </button>
                      )}
                    </div>
                  )}
                  
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
              const isEditing = editLiability?.id === liability.id;

              return (
                <div key={liability.id} style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "0.8rem", opacity: isEditing ? 1 : 0.8 }}>
                  {/* ── Inline Edit Form ── */}
                  {isEditing ? (
                    <div>
                      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 10, color: "#1a6b3c" }}>✏️ Edit Liability</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 8 }}>
                        <div>
                          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Name</label>
                          <input value={editLiability.name} onChange={e => setEditLiability(p => ({ ...p, name: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontSize: 12 }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Monthly Amount (₹)</label>
                          <input type="number" value={editLiability.amount} onChange={e => setEditLiability(p => ({ ...p, amount: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontSize: 12 }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Total Months</label>
                          <input type="number" value={editLiability.totalMonths} onChange={e => setEditLiability(p => ({ ...p, totalMonths: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontSize: 12 }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Paid Months</label>
                          <input type="number" value={editLiability.paidMonths} onChange={e => setEditLiability(p => ({ ...p, paidMonths: parseInt(e.target.value) || 0 }))} style={{ width: "100%", boxSizing: "border-box", fontSize: 12 }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Payment Day</label>
                          <input type="number" min="1" max="31" value={editLiability.paymentDay} onChange={e => setEditLiability(p => ({ ...p, paymentDay: e.target.value }))} style={{ width: "100%", boxSizing: "border-box", fontSize: 12 }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 3 }}>Notes</label>
                          <input value={editLiability.notes || ""} onChange={e => setEditLiability(p => ({ ...p, notes: e.target.value }))} placeholder="Optional" style={{ width: "100%", boxSizing: "border-box", fontSize: 12 }} />
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button onClick={() => setEditLiability(null)} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}>Cancel</button>
                        <button onClick={saveEditLiability} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 7, padding: "5px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Save Changes</button>
                      </div>
                    </div>
                  ) : (
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
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        {/* Edit */}
                        <button
                          onClick={() => setEditLiability({ ...liability })}
                          style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: 4 }}
                          title="Edit liability"
                        >
                          ✏️ Edit
                        </button>
                        {/* Undo last payment */}
                        {liability.paidMonths > 0 && (
                          <button
                            onClick={() => {
                              if (!confirm(`Undo last payment for "${liability.name}"?\n\nThis will reduce paid months from ${liability.paidMonths} to ${liability.paidMonths - 1} and remove the most recent logged payment.`)) return;
                              // Remove most recent related expense
                              const sorted = [...relatedExpenses].sort((a, b) => b.date?.localeCompare(a.date) || b.id - a.id);
                              const toRemove = sorted[0];
                              update(p => ({
                                emis: p.emis.map(e => e.id === liability.id ? { ...e, paidMonths: Math.max(0, e.paidMonths - 1), active: true } : e),
                                transactions: toRemove ? p.transactions.filter(t => t.id !== toRemove.id) : p.transactions
                              }));
                            }}
                            style={{ background: "none", border: "0.5px solid #f0a020", borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 12, color: "#f0a020", display: "flex", alignItems: "center", gap: 4 }}
                            title="Undo last payment"
                          >
                            ↩ Undo
                          </button>
                        )}
                        {/* Resume (paused only) */}
                        {!isCompleted && (
                          <button
                            onClick={() => toggleLiabilityActive(liability.id)}
                            style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 500 }}
                          >
                            Resume
                          </button>
                        )}
                        {/* Delete */}
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
                  )}
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

function DraggableList({ items, keyFn, onReorder, renderItem }) {
  const [draggingIdx, setDraggingIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);

  function handleDragStart(i) { setDraggingIdx(i); }
  function handleDragOver(e, i) { e.preventDefault(); setOverIdx(i); }
  function handleDrop(i) {
    if (draggingIdx === null || draggingIdx === i) return;
    const reordered = [...items];
    const [moved] = reordered.splice(draggingIdx, 1);
    reordered.splice(i, 0, moved);
    onReorder(reordered);
    setDraggingIdx(null);
    setOverIdx(null);
  }
  function handleDragEnd() { setDraggingIdx(null); setOverIdx(null); }

  return (
    <div>
      {items.map((item, i) => (
        <div
          key={keyFn(item)}
          draggable
          onDragStart={() => handleDragStart(i)}
          onDragOver={e => handleDragOver(e, i)}
          onDrop={() => handleDrop(i)}
          onDragEnd={handleDragEnd}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderRadius: 8,
            borderBottom: "0.5px solid var(--color-border-tertiary)",
            background: overIdx === i ? "var(--color-background-secondary)" : "transparent",
            opacity: draggingIdx === i ? 0.4 : 1,
            transition: "background 0.15s, opacity 0.15s",
          }}
        >
          <span style={{
            fontSize: 16,
            color: "var(--color-border-primary)",
            cursor: "grab",
            padding: "8px 4px",
            flexShrink: 0,
            userSelect: "none",
          }}>⠿</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {renderItem(item)}
          </div>
        </div>
      ))}
    </div>
  );
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
