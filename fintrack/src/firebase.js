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

const app       = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
export const auth = getAuth(app);
export const db   = getFirestore(app);

// ── Google provider — Drive scope added so sign-in grants Drive access too ──
// Only change from your original: provider.addScope("drive.file")
// The popup will ask for Drive permission once. After that, Drive stays
// connected automatically — no separate Drive login ever needed.
const provider = new GoogleAuthProvider();
provider.addScope("https://www.googleapis.com/auth/drive.file");

export const signInWithGoogle = async () => {
  const result = await signInWithPopup(auth, provider);

  // Extract the Drive access_token Google returns at sign-in
  const credential  = GoogleAuthProvider.credentialFromResult(result);
  const accessToken = credential?.accessToken;

  if (accessToken) {
    // Save to localStorage — DriveProvider reads these on mount
    const expiry = Date.now() + (3600 - 120) * 1000; // ~58 min
    localStorage.setItem("ft_drv_tok",   accessToken);
    localStorage.setItem("ft_drv_exp",   String(expiry));
    localStorage.setItem("ft_drv_email", result.user.email || "");
  }

  return result;
};

export const signOutUser = () => {
  // Clear Drive token on sign-out
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
