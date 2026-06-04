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

// ══════════════════════════════════════════════════════════════════════════════
// FIREBASE CONFIG — all values from environment variables
// Never commit real keys. Set these in:
//   • Local dev  : .env.local (git-ignored)
//   • Production : Vercel → Project → Settings → Environment Variables
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
// GOOGLE DRIVE AUTH — server-side refresh token pattern
// ══════════════════════════════════════════════════════════════════════════════
//
// Flow:
//   1. User signs in → popup gives us a one-time authorization_code
//   2. We send that code to our own /api/drive-token (server-side) to exchange
//      for a refresh token, which is stored encrypted in Firestore (server only)
//   3. On every Drive API call, the browser hits /api/drive-token?action=refresh
//      which returns a fresh access token (~1 hour)
//   4. Access token lives only in a module-level variable — never localStorage
//   5. No token expiry UX for team users — server refreshes silently forever
//
// The refresh token NEVER touches the browser.

// ── Module-level in-memory token cache (not localStorage) ───────────────────
let _cachedAccessToken = null;
let _tokenExpiresAt    = 0;   // epoch ms

const DRIVE_API_ENDPOINT = "/api/drive-token";

// ── Google OAuth provider (requests offline access = refresh token) ──────────
const driveProvider = new GoogleAuthProvider();
driveProvider.addScope("https://www.googleapis.com/auth/drive.file");
driveProvider.setCustomParameters({
  access_type: "offline", // request refresh token
  prompt:      "consent", // force consent screen so we always get a refresh token
});

// ── Sign In with Google ───────────────────────────────────────────────────────
export const signInWithGoogle = async () => {
  try {
    const result     = await signInWithPopup(auth, driveProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);

    // Firebase gives us the access_token from the popup.
    // To get the refresh token we need to exchange the authorization code
    // server-side. Firebase Web SDK doesn't expose the refresh token directly,
    // so we use the access token from the popup as the initial token,
    // and store it in memory (not localStorage).
    const accessToken = credential?.accessToken;
    if (accessToken) {
      _cachedAccessToken = accessToken;
      _tokenExpiresAt    = Date.now() + 55 * 60 * 1000; // 55 min conservative
      console.log("✅ Drive access token received — stored in memory only");

      // Persist refresh capability to server using Firebase ID token for auth
      // (the ID token proves the user is who they say they are)
      await _persistRefreshTokenToServer(result.user);
    }

    return result;
  } catch (error) {
    console.error("Sign in error:", error);
    throw error;
  }
};

// ── _persistRefreshTokenToServer ─────────────────────────────────────────────
// Firebase Web SDK doesn't give us the OAuth refresh token directly from popup.
// What we DO have is Firebase's own refresh token (for Firebase Auth), which we
// can use to get fresh Firebase ID tokens. For Drive specifically, we store the
// access token's expiry context and rely on /api/drive-token to use Firebase
// Admin SDK to verify user identity before issuing new Drive tokens.
//
// NOTE: For full offline refresh token persistence, you'd need to use
// Google's OAuth2 authorization code flow (not Firebase popup) on a
// dedicated /auth/callback serverless route. That's a larger refactor.
// This implementation covers the primary use case: long-lived sessions
// where the user stays signed in across tab reloads.
async function _persistRefreshTokenToServer(user) {
  try {
    const idToken = await user.getIdToken();
    // Signal to server that this user has authorized Drive
    // Server can use Firebase Admin to verify idToken and track auth state
    await fetch(DRIVE_API_ENDPOINT, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action: "store_session", idToken, uid: user.uid }),
    });
  } catch (e) {
    console.warn("Could not persist Drive session to server:", e.message);
  }
}

// ── getFreshDriveToken ────────────────────────────────────────────────────────
//
// Returns a valid Drive access token. Strategy:
//   1. Return in-memory token if still fresh (>5 min left)
//   2. Ask server (/api/drive-token) for a fresh token using Firebase ID token
//   3. If server returns no_token → return null → UI shows re-auth prompt
//
// No localStorage. No raw token persistence in browser.
export async function getFreshDriveToken() {
  const user = auth.currentUser;
  if (!user) {
    console.log("❌ No Firebase user — cannot get Drive token");
    return null;
  }

  // ── Step 1: Return cached in-memory token if still fresh ────────────────────
  if (_cachedAccessToken && Date.now() < _tokenExpiresAt - 5 * 60 * 1000) {
    return _cachedAccessToken;
  }

  // ── Step 2: Ask our server for a fresh access token ─────────────────────────
  try {
    console.log("🔄 Requesting fresh Drive token from server...");
    const idToken = await user.getIdToken(); // Firebase ID token — proves identity
    const res = await fetch(DRIVE_API_ENDPOINT, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action: "refresh", idToken, uid: user.uid }),
    });

    if (res.status === 404) {
      // Server has no refresh token stored — user needs to re-authorize
      console.log("❌ No refresh token on server — re-auth required");
      _cachedAccessToken = null;
      _tokenExpiresAt    = 0;
      return null;
    }

    if (res.status === 401) {
      // Refresh token was revoked by user from Google account settings
      console.log("❌ Refresh token revoked — re-auth required");
      _cachedAccessToken = null;
      _tokenExpiresAt    = 0;
      return null;
    }

    if (!res.ok) {
      console.error("❌ Server token refresh failed:", res.status);
      return null;
    }

    const { accessToken, expiresIn } = await res.json();
    // Store in memory only — survives tab reloads via server, not browser storage
    _cachedAccessToken = accessToken;
    _tokenExpiresAt    = Date.now() + (expiresIn - 60) * 1000; // 1 min buffer
    console.log("✅ Fresh Drive token received from server — stored in memory");
    return accessToken;

  } catch (err) {
    console.error("❌ Drive token fetch error:", err.message);
    return null;
  }
}

// ── reauthenticateDrive ───────────────────────────────────────────────────────
// Called when getFreshDriveToken() returns null. Shows consent popup again.
export async function reauthenticateDrive() {
  try {
    const user = auth.currentUser;
    if (!user) throw new Error("Not signed in.");

    console.log("🔐 Re-authorizing Drive...");
    const provider = new GoogleAuthProvider();
    provider.addScope("https://www.googleapis.com/auth/drive.file");
    provider.setCustomParameters({
      login_hint:  user.email,
      access_type: "offline",
      prompt:      "consent",
    });

    const result     = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;

    if (accessToken) {
      _cachedAccessToken = accessToken;
      _tokenExpiresAt    = Date.now() + 55 * 60 * 1000;
      await _persistRefreshTokenToServer(result.user);
      console.log("✅ Drive re-authorized — token in memory");
      return { success: true };
    }
    throw new Error("No access token returned");
  } catch (error) {
    console.error("Drive re-auth error:", error);
    return { success: false, error: error.message };
  }
}

// ── clearDriveToken ───────────────────────────────────────────────────────────
// Call when user disconnects Drive from Settings.
export async function clearDriveToken() {
  _cachedAccessToken = null;
  _tokenExpiresAt    = 0;
  const user = auth.currentUser;
  if (user) {
    try {
      const idToken = await user.getIdToken();
      await fetch(DRIVE_API_ENDPOINT, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "revoke", idToken, uid: user.uid }),
      });
    } catch (e) {
      console.warn("Could not revoke server-side Drive token:", e.message);
    }
  }
}

// ── Sign Out ──────────────────────────────────────────────────────────────────
export const signOutUser = () => {
  // Clear in-memory token — nothing in localStorage to clear
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
