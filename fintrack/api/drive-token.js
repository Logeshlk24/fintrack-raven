// api/drive-token.js — Vercel Serverless Function
// ─────────────────────────────────────────────────
// POST /api/drive-token
//   Body: { action: "store", uid, refreshToken }   → saves refresh token for this user
//   Body: { action: "refresh", uid }               → returns a fresh access token
//   Body: { action: "revoke", uid }                → deletes stored refresh token
//
// The refresh token NEVER leaves the server. The browser only ever sees a
// short-lived access token (~1 hour). This is the standard OAuth2 server-side flow.
//
// ── Environment variables required (set in Vercel dashboard) ────────────────
//   GOOGLE_CLIENT_ID      — from Google Cloud Console → OAuth 2.0 Clients
//   GOOGLE_CLIENT_SECRET  — from Google Cloud Console → OAuth 2.0 Clients
//   TOKEN_ENCRYPTION_KEY  — random 32-char string you generate, used to encrypt
//                           refresh tokens at rest in Firestore
//   FIREBASE_PROJECT_ID   — your Firebase project ID (for server-side Firestore)
//   FIREBASE_CLIENT_EMAIL — from Firebase service account JSON
//   FIREBASE_PRIVATE_KEY  — from Firebase service account JSON (include \n newlines)

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore }                  from "firebase-admin/firestore";
import crypto                            from "crypto";

// ── Firebase Admin init (once) ───────────────────────────────────────────────
function getAdminDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
  }
  return getFirestore();
}

// ── AES-256-GCM encrypt/decrypt for refresh token at rest ───────────────────
const ALGO = "aes-256-gcm";
const KEY  = Buffer.from((process.env.TOKEN_ENCRYPTION_KEY || "").padEnd(32, "0").slice(0, 32));

function encrypt(text) {
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), enc.toString("hex"), tag.toString("hex")].join(".");
}

function decrypt(stored) {
  const [ivHex, encHex, tagHex] = stored.split(".");
  const iv  = Buffer.from(ivHex,  "hex");
  const enc = Buffer.from(encHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// ── Exchange refresh token → fresh access token via Google OAuth ─────────────
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
    throw new Error(data.error_description || data.error || "Token exchange failed");
  }
  return {
    accessToken: data.access_token,
    expiresIn:   data.expires_in || 3600, // seconds
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS — only your Vercel domain
  const origin = req.headers.origin || "";
  const allowed = process.env.ALLOWED_ORIGIN || "https://fintrack-raven.vercel.app";
  if (origin && origin !== allowed) {
    return res.status(403).json({ error: "Forbidden origin" });
  }
  res.setHeader("Access-Control-Allow-Origin",  allowed);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const { action, uid, refreshToken } = req.body || {};

  if (!uid) return res.status(400).json({ error: "uid required" });

  const db      = getAdminDb();
  const userDoc = db.collection("users").doc(uid).collection("private").doc("driveToken");

  try {
    // ── STORE: browser sends us the refresh token once (at login) ─────────────
    if (action === "store") {
      if (!refreshToken) return res.status(400).json({ error: "refreshToken required" });
      const encrypted = encrypt(refreshToken);
      await userDoc.set({ encryptedRefreshToken: encrypted, updatedAt: Date.now() });
      return res.status(200).json({ ok: true });
    }

    // ── REFRESH: browser asks for a fresh access token ────────────────────────
    if (action === "refresh") {
      const snap = await userDoc.get();
      if (!snap.exists) {
        return res.status(404).json({ error: "no_token", message: "No refresh token stored. User must re-authorize Drive." });
      }
      const { encryptedRefreshToken } = snap.data();
      const refreshTok = decrypt(encryptedRefreshToken);
      const { accessToken, expiresIn } = await exchangeRefreshToken(refreshTok);
      // Return access token to browser — it's short-lived (~1hr), safe to send
      return res.status(200).json({ accessToken, expiresIn });
    }

    // ── REVOKE: user disconnects Drive ────────────────────────────────────────
    if (action === "revoke") {
      const snap = await userDoc.get();
      if (snap.exists) {
        // Optionally revoke at Google too
        try {
          const { encryptedRefreshToken } = snap.data();
          const refreshTok = decrypt(encryptedRefreshToken);
          await fetch(`https://oauth2.googleapis.com/revoke?token=${refreshTok}`, { method: "POST" });
        } catch (_) { /* best-effort */ }
        await userDoc.delete();
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });

  } catch (err) {
    console.error("[drive-token]", err);
    // If Google says the refresh token is invalid (user revoked access from their Google account)
    if (err.message?.includes("invalid_grant")) {
      await userDoc.delete().catch(() => {});
      return res.status(401).json({ error: "invalid_grant", message: "Drive authorization expired. User must re-authorize." });
    }
    return res.status(500).json({ error: "internal", message: err.message });
  }
}
