# FinTrack — Firebase Setup & Deploy

## File structure
```
fintrack/
├── index.html
├── package.json
├── vite.config.js
├── vercel.json
├── firestore.rules        ← paste this in Firebase Console
├── .gitignore
└── src/
    ├── main.jsx           ← React entry point
    ├── firebase.js        ← your config + auth/Firestore helpers
    └── App.jsx            ← full app (auth-gated, Firestore-backed)
```

---

## Step 1 — Firebase Console setup (do this first)

### A. Enable Google Sign-In
1. console.firebase.google.com → project **fintracker-raven**
2. **Authentication → Sign-in method → Google → Enable**
3. Add `localhost` to **Authorized domains** (for local dev)
4. Add your Vercel URL after deploy (e.g. `fintrack.vercel.app`)

### B. Create Firestore database
1. **Firestore Database → Create database → Production mode**
2. Region: `asia-south1` (India) recommended
3. After creation → **Rules tab → replace everything** with the
   contents of `firestore.rules` → **Publish**

---

## Step 2 — Local development
```bash
npm install
npm run dev
# Opens at http://localhost:5173
```

---

## Step 3 — Deploy to Vercel

### Option A — Vercel CLI
```bash
npx vercel
# Framework: Vite (auto-detected)
# Build: npm run build
# Output: dist
```

### Option B — GitHub + Vercel Dashboard
1. Push this folder to a GitHub repo
2. vercel.com/new → Import repo
3. Framework preset: **Vite**
4. Click **Deploy**

### After deploy — add your domain to Firebase
Authentication → Settings → Authorized domains → Add `your-app.vercel.app`

---

## What changed from V1

| V1 | Firebase Version |
|---|---|
| `localStorage` | Firestore per-user document |
| Mock Google sign-in | Real Firebase Auth |
| Data in browser only | Synced across all devices |
| Lost on browser clear | Persists permanently |
| `mockUser = { name: "Demo" }` | Real name, email, photo from Google |

## Data path in Firestore
```
users/{uid}/fintrack/data   ←  one document per user, entire app state
```

## Migration
Existing `localStorage` data is automatically migrated to Firestore
on the user's first sign-in, then cleared from localStorage.
