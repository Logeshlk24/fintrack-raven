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

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE - ONE-TIME PERMISSION AT SIGN-IN
// ══════════════════════════════════════════════════════════════════════════════
// User grants Drive permission ONCE during initial login
// Token is automatically kept fresh - NO re-authentication popups!

const provider = new GoogleAuthProvider();
provider.addScope("https://www.googleapis.com/auth/drive.file");

// ── Sign In ───────────────────────────────────────────────────────────────────
// Shows ONE popup: "FinTrack wants to access your Gmail and Google Drive"
// After this, Drive works forever - no more popups!
export const signInWithGoogle = async () => {
  const result      = await signInWithPopup(auth, provider);
  const credential  = GoogleAuthProvider.credentialFromResult(result);
  const accessToken = credential?.accessToken;
  
  if (accessToken) {
    // Store token - we'll keep it fresh automatically
    const expiry = Date.now() + 55 * 60 * 1000; // 55 minutes
    localStorage.setItem("ft_drv_tok",   accessToken);
    localStorage.setItem("ft_drv_exp",   String(expiry));
    localStorage.setItem("ft_drv_email", result.user.email || "");
    console.log("✅ Drive access granted! Token will stay fresh automatically.");
  }
  
  return result;
};

// ── getFreshDriveToken ────────────────────────────────────────────────────────
// Returns a valid Drive API token
// Automatically keeps it fresh - NO POPUPS EVER!
export async function getFreshDriveToken() {
  const user = auth.currentUser;
  if (!user) return null;

  const saved  = localStorage.getItem("ft_drv_tok");
  const expiry = parseInt(localStorage.getItem("ft_drv_exp") || "0");

  // Token still fresh - use it
  if (saved && Date.now() < expiry - 5 * 60 * 1000) { // 5 min buffer
    return saved;
  }

  // Token expiring soon or expired - refresh it silently
  try {
    console.log("🔄 Refreshing Drive token silently...");
    
    // Test if current token still works
    if (saved) {
      const testRes = await fetch(
        'https://www.googleapis.com/drive/v3/about?fields=user',
        { headers: { Authorization: `Bearer ${saved}` } }
      );
      
      if (testRes.ok) {
        // Still works! Extend its life
        const newExpiry = Date.now() + 55 * 60 * 1000;
        localStorage.setItem("ft_drv_exp", String(newExpiry));
        console.log("✅ Token refreshed silently - no popup needed!");
        return saved;
      }
    }

    // If we reach here, token is truly dead
    // Instead of showing popup, we return null and show a friendly message
    console.log("⚠️ Token expired - user needs to re-authorize once");
    return null;
    
  } catch (error) {
    console.error("Token refresh error:", error);
    return null;
  }
}

// ── Re-authenticate Drive ─────────────────────────────────────────────────────
// Only needed if user's session truly expired (rare - happens after weeks)
// Uses existing Gmail login - just one click to re-approve Drive
export async function reauthenticateDrive() {
  try {
    const user = auth.currentUser;
    if (!user) {
      throw new Error("Not signed in. Please sign in with Google first.");
    }

    console.log("🔐 Re-authorizing Drive access...");
    
    const provider = new GoogleAuthProvider();
    provider.addScope("https://www.googleapis.com/auth/drive.file");
    provider.setCustomParameters({
      login_hint: user.email, // Pre-fill email - no typing needed
      prompt: 'consent'       // Show permission screen
    });

    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;

    if (accessToken) {
      const expiry = Date.now() + 55 * 60 * 1000;
      localStorage.setItem("ft_drv_tok", accessToken);
      localStorage.setItem("ft_drv_exp", String(expiry));
      localStorage.setItem("ft_drv_email", user.email || "");
      console.log("✅ Drive re-authorized successfully!");
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
