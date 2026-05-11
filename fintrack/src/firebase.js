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
// Returns the stored Google OAuth access token (with drive.file scope) that was
// captured at sign-in via GoogleAuthProvider.credentialFromResult().
// If expired or missing, triggers a re-auth popup to get a fresh token.
// NOTE: The securetoken endpoint only issues Firebase ID tokens — NOT Google OAuth
// access tokens — so it cannot be used to call Google Drive APIs.
export async function getFreshDriveToken() {
  const saved  = localStorage.getItem("ft_drv_tok");
  const expiry = parseInt(localStorage.getItem("ft_drv_exp") || "0");

  // Token still valid — return immediately, no popup needed
  if (saved && Date.now() < expiry) return saved;

  // Token expired or missing — re-auth with same provider+scope to get fresh token
  try {
    const user = auth.currentUser;
    if (!user) return null;

    const result     = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const token      = credential?.accessToken;

    if (token) {
      localStorage.setItem("ft_drv_tok", token);
      localStorage.setItem("ft_drv_exp", String(Date.now() + (3600 - 120) * 1000));
    }
    return token || null;
  } catch (e) {
    console.warn("getFreshDriveToken re-auth failed:", e);
    return null;
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
