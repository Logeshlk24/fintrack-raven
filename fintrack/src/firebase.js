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
//
// Flow:
//   1. signInWithGoogle() → redirects to /api/auth/google
//   2. /api/auth/google   → redirects to Google consent page
//   3. Google             → redirects to /api/auth/callback?code=...
//   4. /api/auth/callback → exchanges code for tokens
//                        → stores refresh_token encrypted in Firestore (server only)
//                        → creates Firebase custom token
//                        → redirects to app?custom_token=...
//   5. App picks up ?custom_token from URL → signInWithCustomToken()
//   6. Firebase auth is established. Refresh token NEVER in browser.
//
//   Any Drive API call → getFreshDriveToken()
//                     → POST /api/drive-token { action:"refresh", idToken }
//                     → server decrypts refresh token → returns fresh access token
//                     → stored in memory only (_cachedAccessToken)
//                     → no expiry UX — server refreshes silently forever
//
// The refresh token NEVER leaves the server. Ever.

// ── In-memory access token cache (no localStorage, no sessionStorage) ────────
let _cachedAccessToken = null;
let _tokenExpiresAt    = 0; // epoch ms

// ── signInWithGoogle — redirects to OAuth flow ───────────────────────────────
// This replaces the old signInWithPopup approach entirely.
export function signInWithGoogle() {
  // Full page redirect to our serverless OAuth initiator
  window.location.href = "/api/auth/google";
}

// ── handleAuthCallback — call this on app load to complete sign-in ───────────
// Checks URL for ?custom_token= param, signs into Firebase, cleans URL.
// Returns true if a token was found and used, false otherwise.
export async function handleAuthCallback() {
  const params      = new URLSearchParams(window.location.search);
  const customToken = params.get("custom_token");
  const authError   = params.get("auth_error");

  // Clean up URL params regardless
  if (customToken || authError) {
    const clean = window.location.pathname;
    window.history.replaceState({}, "", clean);
  }

  if (authError) {
    console.error("[auth] OAuth error from callback:", authError);
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

// ── getFreshDriveToken — returns a valid Drive access token ──────────────────
// 1. Returns cached in-memory token if still fresh (>5 min left)
// 2. Calls /api/drive-token to get a fresh token from the server
// 3. Returns null if server has no refresh token (user must sign in again)
//
// NO localStorage. NO sessionStorage. Token lives only in this module variable.
export async function getFreshDriveToken() {
  const user = auth.currentUser;
  if (!user) {
    console.log("[drive] No Firebase user — cannot get Drive token");
    return null;
  }

  // ── Step 1: Return cached token if fresh ────────────────────────────────────
  if (_cachedAccessToken && Date.now() < _tokenExpiresAt - 5 * 60 * 1000) {
    return _cachedAccessToken;
  }

  // ── Step 2: Ask server for a fresh access token ──────────────────────────────
  try {
    console.log("[drive] Requesting fresh token from server...");
    // Firebase ID token proves to our server that the caller is the real user
    const idToken = await user.getIdToken();

    const res = await fetch("/api/drive-token", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action: "refresh", idToken }),
    });

    if (res.status === 404) {
      // No refresh token on server — user needs to sign in again
      console.log("[drive] No refresh token on server — re-auth needed");
      _cachedAccessToken = null;
      _tokenExpiresAt    = 0;
      return null;
    }

    if (res.status === 401) {
      // Token was revoked
      console.log("[drive] Refresh token revoked — re-auth needed");
      _cachedAccessToken = null;
      _tokenExpiresAt    = 0;
      return null;
    }

    if (!res.ok) {
      console.error("[drive] Server error:", res.status);
      return null;
    }

    const { accessToken, expiresIn } = await res.json();
    // Store in memory only — persists across tab navigations via server
    _cachedAccessToken = accessToken;
    _tokenExpiresAt    = Date.now() + (expiresIn - 60) * 1000; // 1 min buffer
    console.log("[drive] Fresh access token received from server ✅");
    return accessToken;

  } catch (err) {
    console.error("[drive] Token fetch error:", err.message);
    return null;
  }
}

// ── clearDriveToken — call when user disconnects Drive from Settings ──────────
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

// ── signOutUser ───────────────────────────────────────────────────────────────
export const signOutUser = () => {
  _cachedAccessToken = null;
  _tokenExpiresAt    = 0;
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
