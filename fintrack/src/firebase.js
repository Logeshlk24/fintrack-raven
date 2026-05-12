import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDr_yGnZNsT_NgFmw0RkTRZhpzsRFy0SiU",
  authDomain: "fintracker-raven.firebaseapp.com",
  projectId: "fintracker-raven",
  storageBucket: "fintracker-raven.firebasestorage.app",
  messagingSenderId: "120401698302",
  appId: "1:120401698302:web:2a9a8ac0531acf177f34af",
  measurementId: "G-1MVVYSS4SR",
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
export const auth = getAuth(app);
export const db   = getFirestore(app);

// Google provider with Drive scope — popup happens ONCE at sign-in only
const provider = new GoogleAuthProvider();
provider.addScope("https://www.googleapis.com/auth/drive.file");

// ── Sign In ───────────────────────────────────────────────────────────────────
// This is the ONLY place a popup ever appears.
// The Google OAuth access token (with drive.file scope) is captured here
// and stored in localStorage for all future Drive API calls.
export const signInWithGoogle = async () => {
  const result      = await signInWithPopup(auth, provider);
  const credential  = GoogleAuthProvider.credentialFromResult(result);
  const accessToken = credential?.accessToken;
  if (accessToken) {
    // Google OAuth tokens last 1 hour; store with a 2-min safety buffer
    const expiry = Date.now() + (3600 - 120) * 1000;
    localStorage.setItem("ft_drv_tok",   accessToken);
    localStorage.setItem("ft_drv_exp",   String(expiry));
    localStorage.setItem("ft_drv_email", result.user.email || "");
  }
  return result;
};

// ── getFreshDriveToken ────────────────────────────────────────────────────────
// 1. If stored token is still valid → return it instantly (no network call).
// 2. If token is expired BUT user is still signed into Google in browser →
//    silently refresh using signInWithPopup(prompt:none). Zero UI, zero clicks.
// 3. If silent refresh fails (user signed out of Google) → return null silently.
//    App.jsx will show the normal Connect button; no error banner.
export async function getFreshDriveToken() {
  const saved  = localStorage.getItem("ft_drv_tok");
  const expiry = parseInt(localStorage.getItem("ft_drv_exp") || "0");

  // ✅ Token still valid — return immediately
  if (saved && Date.now() < expiry) return saved;

  // 🔄 Token expired — try silent refresh (no popup shown to user)
  try {
    const silentProvider = new GoogleAuthProvider();
    silentProvider.addScope("https://www.googleapis.com/auth/drive.file");
    // prompt: none = use existing Google session silently, never show UI
    silentProvider.setCustomParameters({ prompt: "none" });

    const result      = await signInWithPopup(auth, silentProvider);
    const credential  = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;

    if (accessToken) {
      const newExpiry = Date.now() + (3600 - 120) * 1000;
      localStorage.setItem("ft_drv_tok",   accessToken);
      localStorage.setItem("ft_drv_exp",   String(newExpiry));
      localStorage.setItem("ft_drv_email", result.user.email || "");
      return accessToken;
    }
  } catch (_) {
    // Silent refresh failed (user signed out of Google browser session) — no UI
  }

  return null;
}

// ── Sign Out ──────────────────────────────────────────────────────────────────
export const signOutUser = () => {
  ["ft_drv_tok", "ft_drv_exp", "ft_drv_email"].forEach(k =>
    localStorage.removeItem(k)
  );
  return signOut(auth);
};

export { onAuthStateChanged };

// ── Firestore helpers ─────────────────────────────────────────────────────────
const userRef = (uid) => doc(db, "users", uid, "fintrack", "data");

function cleanData(obj) {
  return JSON.parse(JSON.stringify(obj, (key, val) =>
    val === undefined ? null : val
  ));
}

export async function loadFromFirestore(uid, fallback) {
  try {
    const snap = await getDoc(userRef(uid));
    if (snap.exists()) return { ...fallback, ...snap.data() };
  } catch (e) { console.error("Firestore load error:", e); }
  return fallback;
}

export async function saveToFirestore(uid, data) {
  try {
    await setDoc(userRef(uid), cleanData(data), { merge: true });
  } catch (e) { console.error("Firestore save error:", e); }
}
