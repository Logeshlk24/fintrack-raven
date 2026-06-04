// api/drive-token.js
// ───────────────────
// Issues fresh Google Drive access tokens using the server-stored refresh token.
// The refresh token NEVER leaves this server — browser only gets access tokens.
//
// POST /api/drive-token
//   { action: "refresh", idToken } → returns { accessToken, expiresIn }
//   { action: "revoke",  idToken } → deletes stored refresh token
//
// Required env vars:
//   GOOGLE_CLIENT_ID      — OAuth 2.0 Client ID
//   GOOGLE_CLIENT_SECRET  — OAuth 2.0 Client Secret
//   FIREBASE_PROJECT_ID   — for Admin SDK
//   FIREBASE_CLIENT_EMAIL — for Admin SDK
//   FIREBASE_PRIVATE_KEY  — for Admin SDK
//   TOKEN_ENCRYPTION_KEY  — 32-char AES key
//   NEXT_PUBLIC_APP_URL   — for CORS

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

// ── AES-256-GCM decrypt ───────────────────────────────────────────────────────
const ALGO = "aes-256-gcm";
const KEY  = Buffer.from((process.env.TOKEN_ENCRYPTION_KEY || "").padEnd(32, "0").slice(0, 32));

function decrypt(stored) {
  const [ivHex, encHex, tagHex] = stored.split(".");
  const iv      = Buffer.from(ivHex,  "hex");
  const enc     = Buffer.from(encHex, "hex");
  const tag     = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// ── Exchange refresh token → fresh access token ───────────────────────────────
async function exchangeRefreshToken(refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error || "token_exchange_failed");
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in || 3600 };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://fintrack-raven.vercel.app";
  res.setHeader("Access-Control-Allow-Origin",  appUrl);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const { action, idToken } = req.body || {};

  if (!idToken) return res.status(401).json({ error: "idToken required" });

  try {
    // ── Verify Firebase ID token — proves the caller is a real signed-in user ──
    const { auth, db } = getAdmin();
    const decoded = await auth.verifyIdToken(idToken);
    const uid     = decoded.uid;

    const tokenDoc = db.collection("users").doc(uid).collection("private").doc("driveToken");

    // ── REFRESH: return a fresh Drive access token ───────────────────────────
    if (action === "refresh") {
      const snap = await tokenDoc.get();
      if (!snap.exists) {
        return res.status(404).json({
          error:   "no_token",
          message: "No Drive authorization found. User must sign in again.",
        });
      }
      const refreshToken  = decrypt(snap.data().encryptedRefreshToken);
      const { accessToken, expiresIn } = await exchangeRefreshToken(refreshToken);
      // Access token is short-lived (~1hr) — safe to send to browser
      return res.status(200).json({ accessToken, expiresIn });
    }

    // ── REVOKE: user disconnects Drive ───────────────────────────────────────
    if (action === "revoke") {
      const snap = await tokenDoc.get();
      if (snap.exists) {
        try {
          const refreshToken = decrypt(snap.data().encryptedRefreshToken);
          await fetch(`https://oauth2.googleapis.com/revoke?token=${refreshToken}`, { method: "POST" });
        } catch (_) { /* best-effort Google revocation */ }
        await tokenDoc.delete();
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });

  } catch (err) {
    console.error("[drive-token]", err.message);

    if (err.code === "auth/id-token-expired" || err.code === "auth/argument-error") {
      return res.status(401).json({ error: "invalid_id_token" });
    }
    if (err.message === "invalid_grant") {
      // Refresh token was revoked by user from Google account settings
      return res.status(401).json({ error: "invalid_grant", message: "Drive access revoked. Please sign in again." });
    }
    return res.status(500).json({ error: "internal", message: err.message });
  }
}
