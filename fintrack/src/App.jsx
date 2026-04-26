import { useState, useEffect, useCallback, useRef } from "react";
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
  goals: [],
  snapshots: [],
};



const ASSET_TYPES = ["Stocks & Equity", "Equity Funds", "Gold & Silver", "FD & RD", "EPF / PPF / NPS", "Real Estate", "Crypto", "Cash", "Other"];
const STRATEGIES = ["Call", "Put"];
const INSTRUMENTS = ["Index Options", "Stock Options", "Commodities"];

const fmt = (n) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n || 0);
const fmtCur = (n) => "₹" + fmt(n);
const fmtPct = (n) => (n >= 0 ? "+" : "") + (n || 0).toFixed(2) + "%";

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
  const netWorth = (data.banks || []).reduce((s, b) => {
    const inc = data.transactions.filter(t => t.type === "income" && t.bankId === b.id).reduce((a, t) => a + Number(t.amount || 0), 0);
    const exp = data.transactions.filter(t => t.type === "expense" && t.bankId === b.id).reduce((a, t) => a + Number(t.amount || 0), 0);
    
    // For credit cards, outstanding is a liability (subtract from net worth)
    // Credit card balance = opening + expenses - income (payments)
    if (b.type === "Credit Card") {
      const outstanding = (b.openingBalance || 0) + exp - inc;
      return s - outstanding; // Credit card debt reduces net worth
    }
    // For bank accounts and cash: add to net worth
    return s + (b.openingBalance || 0) + inc - exp;
  }, 0);

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

  const navItems = [
    { id: "overview", label: "Overview", icon: "⊞" },
    { id: "money", label: "Money", icon: "⊕" },
    { id: "fo", label: "F&O", icon: "◉" },

  ];

  return (
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
        {page === "overview" && <Overview data={data} netWorth={netWorth} foNetPnl={foNetPnl} setPage={setPage} />}
        {page === "money" && <MoneyPage data={data} update={update} tab={moneyTab} setTab={setMoneyTab} />}
        {page === "fo" && <FOPage data={data} update={update} tab={foTab} setTab={setFoTab} calcCharges={calcCharges} foNetPnl={foNetPnl} />}

        {page === "settings" && <SettingsPage data={data} update={update} />}
      </main>
    </div>
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
function Overview({ data, netWorth, foNetPnl, setPage }) {
  const todayStr = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const monthIncome = data.transactions.filter(t => t.type === "income" && isThisMonth(t.date)).reduce((s, t) => s + Number(t.amount), 0);
  const monthExpense = data.transactions.filter(t => t.type === "expense" && isThisMonth(t.date)).reduce((s, t) => s + Number(t.amount), 0);
  const totalIncome = data.transactions.filter(t => t.type === "income").reduce((s, t) => s + Number(t.amount), 0);
  const totalExpense = data.transactions.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);

  // Bank balances: sum income - expense per bank (exclude credit cards)
  const banks = data.banks || [];
  const bankBalances = banks.filter(bank => bank.type !== "Credit Card").map(bank => {
    const inc = data.transactions.filter(t => t.type === "income" && t.bankId === bank.id).reduce((s, t) => s + Number(t.amount || 0), 0);
    const exp = data.transactions.filter(t => t.type === "expense" && t.bankId === bank.id).reduce((s, t) => s + Number(t.amount || 0), 0);
    // For bank accounts and cash: normal calculation
    return { ...bank, balance: (bank.openingBalance || 0) + inc - exp };
  });

  return (
    <div>
      <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26, marginBottom: 20 }}>Overview</h1>

      {/* Top stat row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
        <StatCard label="Net Worth · ₹ INR" value={fmtCur(netWorth)} sub={todayStr} accent big />
        <StatCard label="Total Income" value={fmtCur(totalIncome)} sub="all time" icon="⊕" />
        <StatCard label="Total Expenses" value={fmtCur(totalExpense)} sub="all time" icon="⊟" danger />
        <StatCard label="F&O Net P&L" value={fmtCur(foNetPnl)} sub={`${data.foTrades.length} trades`} icon="◉" pnl={foNetPnl} />
      </div>

      {/* This month cashflow + F&O summary */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <Card title="This Month" action={<button onClick={() => setPage("money")} style={{ fontSize: 12, color: "#1a6b3c", background: "none", border: "none", cursor: "pointer" }}>View all →</button>}>
          <div style={{ padding: "0.5rem 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, fontSize: 13 }}>
              <span style={{ color: "var(--color-text-secondary)" }}>Income</span>
              <span style={{ color: "#1a6b3c", fontWeight: 500 }}>{fmtCur(monthIncome)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, fontSize: 13 }}>
              <span style={{ color: "var(--color-text-secondary)" }}>Expenses</span>
              <span style={{ color: "#d44", fontWeight: 500 }}>{fmtCur(monthExpense)}</span>
            </div>
            <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 10, display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ fontWeight: 500 }}>Net</span>
              <span style={{ fontWeight: 600, color: (monthIncome - monthExpense) >= 0 ? "#1a6b3c" : "#d44" }}>{fmtCur(monthIncome - monthExpense)}</span>
            </div>
          </div>
        </Card>
        <Card title="F&O Summary" action={<button onClick={() => setPage("fo")} style={{ fontSize: 12, color: "#1a6b3c", background: "none", border: "none", cursor: "pointer" }}>View all →</button>}>
          <FOSummaryMini trades={data.foTrades} netPnl={foNetPnl} />
        </Card>
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
    filterPeriod(t) && (tab === "insights" || tab === "accounts" || t.type === (tab === "expenses" ? "expense" : "income"))
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

  const pageTitle = { expenses: "Expenses", income: "Income", accounts: "Accounts", insights: "Money Insights", categories: "Categories", liabilities: "Liabilities" }[tab];

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
      <TabBar tabs={["expenses", "income", "accounts", "categories", "liabilities"]} active={tab} setActive={setTab} labels={["Expenses", "Income", "Accounts", "Categories", "Liabilities"]} />

      {/* ── Accounts Tab ── */}
      {tab === "accounts" && (
        <div style={{ marginTop: 16 }}>

          {/* Adjust balance modal */}
          {adjusting && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ background: "var(--color-background-primary)", borderRadius: 16, padding: "1.5rem", width: "min(380px, 90vw)", border: "0.5px solid var(--color-border-tertiary)" }}>
                <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>Adjust Balance</div>
                <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 16 }}>{adjusting.name} · Current: {fmtCur(adjusting.balance || 0)}</div>
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Amount (₹)</label>
                  <input type="number" placeholder="e.g. 5000" value={adjustAmt} onChange={e => setAdjustAmt(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 16, fontWeight: 600 }} autoFocus />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Note (optional)</label>
                  <input placeholder="e.g. Salary credit, Bill payment" value={adjustNote} onChange={e => setAdjustNote(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => applyAdjustment("add")} style={{ flex: 1, background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "10px", cursor: "pointer", fontWeight: 600, fontSize: 14 }}>+ Add Money</button>
                  <button onClick={() => applyAdjustment("subtract")} style={{ flex: 1, background: "#d44", color: "#fff", border: "none", borderRadius: 8, padding: "10px", cursor: "pointer", fontWeight: 600, fontSize: 14 }}>− Deduct</button>
                  <button onClick={() => { setAdjusting(null); setAdjustAmt(""); setAdjustNote(""); }} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "10px 14px", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)" }}>Cancel</button>
                </div>
              </div>
            </div>
          )}

          {/* Add account form */}
          <Card title="Add Account">
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr auto", gap: 10, alignItems: "flex-end" }}>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Account Name</label>
                <input placeholder="e.g. HDFC Savings, SBI, Axis CC" value={acctForm.name} onChange={e => setAcctForm(p => ({ ...p, name: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} onKeyDown={e => e.key === "Enter" && addAccount()} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Type</label>
                <select value={acctForm.type} onChange={e => setAcctForm(p => ({ ...p, type: e.target.value }))} style={{ boxSizing: "border-box" }}>
                  <option>Bank</option>
                  <option>Credit Card</option>
                  <option>Cash</option>
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
          </Card>

          {/* Bank Accounts */}
          {banks.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>🏦 Bank Accounts</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
                {banks.map(acct => {
                  const txInc = data.transactions.filter(t => t.type === "income" && t.bankId === acct.id).reduce((s, t) => s + Number(t.amount), 0);
                  const txExp = data.transactions.filter(t => t.type === "expense" && t.bankId === acct.id).reduce((s, t) => s + Number(t.amount), 0);
                  const bal = (acct.openingBalance || 0) + txInc - txExp;
                  return (
                    <div key={acct.id} style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.2rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{acct.name}</span>
                        <ThreeDotMenu onEdit={() => setEditAcct({ ...acct })} onDelete={() => deleteAccount(acct.id)} />
                      </div>
                      <div style={{ fontSize: 24, fontWeight: 700, color: bal >= 0 ? "var(--color-text-primary)" : "#d44", marginBottom: 8 }}>{fmtCur(bal)}</div>
                      <div style={{ display: "flex", gap: 10, fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 10 }}>
                        <span style={{ color: "#1a6b3c" }}>↑ {fmtCur(txInc)}</span>
                        <span style={{ color: "#d44" }}>↓ {fmtCur(txExp)}</span>
                      </div>
                      <button onClick={() => { setAdjusting(acct); setAdjustAmt(""); setAdjustNote(""); }} style={{ width: "100%", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "6px", cursor: "pointer", fontSize: 12, fontWeight: 500, color: "var(--color-text-primary)" }}>
                        ± Adjust Balance
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Credit Cards */}
          {cards.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>💳 Credit Cards</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
                {cards.map(acct => {
                  const txInc = data.transactions.filter(t => t.type === "income" && t.bankId === acct.id).reduce((s, t) => s + Number(t.amount), 0);
                  const txExp = data.transactions.filter(t => t.type === "expense" && t.bankId === acct.id).reduce((s, t) => s + Number(t.amount), 0);
                  // Credit card balance = opening + expenses - payments
                  const bal = (acct.openingBalance || 0) + txExp - txInc;
                  const limit = acct.creditLimit || 0;
                  const usedPct = limit > 0 ? Math.min((bal / limit) * 100, 100) : 0;
                  const available = limit > 0 ? limit - bal : null;
                  const dueDay = acct.dueDate ? parseInt(acct.dueDate) : null;
                  let dueLabel = null;
                  if (dueDay) {
                    const now = new Date();
                    let dueDate = new Date(now.getFullYear(), now.getMonth(), dueDay);
                    if (dueDate <= now) dueDate = new Date(now.getFullYear(), now.getMonth() + 1, dueDay);
                    const daysLeft = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
                    dueLabel = { date: dueDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }), days: daysLeft };
                  }
                  return (
                    <div key={acct.id} style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.2rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <div>
                          <span style={{ fontWeight: 600, fontSize: 14 }}>{acct.name}</span>
                          <span style={{ marginLeft: 6, fontSize: 10, background: "#fff3e0", color: "#e65100", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>CC</span>
                        </div>
                        <ThreeDotMenu onEdit={() => setEditAcct({ ...acct })} onDelete={() => deleteAccount(acct.id)} />
                      </div>
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 2 }}>Outstanding</div>
                      <div style={{ fontSize: 24, fontWeight: 700, color: bal > 0 ? "#d44" : "var(--color-text-primary)", marginBottom: 6 }}>{fmtCur(bal)}</div>
                      {limit > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>
                            <span>Used {usedPct.toFixed(0)}%</span>
                            <span style={{ color: "#1a6b3c" }}>Avail: {fmtCur(available)}</span>
                          </div>
                          <div style={{ background: "#f0f0f0", borderRadius: 4, height: 5, overflow: "hidden" }}>
                            <div style={{ width: usedPct + "%", height: "100%", background: usedPct > 80 ? "#d44" : usedPct > 50 ? "#f0a020" : "#1a6b3c", borderRadius: 4, transition: "width 0.4s" }} />
                          </div>
                          <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 2 }}>Limit: {fmtCur(limit)}</div>
                        </div>
                      )}
                      {dueLabel && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, background: dueLabel.days <= 5 ? "#fff3e0" : "#f0fdf4", borderRadius: 8, padding: "5px 8px", marginBottom: 8, fontSize: 11 }}>
                          <span>📅</span>
                          <span style={{ color: dueLabel.days <= 5 ? "#e65100" : "#1a6b3c", fontWeight: 500 }}>
                            Due {dueLabel.date} · {dueLabel.days === 0 ? "Today!" : `${dueLabel.days}d left`}
                          </span>
                        </div>
                      )}
                      <button onClick={() => { setAdjusting(acct); setAdjustAmt(""); setAdjustNote(""); }} style={{ width: "100%", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "6px", cursor: "pointer", fontSize: 12, fontWeight: 500, color: "var(--color-text-primary)" }}>
                        ± Adjust Balance
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Cash */}
          {cashAccounts.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>💵 Cash</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
                {cashAccounts.map(acct => {
                  const txInc = data.transactions.filter(t => t.type === "income" && t.bankId === acct.id).reduce((s, t) => s + Number(t.amount), 0);
                  const txExp = data.transactions.filter(t => t.type === "expense" && t.bankId === acct.id).reduce((s, t) => s + Number(t.amount), 0);
                  const bal = (acct.openingBalance || 0) + txInc - txExp;
                  return (
                    <div key={acct.id} style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-tertiary)", padding: "1rem 1.2rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontWeight: 600, fontSize: 14 }}>{acct.name}</span>
                          <span style={{ fontSize: 10, background: "#f0fdf4", color: "#1a6b3c", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>CASH</span>
                        </div>
                        <ThreeDotMenu onEdit={() => setEditAcct({ ...acct })} onDelete={() => deleteAccount(acct.id)} />
                      </div>
                      <div style={{ fontSize: 24, fontWeight: 700, color: bal >= 0 ? "var(--color-text-primary)" : "#d44", marginBottom: 12 }}>{fmtCur(bal)}</div>
                      <button onClick={() => { setAdjusting(acct); setAdjustAmt(""); setAdjustNote(""); }} style={{ width: "100%", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "6px", cursor: "pointer", fontSize: 12, fontWeight: 500, color: "var(--color-text-primary)" }}>
                        ± Adjust Balance
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {accounts.length === 0 && (
            <div style={{ marginTop: 16 }}><EmptyState msg="No accounts yet. Add a bank account, credit card or cash above." /></div>
          )}
        </div>
      )}

      {/* ── Categories Tab ── */}
      {tab === "categories" && (
        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {/* Edit category modal */}
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
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                {(categories[type] || []).map(cat => (
                  <div key={cat} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--color-background-secondary)", borderRadius: 8, padding: "7px 12px" }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{cat}</span>
                    <ThreeDotMenu
                      onEdit={() => { setEditCat({ type, oldName: cat }); setEditCatName(cat); }}
                      onDelete={() => deleteCategory(type, cat)}
                    />
                  </div>
                ))}
                {(categories[type] || []).length === 0 && <EmptyState msg="No categories yet." />}
              </div>
              {/* Add new category */}
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  placeholder={`New ${type} category`}
                  value={newCat.type === type ? newCat.name : ""}
                  onFocus={() => setNewCat(p => ({ ...p, type }))}
                  onChange={e => setNewCat({ type, name: e.target.value })}
                  onKeyDown={e => e.key === "Enter" && addCategory()}
                  style={{ flex: 1, boxSizing: "border-box" }}
                />
                <button onClick={addCategory} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 500, whiteSpace: "nowrap" }}>+ Add</button>
              </div>
            </Card>
          ))}
        </div>
      )}

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
                      const acct = accounts.find(b => b.id === t.bankId);
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
function SettingsPage({ data, update }) {
  const lotSizes = { ...DEFAULT_LOT_SIZES, ...(data.lotSizes || {}) };
  const [form, setForm] = useState({ ...lotSizes });
  const [saved, setSaved] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const custom = data.customInstruments || { "Index Options": [], "Stock Options": [], "Commodities": [] };
  const [newInstrument, setNewInstrument] = useState({ category: "Index Options", name: "", lotSize: "" });

  const indexItems = ["Nifty 50", "Bank Nifty", "Sensex"];
  const commodityItems = ["Crude Oil", "Crude Oil M", "Natural Gas", "Natural Gas M", "Gold", "Gold M"];

  function showSaved(msg) {
    setSavedMsg(msg);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleSaveLotSizes() {
    const parsed = {};
    Object.entries(form).forEach(([k, v]) => { parsed[k] = Number(v) || 0; });
    update(() => ({ lotSizes: parsed }));
    showSaved("Lot sizes saved!");
  }

  function handleReset() {
    setForm({ ...DEFAULT_LOT_SIZES });
    update(() => ({ lotSizes: { ...DEFAULT_LOT_SIZES } }));
    showSaved("Reset to defaults!");
  }

  function handleAddInstrument() {
    const name = newInstrument.name.trim();
    if (!name) return;
    const cat = newInstrument.category;
    const already = [
      ...(cat === "Index Options" ? indexItems : []),
      ...(cat === "Commodities" ? commodityItems : []),
      ...(custom[cat] || []),
    ];
    if (already.includes(name)) return;
    const updatedCustom = { ...custom, [cat]: [...(custom[cat] || []), name] };
    const updatedLotSizes = { ...lotSizes };
    if (newInstrument.lotSize) updatedLotSizes[name] = Number(newInstrument.lotSize);
    setForm(p => ({ ...p, [name]: newInstrument.lotSize || "" }));
    update(() => ({ customInstruments: updatedCustom, lotSizes: updatedLotSizes }));
    setNewInstrument({ category: cat, name: "", lotSize: "" });
    showSaved(`"${name}" added to ${cat}!`);
  }

  function handleRemoveInstrument(cat, name) {
    const updatedCustom = { ...custom, [cat]: (custom[cat] || []).filter(x => x !== name) };
    const updatedLotSizes = { ...lotSizes };
    delete updatedLotSizes[name];
    setForm(p => { const next = { ...p }; delete next[name]; return next; });
    update(() => ({ customInstruments: updatedCustom, lotSizes: updatedLotSizes }));
    showSaved(`"${name}" removed!`);
  }

  const cardStyle = { background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "1.2rem 1.4rem", marginBottom: 16 };
  const sectionTitle = (icon, label) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
      <span style={{ fontSize: 16 }}>{icon}</span>
      <span style={{ fontWeight: 600, fontSize: 15 }}>{label}</span>
    </div>
  );

  return (
    <div>
      <h1 style={{ fontFamily: "'DM Serif Display', serif", fontWeight: 400, fontSize: 26, marginBottom: 4 }}>Settings</h1>
      <p style={{ color: "var(--color-text-secondary)", fontSize: 14, marginBottom: 20 }}>Manage lot sizes and instruments used in F&O trade calculations.</p>

      {/* ── Lot Sizes: Index Options ── */}
      <div style={cardStyle}>
        {sectionTitle("◉", "Index Options — Lot Sizes")}
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>Default lot sizes for index contracts.</p>
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

      {/* ── Lot Sizes: Commodities ── */}
      <div style={cardStyle}>
        {sectionTitle("◈", "Commodities — Lot Sizes")}
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>Default lot sizes for commodity contracts on MCX.</p>
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

      {/* Save lot sizes */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 28 }}>
        <button onClick={handleSaveLotSizes} style={{ background: "#1a6b3c", color: "#fff", border: "none", borderRadius: 8, padding: "9px 24px", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>Save Lot Sizes</button>
        <button onClick={handleReset} style={{ background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "9px 20px", cursor: "pointer", fontSize: 14, color: "var(--color-text-secondary)" }}>Reset to Defaults</button>
        {saved && <span style={{ color: "#1a6b3c", fontSize: 13, fontWeight: 500 }}>✓ {savedMsg}</span>}
      </div>

      {/* ── Manage Instruments ── */}
      <div style={cardStyle}>
        {sectionTitle("⊕", "Manage Instruments")}
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>Add custom instruments to any category. They'll appear as options in the F&O trade form.</p>

        {/* Add new instrument form */}
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.5fr 1fr auto", gap: 10, alignItems: "flex-end", marginBottom: 20 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Category</label>
            <select value={newInstrument.category} onChange={e => setNewInstrument(p => ({ ...p, category: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }}>
              <option>Index Options</option>
              <option>Stock Options</option>
              <option>Commodities</option>
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

        {/* List existing custom instruments */}
        {["Index Options", "Stock Options", "Commodities"].map(cat => {
          const items = custom[cat] || [];
          if (items.length === 0) return null;
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

      {/* Warning */}
      <div style={{ background: "#fef9e7", border: "0.5px solid #f0c040", borderRadius: 10, padding: "0.8rem 1rem", fontSize: 13, color: "#7a5a00" }}>
        ⚠ Lot size changes affect all future P&L calculations. Existing trades will recalculate automatically.
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

  return (
    <div style={{ marginTop: 16 }}>
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
