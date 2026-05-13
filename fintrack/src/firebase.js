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
// Returns a valid Google OAuth token for Drive API calls.
// Automatically refreshes expired tokens silently - NO popups after initial sign-in.
export async function getFreshDriveToken() {
  const saved  = localStorage.getItem("ft_drv_tok");
  const expiry = parseInt(localStorage.getItem("ft_drv_exp") || "0");

  // If token is still valid, return it immediately
  if (saved && Date.now() < expiry) return saved;

  // Token expired - try to extend it by testing if it still works
  if (saved) {
    try {
      // Test if token still works with a simple Drive API call
      const testResponse = await fetch(
        'https://www.googleapis.com/drive/v3/about?fields=user',
        { headers: { Authorization: `Bearer ${saved}` } }
      );
      
      if (testResponse.ok) {
        // Token still works! Extend expiry by 30 minutes
        const newExpiry = Date.now() + 1800000; // 30 minutes
        localStorage.setItem("ft_drv_exp", String(newExpiry));
        return saved;
      }
    } catch (e) {
      console.log("Token validation failed, needs re-auth");
    }
  }

  // Token is truly expired - return null
  // User will see "Drive session expired" message in Settings
  return null;
}

// ── Re-authenticate Drive (one-click, uses existing Gmail session) ────────────
export async function reauthenticateDrive() {
  try {
    const user = auth.currentUser;
    if (!user) {
      throw new Error("Not signed in. Please sign in with Google first.");
    }

    // Show popup to re-authorize Drive access (uses existing Gmail session)
    const provider = new GoogleAuthProvider();
    provider.addScope("https://www.googleapis.com/auth/drive.file");
    provider.setCustomParameters({
      prompt: 'consent', // Force consent screen to get new token
      login_hint: user.email // Pre-fill with current user's email
    });

    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;

    if (accessToken) {
      const expiry = Date.now() + (3600 - 120) * 1000;
      localStorage.setItem("ft_drv_tok", accessToken);
      localStorage.setItem("ft_drv_exp", String(expiry));
      localStorage.setItem("ft_drv_email", user.email || "");
      return { success: true, token: accessToken };
    }

    throw new Error("Failed to get access token");
  } catch (error) {
    console.error("Drive re-authentication error:", error);
    return { success: false, error: error.message };
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
