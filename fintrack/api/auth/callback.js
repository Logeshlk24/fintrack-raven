// api/auth/callback.js
// ────────────────────
// Step 2 of OAuth flow: Google redirects here with an authorization code.
// We exchange it for tokens, store the refresh token server-side (encrypted),
// create a Firebase custom token for the user, and redirect back to the app.
//
// GET /api/auth/callback?code=...&state=...
//
// Required env vars:
//   GOOGLE_CLIENT_ID      — OAuth 2.0 Client ID
//   GOOGLE_CLIENT_SECRET  — OAuth 2.0 Client Secret
//   NEXT_PUBLIC_APP_URL   — e.g. https://fintrack-raven.vercel.app
//   FIREBASE_PROJECT_ID   — Firebase project ID
//   FIREBASE_CLIENT_EMAIL — Firebase service account email
//   FIREBASE_PRIVATE_KEY  — Firebase service account private key
//   TOKEN_ENCRYPTION_KEY  — 32-char random string for AES-256 encryption

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth }                       from "firebase-admin/auth";
import { getFirestore }                  from "firebase-admin/firestore";
import crypto                            from "crypto";

// ── Firebase Admin (singleton) ───────────────────────────────────────────────
function getAdmin() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
  }
  return { auth: getAuth(), db: getFirestore() };
}

// ── AES-256-GCM encrypt ───────────────────────────────────────────────────────
const ALGO = "aes-256-gcm";
const KEY  = Buffer.from((process.env.TOKEN_ENCRYPTION_KEY || "").padEnd(32, "0").slice(0, 32));

function encrypt(text) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc    = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return [iv.toString("hex"), enc.toString("hex"), tag.toString("hex")].join(".");
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const appUrl      = process.env.NEXT_PUBLIC_APP_URL || "https://fintrack-raven.vercel.app";
  const redirectUri = `${appUrl}/api/auth/callback`;

  const { code, state, error } = req.query;

  // ── Handle Google errors (user denied consent, etc.) ────────────────────────
  if (error) {
    console.error("[callback] Google OAuth error:", error);
    return res.redirect(302, `${appUrl}?auth_error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect(302, `${appUrl}?auth_error=no_code`);
  }

  // ── CSRF check: verify state matches cookie ──────────────────────────────────
  const cookieState = req.cookies?.oauth_state;
  if (!cookieState || cookieState !== state) {
    console.error("[callback] State mismatch — possible CSRF");
    return res.redirect(302, `${appUrl}?auth_error=state_mismatch`);
  }

  // Clear the state cookie
  res.setHeader("Set-Cookie", `oauth_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`);

  try {
    // ── Step 1: Exchange authorization code for tokens ───────────────────────
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  redirectUri,
        grant_type:    "authorization_code",
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      console.error("[callback] Token exchange failed:", tokens);
      return res.redirect(302, `${appUrl}?auth_error=token_exchange_failed`);
    }

    const { access_token, refresh_token, id_token } = tokens;

    // ── Step 2: Get user info from Google ────────────────────────────────────
    const userRes  = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const userInfo = await userRes.json();
    const { sub: googleId, email, name, picture } = userInfo;

    if (!googleId || !email) {
      return res.redirect(302, `${appUrl}?auth_error=no_user_info`);
    }

    // ── Step 3: Create/update Firebase user and get custom token ─────────────
    const { auth, db } = getAdmin();
    let firebaseUid;

    try {
      // Try to get existing user by email
      const existing = await auth.getUserByEmail(email);
      firebaseUid = existing.uid;
      // Update display name and photo if changed
      await auth.updateUser(firebaseUid, { displayName: name, photoURL: picture });
    } catch (e) {
      if (e.code === "auth/user-not-found") {
        // Create new Firebase user
        const created = await auth.createUser({
          uid:         googleId, // use Google sub as Firebase UID for consistency
          email,
          displayName: name,
          photoURL:    picture,
        });
        firebaseUid = created.uid;
      } else {
        throw e;
      }
    }

    // ── Step 4: Store refresh token encrypted in Firestore (server-only) ─────
    // Path: users/{uid}/private/driveToken
    // This sub-collection is NEVER accessible from the client
    // (lock it in Firestore Security Rules: allow read, write: if false;)
    if (refresh_token) {
      const encrypted = encrypt(refresh_token);
      await db
        .collection("users")
        .doc(firebaseUid)
        .collection("private")
        .doc("driveToken")
        .set({ encryptedRefreshToken: encrypted, updatedAt: Date.now() });
      console.log(`[callback] Refresh token stored for uid: ${firebaseUid}`);
    } else {
      // refresh_token is only returned on first consent or after revocation.
      // If user already authorized before, Google won't return it again.
      // The existing stored refresh token is still valid — nothing to update.
      console.log(`[callback] No new refresh token — existing one still valid`);
    }

    // ── Step 5: Create Firebase custom token for client sign-in ──────────────
    // This is what the browser will use to sign into Firebase Auth
    const customToken = await auth.createCustomToken(firebaseUid, {
      email,
      name,
      picture,
    });

    // ── Step 6: Redirect back to app with custom token ───────────────────────
    // The app receives this token, calls signInWithCustomToken(), done.
    // We pass it as a URL param — it's short-lived (1 hour) and single-use.
    return res.redirect(302, `${appUrl}?custom_token=${encodeURIComponent(customToken)}`);

  } catch (err) {
    console.error("[callback] Unexpected error:", err);
    return res.redirect(302, `${appUrl}?auth_error=${encodeURIComponent(err.message)}`);
  }
}
