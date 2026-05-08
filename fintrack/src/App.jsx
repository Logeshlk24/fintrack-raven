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

// ── Enhanced Light Mode with Better Responsive Design ──────────────────────────
const LIGHT_MODE_STYLE = `
  :root, [data-theme], * {
    color-scheme: light !important;
  }
  :root {
    --color-background-primary: #ffffff;
    --color-background-secondary: #f8f9fa;
    --color-background-tertiary: #f0f2f5;
    --color-background-hover: #f5f7fa;
    --color-text-primary: #1a1a1a;
    --color-text-secondary: #6b7280;
    --color-text-tertiary: #9ca3af;
    --color-border-primary: #d1d5db;
    --color-border-secondary: #e5e7eb;
    --color-border-tertiary: #f3f4f6;
    --color-success: #10b981;
    --color-warning: #f59e0b;
    --color-danger: #ef4444;
    --color-info: #3b82f6;
    --color-primary: #6366f1;
    --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
    --radius-sm: 6px;
    --radius-md: 8px;
    --radius-lg: 12px;
    --radius-xl: 16px;
    --spacing-xs: 4px;
    --spacing-sm: 8px;
    --spacing-md: 12px;
    --spacing-lg: 16px;
    --spacing-xl: 24px;
    --spacing-2xl: 32px;
  }
  
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  
  html, body {
    overflow-x: hidden;
    width: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  
  input, select, textarea, button {
    font-family: inherit;
  }
  
  input, select, textarea {
    background: var(--color-background-primary) !important;
    color: var(--color-text-primary) !important;
    border: 1px solid var(--color-border-secondary) !important;
    border-radius: var(--radius-md);
    padding: 8px 12px;
    font-size: 14px;
    transition: all 0.2s ease;
    width: 100%;
  }
  
  input:focus, select:focus, textarea:focus {
    outline: none;
    border-color: var(--color-primary) !important;
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
  }
  
  button {
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 14px;
    font-weight: 500;
    border: none;
    border-radius: var(--radius-md);
  }
  
  button:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: var(--shadow-md);
  }
  
  button:active:not(:disabled) {
    transform: translateY(0);
  }
  
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  /* Scrollbar Styling */
  ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  
  ::-webkit-scrollbar-track {
    background: var(--color-background-tertiary);
  }
  
  ::-webkit-scrollbar-thumb {
    background: var(--color-border-primary);
    border-radius: 4px;
  }
  
  ::-webkit-scrollbar-thumb:hover {
    background: var(--color-text-secondary);
  }
  
  /* Mobile Responsive Design */
  @media (max-width: 767px) {
    :root {
      --spacing-xl: 16px;
      --spacing-2xl: 24px;
    }
    
    main, .main-content {
      max-width: 100vw;
      overflow-x: hidden;
      padding: var(--spacing-md) !important;
    }
    
    table {
      display: block;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      white-space: nowrap;
    }
    
    input[type="time"], input[type="date"], input[type="number"], input[type="text"] {
      min-width: 0;
      width: 100% !important;
      font-size: 16px !important; /* Prevents iOS zoom */
    }
    
    .mobile-stats-2col {
      grid-template-columns: 1fr 1fr !important;
    }
    
    .pie-wrap {
      flex-direction: column !important;
      align-items: center !important;
    }
    
    svg {
      max-width: 100%;
      height: auto;
    }
    
    /* Mobile-specific card adjustments */
    .card {
      border-radius: var(--radius-md) !important;
      padding: var(--spacing-md) !important;
    }
    
    /* Mobile navigation */
    .nav-tabs {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    
    .nav-tabs::-webkit-scrollbar {
      display: none;
    }
    
    /* Mobile buttons */
    button {
      min-height: 44px; /* iOS touch target */
      padding: var(--spacing-sm) var(--spacing-lg);
    }
    
    /* Mobile grid adjustments */
    .responsive-grid {
      grid-template-columns: 1fr !important;
      gap: var(--spacing-md) !important;
    }
    
    /* Mobile stat cards */
    .stat-card {
      min-height: auto !important;
    }
    
    /* Mobile modals */
    .modal-content {
      width: calc(100% - var(--spacing-lg)) !important;
      max-height: 90vh !important;
      overflow-y: auto !important;
    }
  }
  
  /* Tablet Responsive Design */
  @media (min-width: 768px) and (max-width: 1024px) {
    .responsive-grid {
      grid-template-columns: repeat(2, 1fr) !important;
    }
  }
  
  /* Animation utilities */
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  
  @keyframes slideIn {
    from { transform: translateX(-100%); }
    to { transform: translateX(0); }
  }
  
  .fade-in {
    animation: fadeIn 0.3s ease-out;
  }
  
  .slide-in {
    animation: slideIn 0.3s ease-out;
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
// GOOGLE DRIVE CONTEXT
// ═══════════════════════════════════════════════════════════════════════════════
const DriveContext = React.createContext(null);

/*
  Drive is connected for exactly as long as the user's Gmail/Google session
  is valid. We'll obtain a fresh token and keep it in React state.
  If the user logs out from Google in their browser, subsequent calls fail.
*/
function DriveProvider({ user, children }) {
  const [driveToken, setDriveToken] = useState(null);
  const [driveConnected, setDriveConnected] = useState(false);

  // Attempt to get a token as soon as the user appears
  useEffect(() => {
    if (!user) {
      setDriveToken(null);
      setDriveConnected(false);
      return;
    }
    let mounted = true;
    getFreshDriveToken()
      .then((token) => {
        if (mounted) {
          setDriveToken(token);
          setDriveConnected(!!token);
        }
      })
      .catch((err) => {
        console.warn("[Drive] Could not acquire token:", err);
        if (mounted) {
          setDriveToken(null);
          setDriveConnected(false);
        }
      });
    return () => { mounted = false; };
  }, [user]);

  const value = useMemo(() => ({ driveToken, driveConnected }), [driveToken, driveConnected]);

  return <DriveContext.Provider value={value}>{children}</DriveContext.Provider>;
}

// ── Backup & Restore logic ────────────────────────────────────────────────────
const APP_FOLDER_NAME = "FinanceTrackerBackups";

async function ensureAppFolder(token) {
  // Check if folder exists
  const q = `name='${APP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`;
  const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!listResp.ok) throw new Error("Could not list Drive files");
  const listData = await listResp.json();
  if (listData.files && listData.files.length > 0) {
    return listData.files[0].id;
  }
  // Create folder
  const createUrl = `https://www.googleapis.com/drive/v3/files`;
  const createResp = await fetch(createUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: APP_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  if (!createResp.ok) throw new Error("Could not create folder");
  const folder = await createResp.json();
  return folder.id;
}

