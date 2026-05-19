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
// GOOGLE AUTHENTICATION - ONE-TIME LOGIN (NO REPEATED POPUPS)
// ══════════════════════════════════════════════════════════════════════════════
// Uses Firebase ID Tokens + Cloud Function backend for Drive access
// User signs in once → Firebase handles everything automatically

const provider = new GoogleAuthProvider();
// Request offline access to get refresh token (stored server-side)
provider.addScope("https://www.googleapis.com/auth/drive.file");
provider.setCustomParameters({
  access_type: 'offline',
  prompt: 'consent' // Only shows on first login or if user revokes access
});

// ── Sign In with Google (ONE-TIME, includes Drive permission) ─────────────────
export const signInWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, provider);
    const user = result.user;
    
    // Get the authorization code from the result
    const credential = GoogleAuthProvider.credentialFromResult(result);
    
    // Store user's Drive consent in Firestore
    await setDoc(doc(db, "users", user.uid, "settings", "drive"), {
      authorized: true,
      authorizedAt: new Date().toISOString(),
      email: user.email,
    });
    
    console.log("✅ Signed in successfully:", user.email);
    console.log("✅ Drive access granted (managed by backend)");
    
    return result;
  } catch (error) {
    console.error("Sign in error:", error);
    throw error;
  }
};

// ── Sign Out ──────────────────────────────────────────────────────────────────
export const signOutUser = async () => {
  const user = auth.currentUser;
  if (user) {
    try {
      // Mark Drive as unauthorized in Firestore
      await setDoc(doc(db, "users", user.uid, "settings", "drive"), {
        authorized: false,
        authorizedAt: null,
      });
    } catch (error) {
      console.error("Error updating Drive settings:", error);
    }
  }
  return signOut(auth);
};

export { onAuthStateChanged };

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE API - CLOUD FUNCTION INTEGRATION
// ══════════════════════════════════════════════════════════════════════════════
// All Drive operations go through Cloud Function
// Firebase ID Token is automatically refreshed (no popups!)

const CLOUD_FUNCTION_URL = "https://us-central1-fintracker-raven.cloudfunctions.net/driveAPI";

// ── Get Fresh Firebase ID Token (auto-refreshed by Firebase) ──────────────────
async function getFirebaseIdToken() {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Not signed in");
  }
  
  // Firebase automatically refreshes this token every hour
  // No popup needed - happens in the background!
  const idToken = await user.getIdToken(true); // true = force refresh
  return idToken;
}

// ── Upload File to Google Drive (via Cloud Function) ──────────────────────────
export async function uploadToDrive(file, metadata = {}) {
  try {
    const idToken = await getFirebaseIdToken();
    
    // Convert file to base64
    const base64 = await fileToBase64(file);
    
    const response = await fetch(CLOUD_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        action: 'upload',
        fileName: file.name,
        mimeType: file.type,
        fileData: base64,
        metadata,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Upload failed: ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log("✅ File uploaded to Drive:", result.fileId);
    return result;
  } catch (error) {
    console.error("Drive upload error:", error);
    throw error;
  }
}

// ── Download File from Google Drive (via Cloud Function) ──────────────────────
export async function downloadFromDrive(fileId) {
  try {
    const idToken = await getFirebaseIdToken();
    
    const response = await fetch(CLOUD_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        action: 'download',
        fileId,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Download failed: ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log("✅ File downloaded from Drive");
    return result;
  } catch (error) {
    console.error("Drive download error:", error);
    throw error;
  }
}

// ── List Files in Google Drive (via Cloud Function) ───────────────────────────
export async function listDriveFiles(query = {}) {
  try {
    const idToken = await getFirebaseIdToken();
    
    const response = await fetch(CLOUD_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        action: 'list',
        query,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`List files failed: ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log(`✅ Found ${result.files?.length || 0} files in Drive`);
    return result;
  } catch (error) {
    console.error("Drive list error:", error);
    throw error;
  }
}

// ── Delete File from Google Drive (via Cloud Function) ────────────────────────
export async function deleteFromDrive(fileId) {
  try {
    const idToken = await getFirebaseIdToken();
    
    const response = await fetch(CLOUD_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        action: 'delete',
        fileId,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Delete failed: ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log("✅ File deleted from Drive");
    return result;
  } catch (error) {
    console.error("Drive delete error:", error);
    throw error;
  }
}

// ── Helper: Convert File to Base64 ────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

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
