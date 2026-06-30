try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3333;

// Required when running behind a reverse proxy (nginx/Caddy) with HTTPS,
// so secure cookies / correct protocol / req.ip work as expected.
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

// Lock CORS down to your real domain in production. Falls back to "allow
// everything" only when ALLOWED_ORIGIN isn't set, so local/dev use is unaffected.
const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors({ origin: allowedOrigin ? allowedOrigin.split(',').map(s => s.trim()) : '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Slow down brute-force attempts against login / password endpoints.
// Generous enough to never bother a real user typing their password.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again in a few minutes.' },
});
app.use(['/api/login', '/api/setup', '/api/verify-password', '/api/change-password'], authLimiter);

// Serve uploaded files
const uploadsDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Serve backups for download
const backupsDir = path.join(__dirname, '..', 'backups');
fs.mkdirSync(backupsDir, { recursive: true });

// Serve frontend
const frontendDir = path.join(__dirname, '..', 'frontend', 'public');
app.use(express.static(frontendDir));

// API routes
app.use('/api', require('./routes'));
app.use('/api', require('./routes-tools'));
app.use('/api', require('./routes-sync'));

// Fallback to index.html for SPA
app.get('/{*path}', (req, res) => {
  const indexPath = path.join(frontendDir, 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.send('<h1>Frontend not found</h1>');
});

async function start() {
  // On hosts with an ephemeral filesystem (e.g. Render free tier with no
  // persistent disk), local data/uploads/watch folders are empty on every
  // cold start. If Drive credentials are provided via env vars, pull
  // everything down first so the app boots with your real data instead of
  // a blank slate. Harmless no-op everywhere else (local dev, hosts with a
  // real persistent disk) since it only runs when GDRIVE_REFRESH_TOKEN is set.
  if (process.env.GDRIVE_REFRESH_TOKEN) {
    try {
      console.log('GDRIVE_REFRESH_TOKEN found — pulling latest data from Google Drive before starting...');
      const sync = require('./services/sync');
      const result = await sync.pull();
      console.log(`Pulled ${result.downloaded ?? 0} file(s) from Google Drive.`);
    } catch (e) {
      console.log('Initial Drive pull failed (continuing with local/empty data):', e.message);
    }
  }

  app.listen(PORT, () => {
    console.log(`\n🚀 KnowBase running at http://localhost:${PORT}`);
    console.log(`📁 Data: ${path.join(__dirname, '..', 'data')}`);
    console.log(`📂 Watch folder: ${path.join(__dirname, '..', 'watch')}`);
    console.log(`\nDrop .md or .txt files into the watch folder to auto-import.\n`);
  });

  // Start watch folder service
  try {
    const { startWatcher } = require('./services/watchfolder');
    startWatcher();
  } catch(e) { console.log('Watch folder service not started:', e.message); }

  // Start Google Drive sync service (auto-sync hooks into all data writes)
  try {
    require('./services/sync').init();
    console.log('Sync service initialized');
  } catch(e) { console.log('Sync service not started:', e.message); }

  // Auto backup scheduler (daily at 2am)
  try {
    const cron = require('node-cron');
    const { createBackup } = require('./services/backup');
    const db = require('./db');
    const config = db.config.get();
    if (config.autoBackup) {
      cron.schedule('0 2 * * *', async () => {
        console.log('Running scheduled backup...');
        await createBackup();
        console.log('Backup complete');
      });
      console.log('Auto-backup scheduled: daily at 2:00 AM');
    }
  } catch(e) {}
}

start();
