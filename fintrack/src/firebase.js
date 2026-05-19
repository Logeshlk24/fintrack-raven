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
// GOOGLE DRIVE - TOKEN MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════
// Strategy:
//   1. On sign-in, save the fresh OAuth access token to Firestore.
//   2. getFreshDriveToken() checks Firestore; if the token is still valid
//      (more than 5 min left), return it immediately — no network call.
//   3. If expired, test the old token directly against Drive.  Google access
//      tokens often remain valid past the locally-stored expiresAt because
//      the clock on the client may drift.  If the test passes, reset the
//      expiry window and return it.
//   4. If the token is truly dead, return null so the caller can show
//      "Reconnect Drive" UI instead of making an unauthenticated request.
//
// NOTE: "Silent re-auth via prompt:none in a popup" does NOT work in browsers.
//       It either throws an immediate error or opens a blank popup. The only
//       reliable silent path is reauthenticateDrive() (user-initiated popup).

const driveProvider = new GoogleAuthProvider();
driveProvider.addScope("https://www.googleapis.com/auth/drive.file");

// ── Sign In with Google (Drive permission included) ───────────────────────────
export const signInWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, driveProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;

    if (accessToken) {
      const uid = result.user.uid;
      await saveDriveToken(uid, accessToken);
      console.log("✅ Drive access granted for:", result.user.email);
    } else {
      console.warn("⚠️ Sign-in succeeded but no Drive access token returned.");
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
      // Google access tokens live ~60 min; we record 58 min to be safe.
      expiresAt: Date.now() + 58 * 60 * 1000,
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
    if (snap.exists()) return snap.data();
  } catch (error) {
    console.error("Error loading Drive token:", error);
  }
  return null;
}

// ── Test whether a token is still accepted by Google Drive ────────────────────
async function isTokenAlive(accessToken) {
  if (!accessToken) return false;
  try {
    const res = await fetch(
      "https://www.googleapis.com/drive/v3/about?fields=user",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ── getFreshDriveToken ────────────────────────────────────────────────────────
// Returns a valid access token string, or null if re-auth is required.
export async function getFreshDriveToken() {
  const user = auth.currentUser;
  if (!user) {
    console.log("❌ getFreshDriveToken: no user signed in");
    return null;
  }

  const tokenData = await loadDriveToken(user.uid);
  const storedToken = tokenData?.accessToken;

  // ── Layer 1: Token exists and is within its validity window ───────────────
  const BUFFER_MS = 5 * 60 * 1000; // 5-minute safety buffer
  if (storedToken && Date.now() < (tokenData.expiresAt - BUFFER_MS)) {
    console.log("✅ Using cached Drive token from Firestore");
    return storedToken;
  }

  // ── Layer 2: Token is past expiry window — test it live anyway ─────────────
  // Google tokens sometimes survive past our locally-stored expiresAt.
  if (storedToken) {
    console.log("🔄 Token window expired — testing if Google still accepts it…");
    const alive = await isTokenAlive(storedToken);
    if (alive) {
      // Still valid: reset the expiry window for another 55 min
      await saveDriveToken(user.uid, storedToken);
      console.log("✅ Drive token still valid — expiry window reset");
      return storedToken;
    }
    console.log("❌ Drive token rejected by Google — re-auth required");
  } else {
    console.log("❌ No Drive token in Firestore — re-auth required");
  }

  // ── Layer 3: Nothing worked — caller must show Reconnect UI ───────────────
  return null;
}

// ── reauthenticateDrive: user-initiated popup to get a fresh token ────────────
// Call this when getFreshDriveToken() returns null.
// In App.jsx, show a "Reconnect Google Drive" button that calls this.
export async function reauthenticateDrive() {
  try {
    const user = auth.currentUser;
    if (!user) throw new Error("Not signed in.");

    console.log("🔐 Re-authorizing Drive access…");

    const provider = new GoogleAuthProvider();
    provider.addScope("https://www.googleapis.com/auth/drive.file");
    provider.setCustomParameters({
      login_hint: user.email,
      prompt: "consent", // force fresh token
    });

    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;

    if (!accessToken) throw new Error("No access token returned.");

    await saveDriveToken(user.uid, accessToken);
    console.log("✅ Drive re-authorized successfully!");
    return { success: true, token: accessToken };
  } catch (error) {
    console.error("Drive re-auth error:", error);
    return { success: false, error: error.message };
  }
}

// ── Sign Out ──────────────────────────────────────────────────────────────────
export const signOutUser = async () => {
  const user = auth.currentUser;
  if (user) {
    try {
      const tokenRef = doc(db, "users", user.uid, "tokens", "drive");
      await setDoc(tokenRef, { accessToken: null, expiresAt: 0 });
    } catch (error) {
      console.error("Error cleaning Drive token on sign-out:", error);
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
