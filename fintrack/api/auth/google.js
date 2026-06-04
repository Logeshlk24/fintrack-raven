// api/auth/google.js
// ──────────────────
// Step 1 of OAuth flow: redirect user to Google consent page.
// Called when user clicks "Sign in with Google" in the app.
//
// GET /api/auth/google
//
// Flow: App → GET /api/auth/google → Google consent page → /api/auth/callback
//
// Required env vars:
//   GOOGLE_CLIENT_ID    — OAuth 2.0 Client ID from Google Cloud Console
//   NEXT_PUBLIC_APP_URL — e.g. https://fintrack-raven.vercel.app

export default function handler(req, res) {
  const clientId    = process.env.GOOGLE_CLIENT_ID;
  const appUrl      = process.env.NEXT_PUBLIC_APP_URL || "https://fintrack-raven.vercel.app";
  const redirectUri = `${appUrl}/api/auth/callback`;

  // Scopes:
  //   openid + email + profile → for Firebase custom token sign-in
  //   drive.file               → for Drive file access
  const scopes = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/drive.file",
  ].join(" ");

  // CSRF protection: random state stored in HttpOnly cookie, verified in callback
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  res.setHeader(
    "Set-Cookie",
    `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`
  );

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: "code",
    scope:         scopes,
    access_type:   "offline",  // ← gets us the refresh token
    prompt:        "consent",  // ← always show consent so refresh token is always issued
    state,
  });

  res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}
