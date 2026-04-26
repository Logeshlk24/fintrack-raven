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

// ── Your Firebase project config ─────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDr_yGnZNsT_NgFmw0RkTRZhpzsRFy0SiU",
  authDomain: "fintracker-raven.firebaseapp.com",
  projectId: "fintracker-raven",
  storageBucket: "fintracker-raven.firebasestorage.app",
  messagingSenderId: "120401698302",
  appId: "1:120401698302:web:2a9a8ac0531acf177f34af",
  measurementId: "G-1MVVYSS4SR",
};

// ── Initialize ────────────────────────────────────────────────────────────────
const app   = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);   // kept from your original config

export const auth     = getAuth(app);
export const db       = getFirestore(app);
const provider        = new GoogleAuthProvider();

// ── Auth helpers ──────────────────────────────────────────────────────────────
export const signInWithGoogle = () => signInWithPopup(auth, provider);
export const signOutUser      = () => signOut(auth);
export { onAuthStateChanged };

// ── Firestore helpers ─────────────────────────────────────────────────────────
// Data path:  users/{uid}/fintrack/data  (one doc per user)
const userRef = (uid) => doc(db, "users", uid, "fintrack", "data");

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
    await setDoc(userRef(uid), data, { merge: true });
  } catch (e) {
    console.error("Firestore save error:", e);
  }
}
