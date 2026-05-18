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
// GOOGLE DRIVE - MULTI-USER AUTHENTICATION
// ══════════════════════════════════════════════════════════════════════════════
// Each team member connects their own Google Drive
// Tokens stored per-user in Firestore (secure & persistent)

const provider = new GoogleAuthProvider();
provider.addScope("https://www.googleapis.com/auth/drive.file");

// ── Sign In with Google (Drive permission included) ───────────────────────────
export const signInWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;
    
    if (accessToken) {
      // Store token in Firestore (per-user, secure, synced across devices)
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

// ── Save Drive Token to Firestore (per-user storage) ──────────────────────────
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

// ── getFreshDriveToken: Smart multi-layer token refresh ──────────────────────
export async function getFreshDriveToken() {
  const user = auth.currentUser;
  if (!user) {
    console.log("❌ No user signed in");
    return null;
  }

  // ── Layer 1: Check Firestore for cached token ─────────────────────────────
  const tokenData = await loadDriveToken(user.uid);
  if (tokenData?.accessToken && Date.now() < (tokenData.expiresAt - 5 * 60 * 1000)) {
    console.log("✅ Using cached Drive token from Firestore");
    return tokenData.accessToken;
  }

  console.log("🔄 Token expired/missing - attempting refresh...");

  // ── Layer 2: Try silent re-authentication ──────────────────────────────────
  try {
    const refreshProvider = new GoogleAuthProvider();
    refreshProvider.addScope("https://www.googleapis.com/auth/drive.file");
    refreshProvider.setCustomParameters({
      login_hint: user.email,
      prompt: 'none' // Try silent refresh first
    });

    const result = await signInWithPopup(auth, refreshProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const newAccessToken = credential?.accessToken;

    if (newAccessToken) {
      await saveDriveToken(user.uid, newAccessToken);
      console.log("✅ Drive token refreshed silently!");
      return newAccessToken;
    }
  } catch (silentError) {
    // Silent refresh failed - try with consent prompt
    console.log("⚠️ Silent refresh unavailable, checking for manual re-auth need...");
  }

  // ── Layer 3: Test if old token still works ────────────────────────────────
  if (tokenData?.accessToken) {
    try {
      const testRes = await fetch(
        'https://www.googleapis.com/drive/v3/about?fields=user',
        { headers: { Authorization: `Bearer ${tokenData.accessToken}` } }
      );
      
      if (testRes.ok) {
        // Old token still works! Extend its life
        await saveDriveToken(user.uid, tokenData.accessToken);
        console.log("✅ Old token still valid - extended in Firestore");
        return tokenData.accessToken;
      } else {
        console.log("❌ Old token invalid:", testRes.status);
      }
    } catch (testError) {
      console.log("❌ Token test failed:", testError.message);
    }
  }

  // ── Layer 4: All automatic methods failed ─────────────────────────────────
  console.log("❌ Token refresh failed - manual re-authentication required");
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
    
    const provider = new GoogleAuthProvider();
    provider.addScope("https://www.googleapis.com/auth/drive.file");
    provider.setCustomParameters({
      login_hint: user.email,
      prompt: 'consent' // Force consent screen for fresh token
    });

    const result = await signInWithPopup(auth, provider);
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

// ── Sign Out (cleans up Drive tokens) ─────────────────────────────────────────
export const signOutUser = async () => {
  const user = auth.currentUser;
  if (user) {
    try {
      // Clean up Drive token from Firestore
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
