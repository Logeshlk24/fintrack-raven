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
  // FIX 2: Import experimentalLongPolling settings
} from "firebase/firestore";
import { initializeFirestore, persistentLocalCache } from "firebase/firestore";

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

// ══════════════════════════════════════════════════════════════════════════════
// FIX 2: Use long-polling instead of WebSocket for Firestore
// This prevents ERR_BLOCKED_BY_CLIENT in Brave / strict browsers
// that block WebSocket connections to googleapi domains.
// ══════════════════════════════════════════════════════════════════════════════
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,   // ← fixes ERR_BLOCKED_BY_CLIENT
  useFetchStreams: false,                // ← disables streaming that Brave blocks
});

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE - MULTI-USER AUTHENTICATION
// ══════════════════════════════════════════════════════════════════════════════

const provider = new GoogleAuthProvider();
provider.addScope("https://www.googleapis.com/auth/drive.file");

// ── Sign In with Google (Drive permission included) ───────────────────────────
export const signInWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;

    if (accessToken) {
      const uid = result.user.uid;
      await saveDriveToken(uid, accessToken);
      console.log("✅ Drive access granted for:", result.user.email);
    }

    return result;
  } catch (error) {
    console.error("Sign in error:", error);
    throw error;
  }
};

// ── Save Drive Token to Firestore ─────────────────────────────────────────────
async function saveDriveToken(uid, accessToken) {
  try {
    const tokenRef = doc(db, "users", uid, "tokens", "drive");
    await setDoc(tokenRef, {
      accessToken,
      expiresAt: Date.now() + 55 * 60 * 1000, // 55 minutes
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error saving Drive token:", error);
  }
}

// ── Load Drive Token from Firestore ───────────────────────────────────────────
async function loadDriveToken(uid) {
  try {
    const tokenRef = doc(db, "users", uid, "tokens", "drive");
    const snap = await getDoc(tokenRef);
    if (snap.exists()) {
      return snap.data();
    }
  } catch (error) {
    console.error("Error loading Drive token:", error);
  }
  return null;
}

// ── FIX 1: getFreshDriveToken — simplified & correct ─────────────────────────
//
// ROOT CAUSE of the 401 loop:
//   Layer 2 used prompt:'none' which always fails (Google disallows silent
//   re-auth in popups). On failure it fell through to Layer 3, which
//   re-saved the SAME expired token and returned it → 401 forever.
//
// FIX: Check token validity with a real API call first.
//   If expired → signal the app to show a "Reconnect" button.
//   Do NOT re-save an expired token.
// ─────────────────────────────────────────────────────────────────────────────
export async function getFreshDriveToken() {
  const user = auth.currentUser;
  if (!user) {
    console.log("❌ No user signed in");
    return null;
  }

  // Layer 1: Load cached token from Firestore
  const tokenData = await loadDriveToken(user.uid);

  // Layer 2: If token exists and expiry says it's still fresh, trust it first
  if (tokenData?.accessToken && Date.now() < (tokenData.expiresAt - 5 * 60 * 1000)) {
    // Double-check with a real API call (token might be revoked even if not expired)
    try {
      const testRes = await fetch(
        "https://www.googleapis.com/drive/v3/about?fields=user",
        { headers: { Authorization: `Bearer ${tokenData.accessToken}` } }
      );
      if (testRes.ok) {
        console.log("✅ Using cached Drive token from Firestore");
        return tokenData.accessToken;
      }
      // Token is invalid despite expiry — fall through
      console.log("⚠️ Cached token rejected by Google (revoked?) — needs re-auth");
    } catch {
      // Network error — optimistically return the token and let caller handle 401
      return tokenData.accessToken;
    }
  }

  // Layer 3: Token is expired or invalid — signal the UI to prompt re-auth
  // Do NOT attempt silent popup (prompt:'none') — it always fails and causes loops.
  console.log("❌ Drive token expired/invalid — manual re-authentication required");
  window.dispatchEvent(new CustomEvent("drive-token-expired"));
  return null;
}

// ── Re-authenticate Drive (shows popup with consent) ──────────────────────────
export async function reauthenticateDrive() {
  try {
    const user = auth.currentUser;
    if (!user) {
      throw new Error("Not signed in. Please sign in with Google first.");
    }

    console.log("🔐 Re-authorizing Drive access with consent...");

    const reAuthProvider = new GoogleAuthProvider();
    reAuthProvider.addScope("https://www.googleapis.com/auth/drive.file");
    reAuthProvider.setCustomParameters({
      login_hint: user.email,
      prompt: "consent", // Force consent screen for a fresh token
    });

    const result = await signInWithPopup(auth, reAuthProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;

    if (accessToken) {
      await saveDriveToken(user.uid, accessToken);
      console.log("✅ Drive re-authorized successfully!");
      return { success: true, token: accessToken };
    }

    throw new Error("Failed to get access token");
  } catch (error) {
    console.error("Drive re-authentication error:", error);
    return { success: false, error: error.message };
  }
}

// ── Sign Out ───────────────────────────────────────────────────────────────────
export const signOutUser = async () => {
  const user = auth.currentUser;
  if (user) {
    try {
      const tokenRef = doc(db, "users", user.uid, "tokens", "drive");
      await setDoc(tokenRef, { accessToken: null, expiresAt: 0 });
    } catch (error) {
      console.error("Error cleaning Drive token:", error);
    }
  }
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
