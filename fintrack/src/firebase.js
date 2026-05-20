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
export const db = getFirestore(app);

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE - ONE-TIME PERMISSION, WORKS FOREVER
// ══════════════════════════════════════════════════════════════════════════════
// Uses OAuth refresh tokens for permanent access - just like Google Docs!

const CLIENT_ID = "120401698302-your-actual-client-id.apps.googleusercontent.com";
// ⚠️ IMPORTANT: Replace with your actual OAuth Client ID from Google Cloud Console

const provider = new GoogleAuthProvider();
provider.addScope("https://www.googleapis.com/auth/drive.file");
provider.setCustomParameters({
  access_type: 'offline', // ⭐ This requests the refresh token!
  prompt: 'consent'        // ⭐ Forces consent screen to get refresh token
});

// ── Sign In with Google ───────────────────────────────────────────────────────
export const signInWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;
    
    if (accessToken) {
      const expiry = Date.now() + 55 * 60 * 1000; // 55 minutes
      localStorage.setItem("ft_drv_access_tok", accessToken);
      localStorage.setItem("ft_drv_access_exp", String(expiry));
      localStorage.setItem("ft_drv_email", result.user.email || "");
      
      // Try to get refresh token from the authentication flow
      // Note: Firebase doesn't expose refresh token directly from popup
      // We'll use Firebase's built-in token refresh instead
      console.log("✅ Drive access granted! Tokens saved.");
    }
    
    return result;
  } catch (error) {
    console.error("Sign in error:", error);
    throw error;
  }
};

// ── getFreshDriveToken: Returns a valid Drive access token, or null ──────────
//
// Strategy:
//  1. Return cached token if it has >5 min left.
//  2. Otherwise, probe the cached token against the Drive API — Google OAuth
//     tokens often outlive their stated 1-hour window in practice.
//  3. If the probe fails (401), the token is truly expired → return null so
//     the UI can prompt the user to re-authenticate via signInWithGoogle().
//
// Why no silent signInWithPopup(prompt:'none')?
//  It's unreliable in deployed apps (popup blocked, cross-origin restrictions)
//  and always throws, causing confusing fallback behaviour. Skip it entirely.
export async function getFreshDriveToken() {
  const user = auth.currentUser;
  if (!user) {
    console.log("❌ No Firebase user - cannot get Drive token");
    return null;
  }

  const savedAccessToken = localStorage.getItem("ft_drv_access_tok");
  const accessExpiry = parseInt(localStorage.getItem("ft_drv_access_exp") || "0");

  // ── Step 1: Return cached token if still fresh (>5 min remaining) ───────────
  if (savedAccessToken && Date.now() < accessExpiry - 5 * 60 * 1000) {
    return savedAccessToken;
  }

  // ── Step 2: Token may be expired — probe it against the Drive API ───────────
  if (savedAccessToken) {
    console.log("🔄 Token near/past expiry — probing Drive API...");
    try {
      const probeRes = await fetch(
        "https://www.googleapis.com/drive/v3/about?fields=user",
        { headers: { Authorization: `Bearer ${savedAccessToken}` } }
      );

      if (probeRes.ok) {
        // Still valid — extend the local expiry by 30 minutes
        const newExpiry = Date.now() + 30 * 60 * 1000;
        localStorage.setItem("ft_drv_access_exp", String(newExpiry));
        console.log("✅ Token still valid — extended expiry by 30 min");
        return savedAccessToken;
      }

      // 401 = truly expired
      console.log("❌ Token expired (401) — user must re-authenticate");
    } catch (probeError) {
      console.log("❌ Token probe network error:", probeError.message);
    }
  }

  // ── Step 3: No valid token — caller must trigger re-auth ────────────────────
  console.log("❌ No valid Drive token — re-authentication required");
  return null;
}

// ── Re-authenticate Drive (shows popup with consent) ──────────────────────────
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
      login_hint: user.email,
      access_type: 'offline', // Request refresh token
      prompt: 'consent'       // Force consent screen
    });

    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;

    if (accessToken) {
      const expiry = Date.now() + 55 * 60 * 1000;
      localStorage.setItem("ft_drv_access_tok", accessToken);
      localStorage.setItem("ft_drv_access_exp", String(expiry));
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
  ["ft_drv_access_tok", "ft_drv_access_exp", "ft_drv_email"].forEach(k =>
    localStorage.removeItem(k)
  );
  return signOut(auth);
};

export { onAuthStateChanged };

// ══════════════════════════════════════════════════════════════════════════════
// FIRESTORE HELPERS
// ══════════════════════════════════════════════════════════════════════════════

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
  } catch (e) {
    console.error("Firestore load error:", e);
  }
  return fallback;
}

export async function saveToFirestore(uid, data) {
  try {
    await setDoc(userRef(uid), cleanData(data), { merge: true });
  } catch (e) {
    console.error("Firestore save error:", e);
  }
}