async function backupToDrive(token, data) {
  const folderId = await ensureAppFolder(token);
  const fileName = `backup_${Date.now()}.json`;
  const metadata = { name: fileName, parents: [folderId] };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
  const resp = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!resp.ok) throw new Error("Backup upload failed");
  return await resp.json();
}

async function listBackupsFromDrive(token) {
  const folderId = await ensureAppFolder(token);
  const q = `'${folderId}' in parents and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,createdTime)&orderBy=createdTime desc`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error("Could not list backups");
  const data = await resp.json();
  return data.files || [];
}

async function downloadBackupFromDrive(token, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error("Could not download backup");
  return await resp.json();
}

// Hook to use Drive context
function useDrive() {
  const ctx = React.useContext(DriveContext);
  if (!ctx) throw new Error("useDrive must be used within DriveProvider");
  return ctx;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════

function App() {
  // Inject the global style
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = LIGHT_MODE_STYLE;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const [data, setData] = useState(() => {
    // Check localStorage on first load
    const migrated = migrateLocalStorage();
    return migrated || defaultData;
  });

  const { user } = data;

  // ── Auth integration ──────────────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        console.log("[Auth] User signed in:", firebaseUser.email);
        setData((prev) => ({ ...prev, user: firebaseUser }));
        // Load data from Firestore
        const stored = await loadFromFirestore(firebaseUser.uid);
        if (stored) {
          setData((prev) => ({ ...prev, ...stored }));
        } else {
          // If no data in Firestore, check if we have local data to migrate
          const local = migrateLocalStorage();
          if (local) {
            await saveToFirestore(firebaseUser.uid, local);
            setData((prev) => ({ ...prev, ...local }));
          }
        }
      } else {
        console.log("[Auth] User signed out");
        setData(defaultData);
      }
    });
    return unsubscribe;
  }, []);

  // Save to Firestore whenever data changes (debounced)
  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(async () => {
      const { user: _, ...dataToSave } = data;
      await saveToFirestore(user.uid, dataToSave);
    }, 1000);
    return () => clearTimeout(timer);
  }, [data, user]);

  // ── Actions ───────────────────────────────────────────────────────────────────
  const updateData = useCallback((updates) => {
    setData((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleSignIn = useCallback(async () => {
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error("[Sign-in Error]", err);
      alert("Sign-in failed: " + err.message);
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    try {
      await signOutUser();
      setData(defaultData);
    } catch (err) {
      console.error("[Sign-out Error]", err);
    }
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────────
  if (!user) {
    return (
      <DriveProvider user={null}>
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          padding: "var(--spacing-lg)",
        }}>
          <div style={{
            background: "var(--color-background-primary)",
            borderRadius: "var(--radius-xl)",
            padding: "var(--spacing-2xl)",
            boxShadow: "var(--shadow-lg)",
            textAlign: "center",
            maxWidth: "450px",
            width: "100%",
            animation: "fadeIn 0.5s ease-out",
          }}>
            <div style={{
              width: "80px",
              height: "80px",
              background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto var(--spacing-xl)",
              fontSize: "36px",
            }}>
              💰
            </div>
            <h1 style={{
              fontSize: "28px",
              fontWeight: "700",
              color: "var(--color-text-primary)",
              marginBottom: "var(--spacing-sm)",
            }}>
              Finance Tracker
            </h1>
            <p style={{
              fontSize: "15px",
              color: "var(--color-text-secondary)",
              marginBottom: "var(--spacing-2xl)",
              lineHeight: "1.6",
            }}>
              Your comprehensive financial management platform. Track assets, liabilities, investments, and more.
            </p>
            <button
              onClick={handleSignIn}
              style={{
                width: "100%",
                padding: "14px 24px",
                background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                color: "#ffffff",
                border: "none",
                borderRadius: "var(--radius-md)",
                fontSize: "16px",
                fontWeight: "600",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "var(--spacing-sm)",
                boxShadow: "var(--shadow-md)",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </button>
            <p style={{
              fontSize: "12px",
              color: "var(--color-text-tertiary)",
              marginTop: "var(--spacing-xl)",
              lineHeight: "1.5",
            }}>
              Your data is securely stored and synced across devices. Sign in to get started.
            </p>
          </div>
        </div>
      </DriveProvider>
    );
  }

  return (
    <DriveProvider user={user}>
      <MainApp data={data} updateData={updateData} onSignOut={handleSignOut} />
    </DriveProvider>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP COMPONENT (After Sign-in)
// ═══════════════════════════════════════════════════════════════════════════════

function MainApp({ data, updateData, onSignOut }) {
  const [activeTab, setActiveTab] = useState("Dashboard");
  const { driveToken, driveConnected } = useDrive();

  // Menu items with icons
  const menuItems = [
    { name: "Dashboard", icon: "📊" },
    { name: "Profile", icon: "👤" },
    { name: "Assets", icon: "💎" },
    { name: "Liabilities", icon: "💳" },
    { name: "Transactions", icon: "💸" },
    { name: "Banks", icon: "🏦" },
    { name: "EMIs", icon: "📅" },
    { name: "F&O Trades", icon: "📈" },
    { name: "Portfolio", icon: "📁" },
    { name: "Goals", icon: "🎯" },
    { name: "Snapshots", icon: "📸" },
    { name: "Payments", icon: "🔔" },
    { name: "Needs vs Wants", icon: "🛒" },
    { name: "Commute", icon: "🚌" },
    { name: "Business", icon: "💼" },
    { name: "Projects", icon: "📋" },
    { name: "Settings", icon: "⚙️" },
  ];

  return (
    <div style={{
      display: "flex",
      minHeight: "100vh",
      background: "var(--color-background-tertiary)",
    }}>
      {/* Sidebar - Desktop */}
      <aside style={{
        width: "260px",
        background: "var(--color-background-primary)",
        borderRight: "1px solid var(--color-border-tertiary)",
        padding: "var(--spacing-lg)",
        display: "flex",
        flexDirection: "column",
        position: "fixed",
        height: "100vh",
        overflowY: "auto",
      }}
      className="desktop-sidebar">
        {/* Logo */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-sm)",
          marginBottom: "var(--spacing-2xl)",
          padding: "var(--spacing-sm)",
        }}>
          <div style={{
            width: "40px",
            height: "40px",
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            borderRadius: "var(--radius-md)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "20px",
          }}>
            💰
          </div>
          <div>
            <div style={{
              fontSize: "16px",
              fontWeight: "700",
              color: "var(--color-text-primary)",
            }}>
              Finance Tracker
            </div>
            <div style={{
              fontSize: "11px",
              color: "var(--color-text-tertiary)",
            }}>
              v2.0
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav style={{ flex: 1 }}>
          {menuItems.map((item) => (
            <button
              key={item.name}
              onClick={() => setActiveTab(item.name)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: "var(--spacing-md)",
                padding: "12px 16px",
                marginBottom: "var(--spacing-xs)",
                background: activeTab === item.name
                  ? "linear-gradient(135deg, #667eea 0%, #764ba2 100%)"
                  : "transparent",
                color: activeTab === item.name
                  ? "#ffffff"
                  : "var(--color-text-secondary)",
                border: "none",
                borderRadius: "var(--radius-md)",
                fontSize: "14px",
                fontWeight: activeTab === item.name ? "600" : "500",
                cursor: "pointer",
                transition: "all 0.2s ease",
                textAlign: "left",
              }}
            >
              <span style={{ fontSize: "18px" }}>{item.icon}</span>
              <span>{item.name}</span>
            </button>
          ))}
        </nav>

        {/* User Profile & Sign Out */}
        <div style={{
          borderTop: "1px solid var(--color-border-tertiary)",
          paddingTop: "var(--spacing-lg)",
          marginTop: "var(--spacing-lg)",
        }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-md)",
            marginBottom: "var(--spacing-md)",
            padding: "var(--spacing-sm)",
          }}>
            <img
              src={data.user?.photoURL || "https://via.placeholder.com/40"}
              alt="User"
              style={{
                width: "40px",
                height: "40px",
                borderRadius: "50%",
                border: "2px solid var(--color-border-secondary)",
              }}
            />
            <div style={{ flex: 1, overflow: "hidden" }}>
              <div style={{
                fontSize: "13px",
                fontWeight: "600",
                color: "var(--color-text-primary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {data.user?.displayName || "User"}
              </div>
              <div style={{
                fontSize: "11px",
                color: "var(--color-text-tertiary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {data.user?.email}
              </div>
            </div>
          </div>
          <button
            onClick={onSignOut}
            style={{
              width: "100%",
              padding: "10px 16px",
              background: "var(--color-danger)",
              color: "#ffffff",
              border: "none",
              borderRadius: "var(--radius-md)",
              fontSize: "13px",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main style={{
        flex: 1,
        marginLeft: "260px",
        padding: "var(--spacing-2xl)",
        maxWidth: "100%",
        overflowX: "hidden",
      }}
      className="main-content">
        {/* Header */}
        <header style={{
          marginBottom: "var(--spacing-2xl)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "var(--spacing-lg)",
        }}>
          <div>
            <h1 style={{
              fontSize: "28px",
              fontWeight: "700",
              color: "var(--color-text-primary)",
              marginBottom: "var(--spacing-xs)",
            }}>
              {menuItems.find(item => item.name === activeTab)?.icon} {activeTab}
            </h1>
            <p style={{
              fontSize: "14px",
              color: "var(--color-text-secondary)",
            }}>
              Welcome back, {data.user?.displayName?.split(' ')[0] || 'User'}!
            </p>
          </div>
          
          {/* Drive Status Badge */}
          {driveConnected && (
            <div style={{
              padding: "8px 16px",
              background: "var(--color-background-secondary)",
              border: "1px solid var(--color-border-secondary)",
              borderRadius: "var(--radius-md)",
              display: "flex",
              alignItems: "center",
              gap: "var(--spacing-sm)",
              fontSize: "13px",
              color: "var(--color-success)",
            }}>
              <span>✓</span>
              <span>Drive Connected</span>
            </div>
          )}
        </header>

        {/* Tab Content */}
        <div className="fade-in">
          {activeTab === "Dashboard" && <Dashboard data={data} />}
          {activeTab === "Profile" && <Profile data={data} updateData={updateData} />}
          {activeTab === "Assets" && <Assets data={data} updateData={updateData} />}
          {activeTab === "Liabilities" && <Liabilities data={data} updateData={updateData} />}
          {activeTab === "Transactions" && <Transactions data={data} updateData={updateData} />}
          {activeTab === "Banks" && <Banks data={data} updateData={updateData} />}
          {activeTab === "EMIs" && <EMIs data={data} updateData={updateData} />}
          {activeTab === "F&O Trades" && <FOTrades data={data} updateData={updateData} />}
          {activeTab === "Portfolio" && <Portfolio data={data} updateData={updateData} />}
          {activeTab === "Goals" && <Goals data={data} updateData={updateData} />}
          {activeTab === "Snapshots" && <Snapshots data={data} updateData={updateData} />}
          {activeTab === "Payments" && <ScheduledPayments data={data} updateData={updateData} />}
          {activeTab === "Needs vs Wants" && <NeedsWants data={data} updateData={updateData} />}
          {activeTab === "Commute" && <Commute data={data} updateData={updateData} />}
          {activeTab === "Business" && <Business data={data} updateData={updateData} />}
          {activeTab === "Projects" && <Projects data={data} updateData={updateData} />}
          {activeTab === "Settings" && <Settings data={data} updateData={updateData} driveToken={driveToken} />}
        </div>
      </main>

      {/* Mobile Navigation - Bottom Tab Bar */}
      <style>{`
        @media (max-width: 767px) {
          .desktop-sidebar {
            display: none;
          }
          
          .main-content {
            margin-left: 0 !important;
            padding-bottom: 80px !important;
          }
        }
        
        @media (min-width: 768px) {
          .mobile-nav {
            display: none;
          }
        }
      `}</style>

      <nav className="mobile-nav" style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        background: "var(--color-background-primary)",
        borderTop: "1px solid var(--color-border-tertiary)",
        padding: "var(--spacing-sm) 0",
        display: "flex",
        justifyContent: "space-around",
        alignItems: "center",
        zIndex: 1000,
        boxShadow: "0 -2px 10px rgba(0,0,0,0.05)",
      }}>
        {[
          { name: "Dashboard", icon: "📊" },
          { name: "Assets", icon: "💎" },
          { name: "Transactions", icon: "💸" },
          { name: "Portfolio", icon: "📁" },
          { name: "Settings", icon: "⚙️" },
        ].map((item) => (
          <button
            key={item.name}
            onClick={() => setActiveTab(item.name)}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "4px",
              padding: "8px",
              background: "transparent",
              border: "none",
              color: activeTab === item.name
                ? "var(--color-primary)"
                : "var(--color-text-tertiary)",
              fontSize: "10px",
              fontWeight: activeTab === item.name ? "600" : "400",
              cursor: "pointer",
            }}
          >
            <span style={{ fontSize: "20px" }}>{item.icon}</span>
            <span>{item.name}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function Dashboard({ data }) {
  // Calculate total assets
  const totalAssets = data.assets.reduce((sum, asset) => sum + (parseFloat(asset.value) || 0), 0);
  
  // Calculate total liabilities
  const totalLiabilities = data.liabilities.reduce((sum, liability) => 
    sum + (parseFloat(liability.outstanding) || 0), 0
  );
  
  // Net worth
  const netWorth = totalAssets - totalLiabilities;
  
  // Monthly income and expenses
  const monthlyIncome = parseFloat(data.profile.income) || 0;
  const monthlyExpense = parseFloat(data.profile.expense) || 0;
  const monthlySavings = monthlyIncome - monthlyExpense;
  const savingsRate = monthlyIncome > 0 ? (monthlySavings / monthlyIncome * 100) : 0;

  // Recent transactions
  const recentTransactions = data.transactions
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xl)" }}>
      {/* Key Metrics */}
      <div className="responsive-grid" style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: "var(--spacing-lg)",
      }}>
        <StatCard
          icon="💰"
          label="Net Worth"
          value={fmtCur(netWorth)}
          subtext={netWorth >= 0 ? "Total assets - liabilities" : "Negative net worth"}
          color={netWorth >= 0 ? "var(--color-success)" : "var(--color-danger)"}
          trend={netWorth >= 0 ? "up" : "down"}
        />
        <StatCard
          icon="💎"
          label="Total Assets"
          value={fmtCur(totalAssets)}
          subtext={`${data.assets.length} asset${data.assets.length !== 1 ? 's' : ''}`}
          color="var(--color-primary)"
        />
        <StatCard
          icon="💳"
          label="Total Liabilities"
          value={fmtCur(totalLiabilities)}
          subtext={`${data.liabilities.length} liabilit${data.liabilities.length !== 1 ? 'ies' : 'y'}`}
          color="var(--color-warning)"
        />
        <StatCard
          icon="📊"
          label="Savings Rate"
          value={savingsRate.toFixed(1) + "%"}
          subtext={`₹${fmt(monthlySavings)}/month`}
          color={savingsRate >= 20 ? "var(--color-success)" : "var(--color-warning)"}
        />
      </div>

      {/* Financial Overview Cards */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
        gap: "var(--spacing-lg)",
      }}>
        {/* Monthly Cash Flow */}
        <Card title="💸 Monthly Cash Flow">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
            <CashFlowItem label="Income" value={monthlyIncome} color="var(--color-success)" />
            <CashFlowItem label="Expenses" value={monthlyExpense} color="var(--color-danger)" />
            <div style={{
              height: "1px",
              background: "var(--color-border-secondary)",
              margin: "var(--spacing-sm) 0",
            }} />
            <CashFlowItem
              label="Net Savings"
              value={monthlySavings}
              color={monthlySavings >= 0 ? "var(--color-success)" : "var(--color-danger)"}
              bold
            />
          </div>
        </Card>

        {/* Asset Allocation */}
        <Card title="💎 Asset Allocation">
          {data.assets.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
              {ASSET_TYPES.map(type => {
                const typeAssets = data.assets.filter(a => a.type === type);
                const typeTotal = typeAssets.reduce((sum, a) => sum + (parseFloat(a.value) || 0), 0);
                const percentage = totalAssets > 0 ? (typeTotal / totalAssets * 100) : 0;
                if (percentage === 0) return null;
                return (
                  <AllocationBar
                    key={type}
                    label={type}
                    value={typeTotal}
                    percentage={percentage}
                  />
                );
              })}
            </div>
          ) : (
            <EmptyState message="No assets added yet" icon="💎" />
          )}
        </Card>
      </div>

      {/* Recent Transactions */}
      <Card title="💸 Recent Transactions">
        {recentTransactions.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
            {recentTransactions.map((txn, idx) => (
              <TransactionItem key={idx} transaction={txn} />
            ))}
          </div>
        ) : (
          <EmptyState message="No transactions yet" icon="💸" />
        )}
      </Card>

      {/* Quick Stats */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: "var(--spacing-lg)",
      }}>
        <QuickStat icon="🏦" label="Banks" value={data.banks.length} />
        <QuickStat icon="📅" label="Active EMIs" value={data.emis.length} />
        <QuickStat icon="📁" label="Portfolio Holdings" value={data.portfolioHoldings.length} />
        <QuickStat icon="🎯" label="Goals" value={data.goals.length} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// REUSABLE UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function Card({ title, children, actions }) {
  return (
    <div className="card" style={{
      background: "var(--color-background-primary)",
      borderRadius: "var(--radius-lg)",
      padding: "var(--spacing-xl)",
      boxShadow: "var(--shadow-sm)",
      border: "1px solid var(--color-border-tertiary)",
    }}>
      {title && (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "var(--spacing-lg)",
        }}>
          <h3 style={{
            fontSize: "18px",
            fontWeight: "600",
            color: "var(--color-text-primary)",
          }}>
            {title}
          </h3>
          {actions && <div>{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

function StatCard({ icon, label, value, subtext, color, trend }) {
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--spacing-md)" }}>
        <div style={{
          width: "48px",
          height: "48px",
          borderRadius: "var(--radius-md)",
          background: color ? `${color}15` : "var(--color-background-secondary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "24px",
          flexShrink: 0,
        }}>
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: "13px",
            color: "var(--color-text-secondary)",
            marginBottom: "var(--spacing-xs)",
            fontWeight: "500",
          }}>
            {label}
          </div>
          <div style={{
            fontSize: "24px",
            fontWeight: "700",
            color: color || "var(--color-text-primary)",
            marginBottom: "var(--spacing-xs)",
            wordBreak: "break-word",
          }}>
            {value}
          </div>
          {subtext && (
            <div style={{
              fontSize: "12px",
              color: "var(--color-text-tertiary)",
              display: "flex",
              alignItems: "center",
              gap: "var(--spacing-xs)",
            }}>
              {trend === "up" && <span style={{ color: "var(--color-success)" }}>↗</span>}
              {trend === "down" && <span style={{ color: "var(--color-danger)" }}>↘</span>}
              {subtext}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function CashFlowItem({ label, value, color, bold }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      fontSize: bold ? "16px" : "14px",
      fontWeight: bold ? "600" : "400",
    }}>
      <span style={{ color: "var(--color-text-secondary)" }}>{label}</span>
      <span style={{ color: color, fontWeight: "600" }}>{fmtCur(value)}</span>
    </div>
  );
}

function AllocationBar({ label, value, percentage }) {
  return (
    <div>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "6px",
        fontSize: "13px",
      }}>
        <span style={{ color: "var(--color-text-secondary)" }}>{label}</span>
        <span style={{ fontWeight: "600", color: "var(--color-text-primary)" }}>
          {fmtCur(value)} ({percentage.toFixed(1)}%)
        </span>
      </div>
      <div style={{
        width: "100%",
        height: "8px",
        background: "var(--color-background-tertiary)",
        borderRadius: "4px",
        overflow: "hidden",
      }}>
        <div style={{
          width: `${percentage}%`,
          height: "100%",
          background: "linear-gradient(90deg, #667eea 0%, #764ba2 100%)",
          borderRadius: "4px",
          transition: "width 0.3s ease",
        }} />
      </div>
    </div>
  );
}

function TransactionItem({ transaction }) {
  const isExpense = transaction.type === "Expense";
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "var(--spacing-md)",
      background: "var(--color-background-secondary)",
      borderRadius: "var(--radius-md)",
      transition: "all 0.2s ease",
    }}
    onMouseEnter={e => e.currentTarget.style.background = "var(--color-background-hover)"}
    onMouseLeave={e => e.currentTarget.style.background = "var(--color-background-secondary)"}>
      <div style={{ flex: 1 }}>
        <div style={{
          fontSize: "14px",
          fontWeight: "500",
          color: "var(--color-text-primary)",
          marginBottom: "4px",
        }}>
          {transaction.category}
        </div>
        <div style={{
          fontSize: "12px",
          color: "var(--color-text-tertiary)",
        }}>
          {new Date(transaction.date).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
          })}
        </div>
      </div>
      <div style={{
        fontSize: "16px",
        fontWeight: "600",
        color: isExpense ? "var(--color-danger)" : "var(--color-success)",
      }}>
        {isExpense ? "-" : "+"}{fmtCur(transaction.amount)}
      </div>
    </div>
  );
}

