import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import {
  getAuth,
  signInWithCustomToken,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  writeBatch,
  deleteDoc,
  query,
  orderBy,
} from "firebase/firestore";

// ══════════════════════════════════════════════════════════════════════════════
// FIREBASE CONFIG — from environment variables only
// ══════════════════════════════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId:     import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
export const auth = getAuth(app);
export const db   = getFirestore(app);

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE AUTH — Full OAuth redirect flow
// ══════════════════════════════════════════════════════════════════════════════
let _cachedAccessToken = null;
let _tokenExpiresAt    = 0;

export function signInWithGoogle() {
  window.location.href = "/api/auth/google";
}

export async function handleAuthCallback() {
  const params      = new URLSearchParams(window.location.search);
  const customToken = params.get("custom_token");
  const authError   = params.get("auth_error");

  if (customToken || authError) {
    window.history.replaceState({}, "", window.location.pathname);
  }

  if (authError) {
    console.error("[auth] OAuth error:", authError);
    throw new Error(decodeURIComponent(authError));
  }

  if (customToken) {
    console.log("[auth] Custom token received — signing into Firebase...");
    await signInWithCustomToken(auth, customToken);
    console.log("[auth] Firebase sign-in complete ✅");
    return true;
  }

  return false;
}

export async function getFreshDriveToken() {
  const user = auth.currentUser;
  if (!user) return null;

  if (_cachedAccessToken && Date.now() < _tokenExpiresAt - 5 * 60 * 1000) {
    return _cachedAccessToken;
  }

  try {
    const idToken = await user.getIdToken();
    const res = await fetch("/api/drive-token", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action: "refresh", idToken }),
    });

    if (!res.ok) {
      _cachedAccessToken = null;
      _tokenExpiresAt    = 0;
      return null;
    }

    const { accessToken, expiresIn } = await res.json();
    _cachedAccessToken = accessToken;
    _tokenExpiresAt    = Date.now() + (expiresIn - 60) * 1000;
    return accessToken;
  } catch (err) {
    console.error("[drive] Token fetch error:", err.message);
    return null;
  }
}

export async function clearDriveToken() {
  _cachedAccessToken = null;
  _tokenExpiresAt    = 0;
  const user = auth.currentUser;
  if (user) {
    try {
      const idToken = await user.getIdToken();
      await fetch("/api/drive-token", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "revoke", idToken }),
      });
    } catch (e) {
      console.warn("[drive] Revoke error:", e.message);
    }
  }
}

export const signOutUser = () => {
  _cachedAccessToken = null;
  _tokenExpiresAt    = 0;
  return signOut(auth);
};

export { onAuthStateChanged };

// ══════════════════════════════════════════════════════════════════════════════
// FIRESTORE STRUCTURE
// ══════════════════════════════════════════════════════════════════════════════
//
// users/{uid}/
//   settings                          ← DOCUMENT: static config only
//   transactions/{id}                 ← SUBCOLLECTION
//   assets/{id}                       ← SUBCOLLECTION
//   liabilities/{id}                  ← SUBCOLLECTION
//   banks/{id}                        ← SUBCOLLECTION
//   emis/{id}                         ← SUBCOLLECTION
//   goals/{id}                        ← SUBCOLLECTION
//   goalAccounts/{id}                 ← SUBCOLLECTION
//   budgets/{id}                      ← SUBCOLLECTION
//   scheduledPayments/{id}            ← SUBCOLLECTION
//   needsWants/{id}                   ← SUBCOLLECTION
//   portfolioHoldings/{id}            ← SUBCOLLECTION
//   foTrades/{id}                     ← SUBCOLLECTION
//   snapshots/{id}                    ← SUBCOLLECTION
//   businessData/{id}                 ← SUBCOLLECTION
//   projectsData/{id}                 ← SUBCOLLECTION
//   pfContributions/{id}              ← SUBCOLLECTION
//   pfWithdrawals/{id}                ← SUBCOLLECTION
//
// Settings document stores:
//   profile, categories, featureToggles, brokerProfiles,
//   lotSizes, customInstruments, foCharges, liabilityTypes,
//   projectTaskTypes, navOrder, gdriveIntegration, needsWantsConfig

// ── Which keys are subcollections ────────────────────────────────────────────
// Each key maps to its Firestore subcollection name
const SUBCOLLECTIONS = {
  transactions:      "transactions",
  assets:            "assets",
  liabilities:       "liabilities",
  banks:             "banks",
  emis:              "emis",
  goals:             "goals",
  goalAccounts:      "goalAccounts",
  budgets:           "budgets",
  scheduledPayments: "scheduledPayments",
  needsWants:        "needsWants",
  portfolioHoldings: "portfolioHoldings",
  foTrades:          "foTrades",
  snapshots:         "snapshots",
  businessData:      "businessData",
  projectsData:      "projectsData",
};

