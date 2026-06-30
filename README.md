# KnowBase ✦
### Your Personal Knowledge Hub — localhost only

A self-hosted, single-user knowledge base for your local machine. Store articles, documents, passwords, and anything important — all behind a master password.

---

## Features

| Feature | Details |
|---|---|
| 📝 Rich Articles | Bold, italic, headings, lists, code blocks, quotes, tables, links |
| 🖼 Inline Images | Paste or upload images directly into any article |
| 📁 Categories | Organize articles, with optional per-category password lock |
| 📎 Documents | Upload PDFs, ZIPs, Word docs, any file (up to 50MB each) |
| 🔐 Vault | Encrypted storage for passwords, API keys, tokens, SSH keys |
| 🔒 Master Password | Single password locks the entire app, changeable anytime |
| 🔍 Search | Full-text search across all articles and documents |
| 📌 Pin Articles | Pin important articles to the dashboard |
| 🎨 Dark UI | Clean, dark interface built for daily use |

---

## Quick Start

### Requirements
- **Node.js** v16 or higher → https://nodejs.org

### macOS / Linux
```bash
chmod +x start.sh
./start.sh
```

### Windows
Double-click `start.bat`

### Manual
```bash
cd backend
npm install
node server.js
```

Then open **http://localhost:3333** in your browser.

---

## First Run

1. Open http://localhost:3333
2. Choose an app name and set your **master password** (min 6 chars)
3. Three default categories are created for you
4. Start adding articles, documents, and vault entries!

---

## File Structure

```
knowbase/
├── backend/          ← Node.js/Express server
│   ├── server.js     ← Entry point
│   ├── routes.js     ← All API endpoints
│   ├── db.js         ← JSON file database
│   └── auth.js       ← JWT + password hashing
├── frontend/
│   └── public/
│       └── index.html  ← Complete single-page app
├── data/             ← YOUR DATA (auto-created)
│   ├── config.json   ← App config + master password hash
│   ├── categories.json
│   ← articles.json
│   ├── documents.json
│   └── vault.json    ← AES-encrypted vault entries
├── uploads/          ← Uploaded files (auto-created)
│   ├── images/       ← Article inline images
│   └── docs/         ← Uploaded documents
├── start.sh          ← Mac/Linux launcher
└── start.bat         ← Windows launcher
```

---

## Security Notes

- All data is stored **locally** — nothing is sent anywhere
- Master password is hashed with **bcrypt** (12 rounds)
- Vault entries are encrypted with **AES-256** (crypto-js)
- JWT tokens expire after **24 hours**
- Category passwords are hashed with bcrypt
- Run only on localhost — do **not** expose to the internet without adding HTTPS + firewall rules

---

## Backup

Just copy the `data/` and `uploads/` folders somewhere safe. That's your entire database.

---

## Changing Port

Edit `backend/server.js` line: `const PORT = process.env.PORT || 3333;`  
Or run with: `PORT=4000 node server.js`

---

## API Endpoints (for reference)

```
GET    /api/status              → Check if setup done
POST   /api/setup               → First-time setup
POST   /api/login               → Get JWT token
POST   /api/change-password     → Change master password

GET    /api/categories          → List categories
POST   /api/categories          → Create category
PUT    /api/categories/:id      → Update category
DELETE /api/categories/:id      → Delete category
POST   /api/categories/:id/unlock → Unlock protected category

GET    /api/articles            → List articles (supports ?categoryId= ?search=)
GET    /api/articles/:id        → Get single article (full content)
POST   /api/articles            → Create article
PUT    /api/articles/:id        → Update article
DELETE /api/articles/:id        → Delete article

POST   /api/upload/image        → Upload inline image → returns URL

GET    /api/documents           → List documents
POST   /api/documents/upload    → Upload file
PUT    /api/documents/:id       → Update metadata
DELETE /api/documents/:id       → Delete document + file

GET    /api/vault               → List vault entries (passwords masked)
GET    /api/vault/:id/reveal    → Reveal decrypted entry
POST   /api/vault               → Create entry
PUT    /api/vault/:id           → Update entry
DELETE /api/vault/:id           → Delete entry

GET    /api/search?q=           → Search articles + documents
GET    /api/stats               → Dashboard counts
```

---

## Deploying to a real server / domain (production)

This app was originally built for localhost-only use. To run it safely behind
a real domain, do the following:

