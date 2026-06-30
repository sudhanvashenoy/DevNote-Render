const express = require('express');
const router = express.Router();
const { authMiddleware } = require('./auth');
const gdrive = require('./services/gdrive');
const sync = require('./services/sync');

// Current sync status — connection, last push/pull, pending changes, errors
router.get('/sync/status', authMiddleware, (req, res) => {
  const cfg = gdrive.readSyncConfig();
  res.json({
    ...sync.getState(),
    hasCredentials: !!(cfg.clientId && cfg.clientSecret),
    accountConnected: !!cfg.refreshToken,
    connectedAt: cfg.connectedAt || null,
  });
});

// Save Google OAuth Client ID/Secret (from user's own Google Cloud project)
router.post('/sync/credentials', authMiddleware, (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'Client ID and Secret required' });
  const cfg = gdrive.readSyncConfig();
  cfg.clientId = clientId.trim();
  cfg.clientSecret = clientSecret.trim();
  gdrive.writeSyncConfig(cfg);
  res.json({ message: 'Credentials saved' });
});

// Returns the Google consent URL to open in a browser tab
router.get('/sync/auth-url', authMiddleware, (req, res) => {
  try {
    res.json({ url: gdrive.getAuthUrl(req) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// OAuth redirect target — Google sends the user here after consent (no auth middleware; browser redirect)
router.get('/sync/oauth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#0f0f11;color:#e8e8f0">Google sign-in was cancelled or failed (${error}). You can close this tab.</body></html>`);
  try {
    await gdrive.exchangeCode(code, req);
    res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#0f0f11;color:#e8e8f0">✅ Google Drive connected. You can close this tab and return to KnowBase.<script>setTimeout(()=>window.close(),1500)</script></body></html>`);
  } catch (e) {
    res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#0f0f11;color:#f87171">Connection failed: ${e.message}. You can close this tab and try again.</body></html>`);
  }
});

router.post('/sync/disconnect', authMiddleware, (req, res) => {
  gdrive.disconnect();
  res.json({ message: 'Disconnected' });
});

router.post('/sync/auto-toggle', authMiddleware, (req, res) => {
  sync.setAutoSync(!!req.body.enabled);
  res.json(sync.getState());
});

router.post('/sync/push', authMiddleware, async (req, res) => {
  try {
    const result = await sync.push();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/sync/pull', authMiddleware, async (req, res) => {
  try {
    const result = await sync.pull();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