// pfAccount is special — split into two subcollections
const PF_CONTRIBUTIONS = "pfContributions";
const PF_WITHDRAWALS   = "pfWithdrawals";

// ── Helpers ───────────────────────────────────────────────────────────────────
const settingsRef = (uid) => doc(db, "users", uid, "fintrack", "settings");
const subRef      = (uid, sub) => collection(db, "users", uid, sub);

function cleanData(obj) {
  return JSON.parse(JSON.stringify(obj, (_, val) => val === undefined ? null : val));
}

// Generate a stable string ID from a number or use existing string id
function toDocId(item) {
  if (item.id !== undefined && item.id !== null) {
    return String(item.id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  }
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Read all docs from a subcollection → returns array ───────────────────────
async function readSubcollection(uid, subName) {
  try {
    const snap = await getDocs(subRef(uid, subName));
    return snap.docs.map(d => d.data());
  } catch (e) {
    console.error(`[firestore] Error reading ${subName}:`, e);
    return [];
  }
}

// ── Write an array to a subcollection (batch, overwrites all) ────────────────
async function writeSubcollection(uid, subName, items) {
  if (!Array.isArray(items) || items.length === 0) return;

  // Firestore batch limit is 500 ops
  const BATCH_SIZE = 400;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    const chunk = items.slice(i, i + BATCH_SIZE);
    chunk.forEach(item => {
      const id  = toDocId(item);
      const ref = doc(db, "users", uid, subName, id);
      batch.set(ref, cleanData(item), { merge: true });
    });
    await batch.commit();
  }
}

// ── Delete all docs in a subcollection then rewrite ──────────────────────────
async function replaceSubcollection(uid, subName, items) {
  // Delete existing docs
  const snap = await getDocs(subRef(uid, subName));
  if (!snap.empty) {
    const BATCH_SIZE = 400;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      docs.slice(i, i + BATCH_SIZE).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }
  // Write new docs
  if (Array.isArray(items) && items.length > 0) {
    await writeSubcollection(uid, subName, items);
  }
}

// ── Sync an array to a subcollection (upsert current + delete removed) ───────
// This is what saveToFirestore uses. Unlike writeSubcollection (which only
// adds/updates and can never remove), this reconciles deletions: any doc that
// exists in Firestore but is NOT in `items` is deleted. This fixes the bug
// where deleted scheduled payments / transactions reappeared after reload.
async function syncSubcollection(uid, subName, items) {
  if (!Array.isArray(items)) return;
  const wantIds = new Set(items.map(toDocId));

  // Read existing docs so we know which ones were removed in the app state.
  let existingDocs = [];
  try {
    const snap = await getDocs(subRef(uid, subName));
    existingDocs = snap.docs;
  } catch (e) {
    console.error(`[firestore] Sync read error in ${subName}:`, e);
    return; // bail out rather than risk a partial/destructive write
  }

  // Build the op list: delete removed docs, upsert current items.
  const ops = [];
  existingDocs.forEach(d => {
    if (!wantIds.has(d.id)) ops.push({ type: "delete", ref: d.ref });
  });
  items.forEach(item => {
    const id  = toDocId(item);
    const ref = doc(db, "users", uid, subName, id);
    ops.push({ type: "set", ref, data: cleanData(item) });
  });

  if (ops.length === 0) return;

  // Commit in batches (Firestore limit is 500 ops/batch).
  const BATCH_SIZE = 400;
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    ops.slice(i, i + BATCH_SIZE).forEach(op => {
      if (op.type === "delete") batch.delete(op.ref);
      else                       batch.set(op.ref, op.data, { merge: true });
    });
    await batch.commit();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// loadFromFirestore — reads settings doc + all subcollections
// ══════════════════════════════════════════════════════════════════════════════
export async function loadFromFirestore(uid, fallback) {
  try {
    // ── 1. Read settings document ──────────────────────────────────────────
    const settingsSnap = await getDoc(settingsRef(uid));
    const settings     = settingsSnap.exists() ? settingsSnap.data() : {};

    // ── 2. Check if this is an old-format user (single doc) ───────────────
    // Old format stored data at: users/{uid}/fintrack/data
    const oldRef  = doc(db, "users", uid, "fintrack", "data");
    const oldSnap = await getDoc(oldRef);

    if (oldSnap.exists() && !settingsSnap.exists()) {
      // First load after migration — migrate old data to new structure
      console.log("[firestore] Old format detected — migrating to subcollections...");
      const oldData = oldSnap.data();
      await migrateOldFormat(uid, oldData);
      // Delete old doc after migration
      await deleteDoc(oldRef);
      console.log("[firestore] Migration complete ✅");
      // Now load the freshly migrated data
      return await loadFromFirestore(uid, fallback);
    }

    // ── 3. Read all subcollections in parallel ─────────────────────────────
    const [
      transactions,
      assets,
      liabilities,
      banks,
      emis,
      goals,
      goalAccounts,
      budgets,
      scheduledPayments,
      needsWants,
      portfolioHoldings,
      foTrades,
      snapshots,
      businessData,
      projectsData,
      pfContributions,
      pfWithdrawals,
    ] = await Promise.all([
      readSubcollection(uid, "transactions"),
      readSubcollection(uid, "assets"),
      readSubcollection(uid, "liabilities"),
      readSubcollection(uid, "banks"),
      readSubcollection(uid, "emis"),
      readSubcollection(uid, "goals"),
      readSubcollection(uid, "goalAccounts"),
      readSubcollection(uid, "budgets"),
      readSubcollection(uid, "scheduledPayments"),
      readSubcollection(uid, "needsWants"),
      readSubcollection(uid, "portfolioHoldings"),
      readSubcollection(uid, "foTrades"),
      readSubcollection(uid, "snapshots"),
      readSubcollection(uid, "businessData"),
      readSubcollection(uid, "projectsData"),
      readSubcollection(uid, "pfContributions"),
      readSubcollection(uid, "pfWithdrawals"),
    ]);

    // ── 4. Assemble full app state ─────────────────────────────────────────
    return {
      ...fallback,
      ...settings,
      transactions,
      assets,
      liabilities,
      banks,
      emis,
      goals,
      goalAccounts,
      budgets,
      scheduledPayments,
      needsWants,
      portfolioHoldings,
      foTrades,
      snapshots,
      businessData,
      projectsData,
      pfAccount: {
        contributions: pfContributions,
        withdrawals:   pfWithdrawals,
      },
    };
  } catch (e) {
    console.error("[firestore] Load error:", e);
    return fallback;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// saveToFirestore — writes settings doc + changed subcollections
// ══════════════════════════════════════════════════════════════════════════════
export async function saveToFirestore(uid, data) {
  try {
    // ── 1. Split data into settings vs subcollections ──────────────────────
    const {
      // subcollection fields — extracted out
      transactions,
      assets,
      liabilities,
      banks,
      emis,
      goals,
      goalAccounts,
      budgets,
      scheduledPayments,
      needsWants,
      portfolioHoldings,
      foTrades,
      snapshots,
      businessData,
      projectsData,
      pfAccount,
      // non-persisted fields
      user,
      // everything else goes to settings doc
      ...settingsData
    } = data;

    // ── 2. Write settings document (merge: true) ───────────────────────────
    await setDoc(settingsRef(uid), cleanData(settingsData), { merge: true });

    // ── 3. Write subcollections in parallel ───────────────────────────────
    await Promise.all([
      syncSubcollection(uid,  "transactions",      transactions      || []),
      syncSubcollection(uid,  "assets",            assets            || []),
      syncSubcollection(uid,  "liabilities",       liabilities       || []),
      syncSubcollection(uid,  "banks",             banks             || []),
      syncSubcollection(uid,  "emis",              emis              || []),
      syncSubcollection(uid,  "goals",             goals             || []),
      syncSubcollection(uid,  "goalAccounts",      goalAccounts      || []),
      syncSubcollection(uid,  "budgets",           budgets           || []),
      syncSubcollection(uid,  "scheduledPayments", scheduledPayments || []),
      syncSubcollection(uid,  "needsWants",        needsWants        || []),
      syncSubcollection(uid,  "portfolioHoldings", portfolioHoldings || []),
      syncSubcollection(uid,  "foTrades",          foTrades          || []),
      syncSubcollection(uid,  "snapshots",         snapshots         || []),
      syncSubcollection(uid,  "businessData",      businessData      || []),
      syncSubcollection(uid,  "projectsData",      projectsData      || []),
      syncSubcollection(uid,  "pfContributions",   pfAccount?.contributions || []),
      syncSubcollection(uid,  "pfWithdrawals",     pfAccount?.withdrawals   || []),
    ]);
  } catch (e) {
    console.error("[firestore] Save error:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// saveSettingsToFirestore — lightweight save for settings-only changes
// Use this when only non-array config changes (featureToggles, profile, etc.)
// ══════════════════════════════════════════════════════════════════════════════
export async function saveSettingsToFirestore(uid, data) {
  try {
    const {
      transactions, assets, liabilities, banks, emis, goals, goalAccounts,
      budgets, scheduledPayments, needsWants, portfolioHoldings, foTrades,
      snapshots, businessData, projectsData, pfAccount, user,
      ...settingsData
    } = data;
    await setDoc(settingsRef(uid), cleanData(settingsData), { merge: true });
  } catch (e) {
    console.error("[firestore] Settings save error:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// saveSubcollectionItem — save/update a single item in a subcollection
// Use for adding/editing one transaction, one asset, etc. — much faster
// than rewriting the entire subcollection
// ══════════════════════════════════════════════════════════════════════════════
export async function saveSubcollectionItem(uid, subName, item) {
  try {
    const id  = toDocId(item);
    const ref = doc(db, "users", uid, subName, id);
    await setDoc(ref, cleanData(item), { merge: true });
  } catch (e) {
    console.error(`[firestore] Save item error in ${subName}:`, e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// deleteSubcollectionItem — delete a single item from a subcollection
// ══════════════════════════════════════════════════════════════════════════════
export async function deleteSubcollectionItem(uid, subName, item) {
  try {
    const id  = toDocId(item);
    const ref = doc(db, "users", uid, subName, id);
    await deleteDoc(ref);
  } catch (e) {
    console.error(`[firestore] Delete item error in ${subName}:`, e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// migrateOldFormat — one-time migration from single doc to subcollections
// Called automatically on first load if old format is detected
// ══════════════════════════════════════════════════════════════════════════════
async function migrateOldFormat(uid, oldData) {
  const {
    transactions, assets, liabilities, banks, emis, goals, goalAccounts,
    budgets, scheduledPayments, needsWants, portfolioHoldings, foTrades,
    snapshots, businessData, projectsData, pfAccount,
    user,
    ...settingsData
  } = oldData;

  // Write settings doc
  await setDoc(settingsRef(uid), cleanData(settingsData), { merge: true });

  // Write all subcollections
  await Promise.all([
    writeSubcollection(uid, "transactions",      transactions      || []),
    writeSubcollection(uid, "assets",            assets            || []),
    writeSubcollection(uid, "liabilities",       liabilities       || []),
    writeSubcollection(uid, "banks",             banks             || []),
    writeSubcollection(uid, "emis",              emis              || []),
    writeSubcollection(uid, "goals",             goals             || []),
    writeSubcollection(uid, "goalAccounts",      goalAccounts      || []),
    writeSubcollection(uid, "budgets",           budgets           || []),
    writeSubcollection(uid, "scheduledPayments", scheduledPayments || []),
    writeSubcollection(uid, "needsWants",        needsWants        || []),
    writeSubcollection(uid, "portfolioHoldings", portfolioHoldings || []),
    writeSubcollection(uid, "foTrades",          foTrades          || []),
    writeSubcollection(uid, "snapshots",         snapshots         || []),
    writeSubcollection(uid, "businessData",      businessData      || []),
    writeSubcollection(uid, "projectsData",      projectsData      || []),
    writeSubcollection(uid, "pfContributions",   pfAccount?.contributions || []),
    writeSubcollection(uid, "pfWithdrawals",     pfAccount?.withdrawals   || []),
  ]);
}

// ══════════════════════════════════════════════════════════════════════════════
// replaceAllSubcollections — used during import/restore
// Completely replaces all subcollections with new data
// ══════════════════════════════════════════════════════════════════════════════
export async function replaceAllData(uid, data) {
  try {
    const {
      transactions, assets, liabilities, banks, emis, goals, goalAccounts,
      budgets, scheduledPayments, needsWants, portfolioHoldings, foTrades,
      snapshots, businessData, projectsData, pfAccount,
      user,
      ...settingsData
    } = data;

    // Settings doc — full overwrite
    await setDoc(settingsRef(uid), cleanData(settingsData));

    // Subcollections — delete all then rewrite
    await Promise.all([
      replaceSubcollection(uid, "transactions",      transactions      || []),
      replaceSubcollection(uid, "assets",            assets            || []),
      replaceSubcollection(uid, "liabilities",       liabilities       || []),
      replaceSubcollection(uid, "banks",             banks             || []),
      replaceSubcollection(uid, "emis",              emis              || []),
      replaceSubcollection(uid, "goals",             goals             || []),
      replaceSubcollection(uid, "goalAccounts",      goalAccounts      || []),
      replaceSubcollection(uid, "budgets",           budgets           || []),
      replaceSubcollection(uid, "scheduledPayments", scheduledPayments || []),
      replaceSubcollection(uid, "needsWants",        needsWants        || []),
      replaceSubcollection(uid, "portfolioHoldings", portfolioHoldings || []),
      replaceSubcollection(uid, "foTrades",          foTrades          || []),
      replaceSubcollection(uid, "snapshots",         snapshots         || []),
      replaceSubcollection(uid, "businessData",      businessData      || []),
      replaceSubcollection(uid, "projectsData",      projectsData      || []),
      replaceSubcollection(uid, "pfContributions",   pfAccount?.contributions || []),
      replaceSubcollection(uid, "pfWithdrawals",     pfAccount?.withdrawals   || []),
    ]);
  } catch (e) {
    console.error("[firestore] Replace all error:", e);
  }
}
