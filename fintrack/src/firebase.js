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

export const signInWithGoogle = async () => {
  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  const accessToken = credential?.accessToken;
  
  if (accessToken) {
    const expiry = Date.now() + 55 * 60 * 1000;
    localStorage.setItem("ft_drv_tok", accessToken);
    localStorage.setItem("ft_drv_exp", String(expiry));
    localStorage.setItem("ft_drv_email", result.user.email || "");
  }
  
  return result;
};

export async function getFreshDriveToken() {
  const user = auth.currentUser;
  if (!user) return null;

  const saved = localStorage.getItem("ft_drv_tok");
  const expiry = parseInt(localStorage.getItem("ft_drv_exp") || "0");

  if (saved && Date.now() < expiry - 5 * 60 * 1000) {
    return saved;
  }

  try {
    if (saved) {
      const testRes = await fetch(
        'https://www.googleapis.com/drive/v3/about?fields=user',
        { headers: { Authorization: `Bearer ${saved}` } }
      );
      
      if (testRes.ok) {
        const newExpiry = Date.now() + 55 * 60 * 1000;
        localStorage.setItem("ft_drv_exp", String(newExpiry));
        return saved;
      }
    }

    return null;
    
  } catch (error) {
    console.error("Token refresh error:", error);
    return null;
  }
}

export async function reauthenticateDrive() {
  try {
    const user = auth.currentUser;
    if (!user) {
      throw new Error("Not signed in. Please sign in with Google first.");
    }

    const provider = new GoogleAuthProvider();
    provider.addScope("https://www.googleapis.com/auth/drive.file");
    provider.setCustomParameters({
      login_hint: user.email,
      prompt: 'consent'
    });

    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;

    if (accessToken) {
      const expiry = Date.now() + 55 * 60 * 1000;
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