1. **Copy `.env.example` to `.env`** in the `production/` folder (next to
   `backend/`, `frontend/`, etc.) and fill in real values:
   - `JWT_SECRET` and `VAULT_KEY` — generate strong random values, e.g.
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
     **The app will refuse to start in production without these.**
   - `ALLOWED_ORIGIN` — your real domain(s), e.g. `https://yourdomain.com`.
   - `TRUST_PROXY=1` if you're running behind nginx/Caddy/another reverse proxy.

2. **Run with `NODE_ENV=production`**, e.g.:
   ```bash
   NODE_ENV=production node backend/server.js
   ```
   or use a process manager like `pm2`:
   ```bash
   pm2 start backend/server.js --name knowbase --env production
   ```

3. **Put a reverse proxy (nginx/Caddy) in front** to terminate HTTPS and
   forward to this app's port. Caddy example:
   ```
   yourdomain.com {
     reverse_proxy localhost:3333
   }
   ```

4. **Google Drive sync**: in Google Cloud Console, set your OAuth client's
   redirect URI to `https://yourdomain.com/api/sync/oauth/callback` (must be
   HTTPS for a real domain — `http://localhost` only works for local testing).

5. **If you previously used the watch folder before this update**, run the
   one-time cleanup script to flatten any `processed/processed/processed/...`
   folders created by the old bug:
   ```bash
   node backend/scripts/fix-watch-folder.js
   ```
   This is safe to run even if there's nothing to clean up.

### What changed for production-readiness
- Fixed a bug where the watch-folder importer would recursively re-create
  nested `processed/` folders forever, slowly filling up disk space.
- The app now refuses to start in production without `JWT_SECRET` and
  `VAULT_KEY` set (previously fell back to a hardcoded default).
- CORS is now restricted to `ALLOWED_ORIGIN` instead of allowing any site.
- Login, setup, and password endpoints are now rate-limited against
  brute-force attempts.
- Added `.env` support and `trust proxy` handling for reverse-proxy setups.

---

## Deploying on Render's free tier

Render's free web services have **no persistent disk** — local files are
wiped on every restart (which also happens automatically after ~15 minutes
of inactivity). This app uses local JSON files for storage, so without a
workaround, every cold start would reset to a blank app and forget your
Google Drive connection too.

The fix already built into this app: store your Drive credentials as Render
environment variables (which *do* persist) instead of relying on the local
`data/sync-config.json` file. On every boot, the app uses those env vars to
auto-pull your latest data from Drive before it starts serving requests.

### One-time setup (do this once, locally, before deploying)
1. Run the app locally and complete setup as normal.
2. Go to the Sync page → connect Google Drive the normal way (paste your
   OAuth Client ID/Secret, click Connect, approve access).
3. Once connected, open `data/sync-config.json` and copy out three values:
   `clientId`, `clientSecret`, `refreshToken`.

### Deploy to Render
1. Push this repo to GitHub (already done if you're reading this on Render).
2. In Render: New → Blueprint → connect this repo → it will detect
   `render.yaml` automatically and pre-fill most settings.
3. Fill in the following environment variables when prompted (Render
   generates `JWT_SECRET`/`VAULT_KEY` for you automatically via the
   blueprint):
   - `ALLOWED_ORIGIN` → `https://your-app-name.onrender.com`
   - `GDRIVE_CLIENT_ID` → the clientId you copied above
   - `GDRIVE_CLIENT_SECRET` → the clientSecret you copied above
   - `GDRIVE_REFRESH_TOKEN` → the refreshToken you copied above
4. Deploy. Check the logs — you should see
   `GDRIVE_REFRESH_TOKEN found — pulling latest data from Google Drive...`
   on every boot.
5. Update your Google Cloud OAuth client's redirect URI to
   `https://your-app-name.onrender.com/api/sync/oauth/callback`.

### What to expect on free tier
- First request after 15 minutes of inactivity takes 30–60 seconds (cold
  start + Drive pull). This is normal.
- Edits you make are auto-pushed to Drive ~8 seconds after you stop typing.
  If the service is killed/restarted in that narrow window before the push
  completes, that last edit could be lost — push manually from the Sync page
  if you're about to step away right after a big edit, just to be safe.
- The watch-folder feature isn't really usable on Render (no way to drop
  files into a folder on a remote server day-to-day) — it'll still work if
  files arrive via Drive sync, just not via local file drop like on your
  own machine.


