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

const provider = new GoogleAuthProvider();
provider.addScope("https://www.googleapis.com/auth/drive.file");

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE - AUTOMATIC TOKEN REFRESH
// ══════════════════════════════════════════════════════════════════════════════

export const signInWithGoogle = async () => {
  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  const accessToken = credential?.accessToken;
  
  if (accessToken) {
    const expiry = Date.now() + 55 * 60 * 1000; // 55 minutes
    localStorage.setItem("ft_drv_tok", accessToken);
    localStorage.setItem("ft_drv_exp", String(expiry));
    localStorage.setItem("ft_drv_email", result.user.email || "");
    console.log("✅ Drive access granted! Token saved.");
  }
  
  return result;
};

// ── getFreshDriveToken: Returns valid token, auto-refreshes if needed ─────────
export async function getFreshDriveToken() {
  const user = auth.currentUser;
  if (!user) {
    console.log("❌ No Firebase user - cannot get Drive token");
    return null;
  }

  const saved = localStorage.getItem("ft_drv_tok");
  const expiry = parseInt(localStorage.getItem("ft_drv_exp") || "0");

  // Token still fresh (more than 5 minutes remaining)
  if (saved && Date.now() < expiry - 5 * 60 * 1000) {
    return saved;
  }

  // Token expired or expiring soon - try to refresh
  console.log("🔄 Drive token expired/expiring - attempting automatic refresh...");

  try {
    // Force Firebase to refresh the ID token, which triggers a re-authentication
    // This will get a fresh OAuth token from Google
    const idTokenResult = await user.getIdTokenResult(true); // true = force refresh
    
    // The force refresh doesn't give us the OAuth access token directly
    // We need to get it from the credential
    // So we'll trigger a silent re-authentication with prompt=none
    
    const refreshProvider = new GoogleAuthProvider();
    refreshProvider.addScope("https://www.googleapis.com/auth/drive.file");
    refreshProvider.setCustomParameters({
      login_hint: user.email,
      prompt: 'none' // Silent refresh - no UI popup
    });

    try {
      const result = await signInWithPopup(auth, refreshProvider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      const accessToken = credential?.accessToken;

      if (accessToken) {
        const newExpiry = Date.now() + 55 * 60 * 1000;
        localStorage.setItem("ft_drv_tok", accessToken);
        localStorage.setItem("ft_drv_exp", String(newExpiry));
        console.log("✅ Drive token refreshed automatically!");
        return accessToken;
      }
    } catch (popupError) {
      // Silent refresh failed - prompt=none doesn't work in all cases
      console.warn("⚠️ Silent refresh failed, token might be expired");
      
      // Test if the old token still works
      if (saved) {
        const testRes = await fetch(
          'https://www.googleapis.com/drive/v3/about?fields=user',
          { headers: { Authorization: `Bearer ${saved}` } }
        );
        
        if (testRes.ok) {
          // Old token still works! Extend its life
          const newExpiry = Date.now() + 55 * 60 * 1000;
          localStorage.setItem("ft_drv_exp", String(newExpiry));
          console.log("✅ Old token still valid - extended expiry");
          return saved;
        }
      }
      
      // Token is truly dead - user needs to re-authenticate manually
      console.log("❌ Token expired - manual re-authentication needed");
      return null;
    }

    return null;
    
  } catch (error) {
    console.error("❌ Token refresh error:", error);
    return null;
  }
}

// ── Re-authenticate Drive (manual) ────────────────────────────────────────────
export async function reauthenticateDrive() {
  try {
    const user = auth.currentUser;
    if (!user) {
      throw new Error("Not signed in. Please sign in with Google first.");
    }

    console.log("🔐 Re-authorizing Drive access (manual)...");
    
    const provider = new GoogleAuthProvider();
    provider.addScope("https://www.googleapis.com/auth/drive.file");
    provider.setCustomParameters({
      login_hint: user.email,
      prompt: 'consent' // Force consent screen to get fresh token
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
