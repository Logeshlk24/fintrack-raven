// firebase.js — FinTrack
// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT: The GoogleAuthProvider includes the Drive scope so that when the
// user signs in to FinTrack with Google, they simultaneously grant Drive access.
// This means Drive is ALWAYS connected as long as the user is logged in.
// No separate "Connect Drive" step is needed for new users.
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged as _onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";

// ── Your Firebase config — do NOT change these values ─────────────────────
// (paste your own config here if you're setting up a new project)
const firebaseConfig = {
  // These values come from Firebase Console → Project Settings → General → Your apps
  // apiKey:            "...",
  // authDomain:        "...",
  // projectId:         "...",
  // storageBucket:     "...",
  // messagingSenderId: "...",
  // appId:             "...",
  ...((window.__FIREBASE_CONFIG__) || {}), // injected by your build/hosting setup
};

const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
const db   = getFirestore(app);

// ── Google Auth Provider — with Drive scope added ─────────────────────────
//
//  By adding "drive.file" scope here, every Google sign-in automatically
//  grants Drive upload permission. The OAuth access_token returned by
//  signInWithPopup includes Drive access. We extract it and save it so
//  DriveProvider can use it without any separate login flow.
//
const googleProvider = new GoogleAuthProvider();
googleProvider.addScope("https://www.googleapis.com/auth/drive.file");
googleProvider.addScope("https://www.googleapis.com/auth/userinfo.email");
googleProvider.addScope("https://www.googleapis.com/auth/userinfo.profile");

// Force account selection on first sign-in so users can pick the right account
googleProvider.setCustomParameters({ prompt: "select_account" });

// ── signInWithGoogle — called from SignInPage ──────────────────────────────
export async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);

    // Extract the OAuth access_token from the Google credential
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;

    if (accessToken) {
      // Save the Drive access token to localStorage so DriveProvider picks it up
      // immediately without needing any additional sign-in step.
      //
      // Google access tokens from signInWithPopup last ~1 hour.
      // DriveProvider's silent refresh (prompt:"none") will renew it automatically.
      const expiresIn = 3600; // Google access tokens last 1 hour
      const expiry    = Date.now() + (expiresIn - 120) * 1000;
      localStorage.setItem("ft_drv_tok",   accessToken);
      localStorage.setItem("ft_drv_exp",   String(expiry));
      localStorage.setItem("ft_drv_email", result.user.email || "");
      // ft_drv_cid is set separately when the user enters their Client ID in Settings
    }

    return result.user;
  } catch (err) {
    // If user closes the popup, treat as cancelled (not an error)
    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") {
      return null;
    }
    throw err;
  }
}

// ── signOutUser ────────────────────────────────────────────────────────────
export async function signOutUser() {
  // Also clear the Drive token on sign-out
  ["ft_drv_tok", "ft_drv_exp", "ft_drv_email"].forEach(k => localStorage.removeItem(k));
  return signOut(auth);
}

// ── onAuthStateChanged (re-export) ────────────────────────────────────────
export { _onAuthStateChanged as onAuthStateChanged };

// ── Firestore helpers ─────────────────────────────────────────────────────
export async function loadFromFirestore(uid, fallback) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) return snap.data();
    return fallback;
  } catch {
    return fallback;
  }
}

export async function saveToFirestore(uid, data) {
  try {
    await setDoc(doc(db, "users", uid), data, { merge: true });
  } catch (e) {
    console.warn("Firestore save failed:", e);
  }
}
