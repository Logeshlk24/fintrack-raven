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

// Google provider with Drive scope — popup happens once ever at sign-in
const provider = new GoogleAuthProvider();
provider.addScope("https://www.googleapis.com/auth/drive.file");

// ── Sign In ───────────────────────────────────────────────────────────────────
export const signInWithGoogle = async () => {
  const result      = await signInWithPopup(auth, provider);
  const credential  = GoogleAuthProvider.credentialFromResult(result);
  const accessToken = credential?.accessToken;
  if (accessToken) {
    const expiry = Date.now() + (3600 - 120) * 1000;
    localStorage.setItem("ft_drv_tok",   accessToken);
    localStorage.setItem("ft_drv_exp",   String(expiry));
    localStorage.setItem("ft_drv_email", result.user.email || "");
  }
  return result;
};

// ── getFreshDriveToken ─────────────────────────────────────────────────────────
// Uses Firebase's own refresh_token via securetoken endpoint to get a fresh
// Google access_token (with Drive scope) — zero popup, zero GIS, zero Client ID.
// Works as long as the user is signed into Google via Firebase.
export async function getFreshDriveToken() {
  try {
    const user = auth.currentUser;
    if (!user) return null;

    // Force Firebase to refresh its internal session
    await user.getIdToken(true);

    // Access Firebase's stored refresh_token
    const refreshToken = user.stsTokenManager?.refreshToken
      || user._delegate?.stsTokenManager?.refreshToken;

    if (!refreshToken) {
      // Fallback: return saved token if still valid
      const saved  = localStorage.getItem("ft_drv_tok");
      const expiry = parseInt(localStorage.getItem("ft_drv_exp") || "0");
      return (saved && Date.now() < expiry) ? saved : null;
    }

    // Exchange Firebase refresh_token for a fresh Google access_token
    const res = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${firebaseConfig.apiKey}`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
      }
    );

    if (!res.ok) {
      const saved  = localStorage.getItem("ft_drv_tok");
      const expiry = parseInt(localStorage.getItem("ft_drv_exp") || "0");
      return (saved && Date.now() < expiry) ? saved : null;
    }

    const json        = await res.json();
    const accessToken = json.access_token;
    const expiresIn   = parseInt(json.expires_in || "3600");

    if (accessToken) {
      localStorage.setItem("ft_drv_tok", accessToken);
      localStorage.setItem("ft_drv_exp", String(Date.now() + (expiresIn - 120) * 1000));
    }

    return accessToken || null;
  } catch (e) {
    console.warn("getFreshDriveToken:", e);
    const saved  = localStorage.getItem("ft_drv_tok");
    const expiry = parseInt(localStorage.getItem("ft_drv_exp") || "0");
    return (saved && Date.now() < expiry) ? saved : null;
  }
}

// ── Sign Out ──────────────────────────────────────────────────────────────────
export const signOutUser = () => {
  ["ft_drv_tok", "ft_drv_exp", "ft_drv_email"].forEach(k =>
    localStorage.removeItem(k)
  );
  return signOut(auth);
};

export { onAuthStateChanged };

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