function QuickStat({ icon, label, value }) {
  return (
    <div style={{
      background: "var(--color-background-primary)",
      borderRadius: "var(--radius-lg)",
      padding: "var(--spacing-lg)",
      boxShadow: "var(--shadow-sm)",
      border: "1px solid var(--color-border-tertiary)",
      display: "flex",
      alignItems: "center",
      gap: "var(--spacing-md)",
    }}>
      <div style={{
        fontSize: "32px",
        lineHeight: 1,
      }}>
        {icon}
      </div>
      <div>
        <div style={{
          fontSize: "24px",
          fontWeight: "700",
          color: "var(--color-text-primary)",
        }}>
          {value}
        </div>
        <div style={{
          fontSize: "13px",
          color: "var(--color-text-secondary)",
        }}>
          {label}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ message, icon }) {
  return (
    <div style={{
      textAlign: "center",
      padding: "var(--spacing-2xl)",
      color: "var(--color-text-tertiary)",
    }}>
      <div style={{ fontSize: "48px", marginBottom: "var(--spacing-md)", opacity: 0.5 }}>
        {icon}
      </div>
      <div style={{ fontSize: "14px" }}>{message}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function Profile({ data, updateData }) {
  const [profile, setProfile] = useState(data.profile);

  const handleSave = () => {
    updateData({ profile });
  };

  return (
    <div style={{ maxWidth: "800px" }}>
      <Card title="💼 Financial Profile">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "var(--spacing-lg)" }}>
            <FormField
              label="Age"
              type="number"
              value={profile.age}
              onChange={(e) => setProfile({ ...profile, age: e.target.value })}
              placeholder="Enter your age"
            />
            <FormField
              label="Monthly Income (₹)"
              type="number"
              value={profile.income}
              onChange={(e) => setProfile({ ...profile, income: e.target.value })}
              placeholder="Enter monthly income"
            />
          </div>
          
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "var(--spacing-lg)" }}>
            <FormField
              label="Monthly Expenses (₹)"
              type="number"
              value={profile.expense}
              onChange={(e) => setProfile({ ...profile, expense: e.target.value })}
              placeholder="Enter monthly expenses"
            />
            <FormField
              label="Current Savings (₹)"
              type="number"
              value={profile.savings}
              onChange={(e) => setProfile({ ...profile, savings: e.target.value })}
              placeholder="Enter current savings"
            />
          </div>

          {/* Summary */}
          {profile.income && profile.expense && (
            <div style={{
              background: "var(--color-background-secondary)",
              borderRadius: "var(--radius-md)",
              padding: "var(--spacing-lg)",
              marginTop: "var(--spacing-md)",
            }}>
              <h4 style={{ fontSize: "14px", fontWeight: "600", marginBottom: "var(--spacing-md)", color: "var(--color-text-primary)" }}>
                Monthly Summary
              </h4>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                  <span style={{ color: "var(--color-text-secondary)" }}>Net Savings:</span>
                  <span style={{ fontWeight: "600", color: profile.income - profile.expense >= 0 ? "var(--color-success)" : "var(--color-danger)" }}>
                    {fmtCur(profile.income - profile.expense)}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                  <span style={{ color: "var(--color-text-secondary)" }}>Savings Rate:</span>
                  <span style={{ fontWeight: "600", color: "var(--color-text-primary)" }}>
                    {((profile.income - profile.expense) / profile.income * 100).toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>
          )}

          <Button onClick={handleSave} primary>
            Save Profile
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ASSETS COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function Assets({ data, updateData }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ type: "", name: "", value: "" });

  const handleAdd = () => {
    if (!form.type || !form.name || !form.value) return;
    const newAsset = { ...form, id: Date.now(), value: parseFloat(form.value) };
    updateData({ assets: [...data.assets, newAsset] });
    setForm({ type: "", name: "", value: "" });
    setShowForm(false);
  };

  const handleEdit = (asset) => {
    setForm(asset);
    setEditingId(asset.id);
    setShowForm(true);
  };

  const handleUpdate = () => {
    updateData({
      assets: data.assets.map(a => a.id === editingId ? { ...form, value: parseFloat(form.value) } : a)
    });
    setForm({ type: "", name: "", value: "" });
    setEditingId(null);
    setShowForm(false);
  };

  const handleDelete = (id) => {
    if (confirm("Are you sure you want to delete this asset?")) {
      updateData({ assets: data.assets.filter(a => a.id !== id) });
    }
  };

  const totalValue = data.assets.reduce((sum, a) => sum + (parseFloat(a.value) || 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      {/* Summary Card */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--spacing-lg)" }}>
        <StatCard
          icon="💎"
          label="Total Assets"
          value={fmtCur(totalValue)}
          subtext={`${data.assets.length} assets`}
          color="var(--color-success)"
        />
        <StatCard
          icon="📊"
          label="Average Value"
          value={fmtCur(data.assets.length > 0 ? totalValue / data.assets.length : 0)}
          subtext="Per asset"
          color="var(--color-info)"
        />
      </div>

      {/* Add Asset Button */}
      <div>
        <Button onClick={() => setShowForm(!showForm)} primary>
          {showForm ? "Cancel" : "+ Add Asset"}
        </Button>
      </div>

      {/* Add/Edit Form */}
      {showForm && (
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
            <h3 style={{ fontSize: "16px", fontWeight: "600" }}>
              {editingId ? "Edit Asset" : "Add New Asset"}
            </h3>
            
            <FormField
              label="Asset Type"
              as="select"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              <option value="">Select type</option>
              {ASSET_TYPES.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </FormField>

            <FormField
              label="Asset Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g., HDFC Bank Savings Account"
            />

            <FormField
              label="Current Value (₹)"
              type="number"
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
              placeholder="Enter current value"
            />

            <div style={{ display: "flex", gap: "var(--spacing-md)" }}>
              {editingId ? (
                <>
                  <Button onClick={handleUpdate} primary>Update Asset</Button>
                  <Button onClick={() => {
                    setForm({ type: "", name: "", value: "" });
                    setEditingId(null);
                    setShowForm(false);
                  }}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button onClick={handleAdd} primary>Add Asset</Button>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Assets List */}
      <Card title="Your Assets">
        {data.assets.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--color-border-secondary)" }}>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "left", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Type</th>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "left", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Name</th>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "right", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Value</th>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "right", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>% of Total</th>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "center", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.assets.map((asset) => {
                  const percentage = totalValue > 0 ? (asset.value / totalValue * 100) : 0;
                  return (
                    <tr key={asset.id} style={{ borderBottom: "1px solid var(--color-border-tertiary)" }}>
                      <td style={{ padding: "var(--spacing-md)", fontSize: "14px" }}>
                        <span style={{ background: "var(--color-background-secondary)", padding: "4px 8px", borderRadius: "4px", fontSize: "12px" }}>
                          {asset.type}
                        </span>
                      </td>
                      <td style={{ padding: "var(--spacing-md)", fontSize: "14px", color: "var(--color-text-primary)", fontWeight: "500" }}>
                        {asset.name}
                      </td>
                      <td style={{ padding: "var(--spacing-md)", textAlign: "right", fontSize: "14px", fontWeight: "600" }}>
                        {fmtCur(asset.value)}
                      </td>
                      <td style={{ padding: "var(--spacing-md)", textAlign: "right", fontSize: "13px", color: "var(--color-text-secondary)" }}>
                        {percentage.toFixed(1)}%
                      </td>
                      <td style={{ padding: "var(--spacing-md)", textAlign: "center" }}>
                        <div style={{ display: "flex", gap: "var(--spacing-sm)", justifyContent: "center" }}>
                          <ActionButton onClick={() => handleEdit(asset)} icon="✏️" />
                          <ActionButton onClick={() => handleDelete(asset.id)} icon="🗑️" danger />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState message="No assets added yet. Click 'Add Asset' to get started." icon="💎" />
        )}
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIABILITIES COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function Liabilities({ data, updateData }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ type: "", name: "", outstanding: "", interestRate: "" });

  const handleAdd = () => {
    if (!form.type || !form.name || !form.outstanding) return;
    const newLiability = {
      ...form,
      id: Date.now(),
      outstanding: parseFloat(form.outstanding),
      interestRate: parseFloat(form.interestRate) || 0
    };
    updateData({ liabilities: [...data.liabilities, newLiability] });
    setForm({ type: "", name: "", outstanding: "", interestRate: "" });
    setShowForm(false);
  };

  const handleEdit = (liability) => {
    setForm(liability);
    setEditingId(liability.id);
    setShowForm(true);
  };

  const handleUpdate = () => {
    updateData({
      liabilities: data.liabilities.map(l => l.id === editingId ? {
        ...form,
        outstanding: parseFloat(form.outstanding),
        interestRate: parseFloat(form.interestRate) || 0
      } : l)
    });
    setForm({ type: "", name: "", outstanding: "", interestRate: "" });
    setEditingId(null);
    setShowForm(false);
  };

  const handleDelete = (id) => {
    if (confirm("Are you sure you want to delete this liability?")) {
      updateData({ liabilities: data.liabilities.filter(l => l.id !== id) });
    }
  };

  const totalOutstanding = data.liabilities.reduce((sum, l) => sum + (parseFloat(l.outstanding) || 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      {/* Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--spacing-lg)" }}>
        <StatCard
          icon="💳"
          label="Total Outstanding"
          value={fmtCur(totalOutstanding)}
          subtext={`${data.liabilities.length} liabilities`}
          color="var(--color-danger)"
        />
        <StatCard
          icon="📊"
          label="Average Outstanding"
          value={fmtCur(data.liabilities.length > 0 ? totalOutstanding / data.liabilities.length : 0)}
          subtext="Per liability"
          color="var(--color-warning)"
        />
      </div>

      <div>
        <Button onClick={() => setShowForm(!showForm)} primary>
          {showForm ? "Cancel" : "+ Add Liability"}
        </Button>
      </div>

      {showForm && (
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
            <h3 style={{ fontSize: "16px", fontWeight: "600" }}>
              {editingId ? "Edit Liability" : "Add New Liability"}
            </h3>
            
            <FormField
              label="Liability Type"
              as="select"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              <option value="">Select type</option>
              {data.liabilityTypes.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </FormField>

            <FormField
              label="Name/Description"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g., HDFC Credit Card"
            />

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--spacing-lg)" }}>
              <FormField
                label="Outstanding Amount (₹)"
                type="number"
                value={form.outstanding}
                onChange={(e) => setForm({ ...form, outstanding: e.target.value })}
                placeholder="Enter outstanding amount"
              />

              <FormField
                label="Interest Rate (%)"
                type="number"
                value={form.interestRate}
                onChange={(e) => setForm({ ...form, interestRate: e.target.value })}
                placeholder="e.g., 12.5"
              />
            </div>

            <div style={{ display: "flex", gap: "var(--spacing-md)" }}>
              {editingId ? (
                <>
                  <Button onClick={handleUpdate} primary>Update Liability</Button>
                  <Button onClick={() => {
                    setForm({ type: "", name: "", outstanding: "", interestRate: "" });
                    setEditingId(null);
                    setShowForm(false);
                  }}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button onClick={handleAdd} primary>Add Liability</Button>
              )}
            </div>
          </div>
        </Card>
      )}

      <Card title="Your Liabilities">
        {data.liabilities.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--color-border-secondary)" }}>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "left", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Type</th>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "left", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Name</th>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "right", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Outstanding</th>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "right", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Interest Rate</th>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "center", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.liabilities.map((liability) => (
                  <tr key={liability.id} style={{ borderBottom: "1px solid var(--color-border-tertiary)" }}>
                    <td style={{ padding: "var(--spacing-md)", fontSize: "14px" }}>
                      <span style={{ background: "var(--color-background-secondary)", padding: "4px 8px", borderRadius: "4px", fontSize: "12px" }}>
                        {liability.type}
                      </span>
                    </td>
                    <td style={{ padding: "var(--spacing-md)", fontSize: "14px", color: "var(--color-text-primary)", fontWeight: "500" }}>
                      {liability.name}
                    </td>
                    <td style={{ padding: "var(--spacing-md)", textAlign: "right", fontSize: "14px", fontWeight: "600", color: "var(--color-danger)" }}>
                      {fmtCur(liability.outstanding)}
                    </td>
                    <td style={{ padding: "var(--spacing-md)", textAlign: "right", fontSize: "14px", color: "var(--color-text-secondary)" }}>
                      {liability.interestRate}%
                    </td>
                    <td style={{ padding: "var(--spacing-md)", textAlign: "center" }}>
                      <div style={{ display: "flex", gap: "var(--spacing-sm)", justifyContent: "center" }}>
                        <ActionButton onClick={() => handleEdit(liability)} icon="✏️" />
                        <ActionButton onClick={() => handleDelete(liability.id)} icon="🗑️" danger />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState message="No liabilities added yet." icon="💳" />
        )}
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSACTIONS COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function Transactions({ data, updateData }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ type: "Expense", category: "", amount: "", date: new Date().toISOString().split('T')[0], note: "" });
  const [filter, setFilter] = useState("All");

  const handleAdd = () => {
    if (!form.category || !form.amount) return;
    const newTxn = { ...form, id: Date.now(), amount: parseFloat(form.amount) };
    updateData({ transactions: [...data.transactions, newTxn] });
    setForm({ type: "Expense", category: "", amount: "", date: new Date().toISOString().split('T')[0], note: "" });
    setShowForm(false);
  };

  const handleDelete = (id) => {
    if (confirm("Delete this transaction?")) {
      updateData({ transactions: data.transactions.filter(t => t.id !== id) });
    }
  };

  const filteredTransactions = filter === "All" 
    ? data.transactions 
    : data.transactions.filter(t => t.type === filter);

  const sortedTransactions = filteredTransactions.slice().sort((a, b) => new Date(b.date) - new Date(a.date));

  const totalIncome = data.transactions.filter(t => t.type === "Income").reduce((sum, t) => sum + t.amount, 0);
  const totalExpense = data.transactions.filter(t => t.type === "Expense").reduce((sum, t) => sum + t.amount, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      {/* Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--spacing-lg)" }}>
        <StatCard icon="📥" label="Total Income" value={fmtCur(totalIncome)} color="var(--color-success)" />
        <StatCard icon="📤" label="Total Expense" value={fmtCur(totalExpense)} color="var(--color-danger)" />
        <StatCard icon="💰" label="Net" value={fmtCur(totalIncome - totalExpense)} 
          color={totalIncome - totalExpense >= 0 ? "var(--color-success)" : "var(--color-danger)"} />
      </div>

      <div style={{ display: "flex", gap: "var(--spacing-md)", flexWrap: "wrap" }}>
        <Button onClick={() => setShowForm(!showForm)} primary>
          {showForm ? "Cancel" : "+ Add Transaction"}
        </Button>
        
        <div style={{ display: "flex", gap: "var(--spacing-xs)" }}>
          {["All", "Income", "Expense"].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: "8px 16px",
                background: filter === f ? "var(--color-primary)" : "var(--color-background-secondary)",
                color: filter === f ? "#ffffff" : "var(--color-text-secondary)",
                border: "1px solid var(--color-border-secondary)",
                borderRadius: "var(--radius-md)",
                fontSize: "13px",
                fontWeight: "500",
                cursor: "pointer",
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {showForm && (
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
            <h3 style={{ fontSize: "16px", fontWeight: "600" }}>Add New Transaction</h3>
            
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--spacing-lg)" }}>
              <FormField label="Type" as="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="Income">Income</option>
                <option value="Expense">Expense</option>
              </FormField>

              <FormField
                label="Category"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="e.g., Salary, Food, Transport"
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--spacing-lg)" }}>
              <FormField
                label="Amount (₹)"
                type="number"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                placeholder="Enter amount"
              />

              <FormField
                label="Date"
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </div>

            <FormField
              label="Note (Optional)"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="Add a note"
            />

            <Button onClick={handleAdd} primary>Add Transaction</Button>
          </div>
        </Card>
      )}

      <Card title={`Transactions (${sortedTransactions.length})`}>
        {sortedTransactions.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--color-border-secondary)" }}>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "left", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Date</th>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "left", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Type</th>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "left", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Category</th>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "left", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Note</th>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "right", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Amount</th>
                  <th style={{ padding: "var(--spacing-md)", textAlign: "center", fontSize: "13px", fontWeight: "600", color: "var(--color-text-secondary)" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedTransactions.map((txn) => (
                  <tr key={txn.id} style={{ borderBottom: "1px solid var(--color-border-tertiary)" }}>
                    <td style={{ padding: "var(--spacing-md)", fontSize: "13px", color: "var(--color-text-secondary)" }}>
                      {new Date(txn.date).toLocaleDateString('en-IN')}
                    </td>
                    <td style={{ padding: "var(--spacing-md)", fontSize: "14px" }}>
                      <span style={{
                        background: txn.type === "Income" ? "#d1fae520" : "#fee2e220",
                        color: txn.type === "Income" ? "var(--color-success)" : "var(--color-danger)",
                        padding: "4px 8px",
                        borderRadius: "4px",
                        fontSize: "12px",
                        fontWeight: "500"
                      }}>
                        {txn.type === "Income" ? "📥" : "📤"} {txn.type}
                      </span>
                    </td>
                    <td style={{ padding: "var(--spacing-md)", fontSize: "14px", fontWeight: "500" }}>
                      {txn.category}
                    </td>
                    <td style={{ padding: "var(--spacing-md)", fontSize: "13px", color: "var(--color-text-tertiary)", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {txn.note || "—"}
                    </td>
                    <td style={{ padding: "var(--spacing-md)", textAlign: "right", fontSize: "14px", fontWeight: "600", color: txn.type === "Income" ? "var(--color-success)" : "var(--color-danger)" }}>
                      {txn.type === "Income" ? "+" : "-"}{fmtCur(txn.amount)}
                    </td>
                    <td style={{ padding: "var(--spacing-md)", textAlign: "center" }}>
                      <ActionButton onClick={() => handleDelete(txn.id)} icon="🗑️" danger />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState message="No transactions found." icon="💸" />
        )}
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMON FORM COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function FormField({ label, as = "input", children, ...props }) {
  const Component = as;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <label style={{ fontSize: "13px", fontWeight: "500", color: "var(--color-text-secondary)" }}>
        {label}
      </label>
      <Component {...props} style={{ ...props.style }}>
        {children}
      </Component>
    </div>
  );
}

function Button({ children, primary, danger, onClick, disabled, ...props }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "10px 20px",
        background: danger ? "var(--color-danger)" : primary ? "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" : "var(--color-background-secondary)",
        color: danger || primary ? "#ffffff" : "var(--color-text-primary)",
        border: primary || danger ? "none" : "1px solid var(--color-border-secondary)",
        borderRadius: "var(--radius-md)",
        fontSize: "14px",
        fontWeight: "500",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        ...props.style
      }}
      {...props}
    >
      {children}
    </button>
  );
}

function ActionButton({ onClick, icon, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 10px",
        background: danger ? "#fee2e2" : "var(--color-background-secondary)",
        color: danger ? "var(--color-danger)" : "var(--color-text-secondary)",
        border: "none",
        borderRadius: "var(--radius-sm)",
        fontSize: "14px",
        cursor: "pointer",
      }}
    >
      {icon}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLACEHOLDER COMPONENTS (Simplified for now)
// ═══════════════════════════════════════════════════════════════════════════════

function Banks({ data, updateData }) {
  return <Card title="Banks"><EmptyState message="Banks management coming soon" icon="🏦" /></Card>;
}

function EMIs({ data, updateData }) {
  return <Card title="EMIs"><EmptyState message="EMI tracking coming soon" icon="📅" /></Card>;
}

function FOTrades({ data, updateData }) {
  return <Card title="F&O Trades"><EmptyState message="F&O trading tracker coming soon" icon="📈" /></Card>;
}

function Portfolio({ data, updateData }) {
  return <Card title="Portfolio"><EmptyState message="Portfolio management coming soon" icon="📁" /></Card>;
}

function Goals({ data, updateData }) {
  return <Card title="Goals"><EmptyState message="Financial goals coming soon" icon="🎯" /></Card>;
}

function Snapshots({ data, updateData }) {
  return <Card title="Snapshots"><EmptyState message="Net worth snapshots coming soon" icon="📸" /></Card>;
}

function ScheduledPayments({ data, updateData }) {
  return <Card title="Scheduled Payments"><EmptyState message="Payment scheduling coming soon" icon="🔔" /></Card>;
}

function NeedsWants({ data, updateData }) {
  return <Card title="Needs vs Wants"><EmptyState message="Needs vs Wants analysis coming soon" icon="🛒" /></Card>;
}

function Commute({ data, updateData }) {
  return <Card title="Commute"><EmptyState message="Commute tracking coming soon" icon="🚌" /></Card>;
}

function Business({ data, updateData }) {
  return <Card title="Business"><EmptyState message="Business management coming soon" icon="💼" /></Card>;
}

function Projects({ data, updateData }) {
  return <Card title="Projects"><EmptyState message="Project management coming soon" icon="📋" /></Card>;
}

function Settings({ data, updateData, driveToken }) {
  return (
    <Card title="Settings">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xl)" }}>
        <div>
          <h4 style={{ fontSize: "14px", fontWeight: "600", marginBottom: "var(--spacing-md)" }}>
            Feature Toggles
          </h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={data.featureToggles.fo}
                onChange={(e) => updateData({
                  featureToggles: { ...data.featureToggles, fo: e.target.checked }
                })}
              />
              <span style={{ fontSize: "14px" }}>Enable F&O Trading</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={data.featureToggles.portfolio}
                onChange={(e) => updateData({
                  featureToggles: { ...data.featureToggles, portfolio: e.target.checked }
                })}
              />
              <span style={{ fontSize: "14px" }}>Enable Portfolio Management</span>
            </label>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--color-border-tertiary)", paddingTop: "var(--spacing-lg)" }}>
          <h4 style={{ fontSize: "14px", fontWeight: "600", marginBottom: "var(--spacing-md)" }}>
            Data Management
          </h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
              Your data is automatically synced to Firestore when signed in.
            </p>
            {driveToken && (
              <p style={{ fontSize: "13px", color: "var(--color-success)" }}>
                ✓ Google Drive backup is connected
              </p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

export default App;
