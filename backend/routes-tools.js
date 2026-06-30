const express = require('express');
const router = express.Router();
const { authMiddleware } = require('./auth');
const { createBackup, listBackups } = require('./services/backup');
const db = require('./db');
const path = require('path');
const fs = require('fs');

// ── TOOLS API (stateless, all processing server-side) ─────────────────────

// Hash generator
router.post('/tools/hash', authMiddleware, async (req, res) => {
  const { text, algorithm } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  const crypto = require('crypto');
  const algos = ['md5','sha1','sha256','sha512'];
  const results = {};
  const algoList = algorithm ? [algorithm] : algos;
  algoList.forEach(a => { try { results[a] = crypto.createHash(a).update(text).digest('hex'); } catch {} });
  res.json(results);
});

// UUID generator
router.post('/tools/uuid', authMiddleware, (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const count = Math.min(req.body.count || 5, 20);
  res.json({ uuids: Array.from({length: count}, () => uuidv4()) });
});

// Activity log
router.get('/activity', authMiddleware, (req, res) => {
  res.json(db.activityLog.all().slice(0, 100));
});

// Backup endpoints
router.post('/backup/create', authMiddleware, async (req, res) => {
  try {
    const result = await createBackup();
    res.json({ message: 'Backup created', ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/backup/list', authMiddleware, (req, res) => {
  res.json(listBackups());
});

router.get('/backup/download/:filename', authMiddleware, (req, res) => {
  const filePath = path.join(db.BACKUP_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.download(filePath);
});

router.delete('/backup/:filename', authMiddleware, (req, res) => {
  const filePath = path.join(db.BACKUP_DIR, path.basename(req.params.filename));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ message: 'Deleted' });
});

// Watch folder status
router.get('/watchfolder/status', authMiddleware, (req, res) => {
  const watchDir = db.WATCH_DIR;
  const files = fs.existsSync(watchDir) ? fs.readdirSync(watchDir).filter(f => !fs.statSync(path.join(watchDir, f)).isDirectory()) : [];
  res.json({ path: watchDir, pendingFiles: files.length, files });
});

// AI chat (Ollama)
router.post('/ai/chat', authMiddleware, async (req, res) => {
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  try {
    // Check if Ollama is running
    const checkRes = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    if (!checkRes.ok) throw new Error('Ollama not running');
    const tags = await checkRes.json();
    const model = tags.models?.[0]?.name || 'llama3.2';
    // Build system prompt with KB context
    const articles = db.articles.all().slice(0, 20);
    const kbContext = articles.map(a => `Title: ${a.title}\nTags: ${(a.tags||[]).join(', ')}\nPreview: ${(a.content||'').replace(/<[^>]*>/g,'').slice(0,200)}`).join('\n\n');
    const systemPrompt = `You are a helpful assistant for a personal knowledge base called KnowBase. Here are some of the user's articles for context:\n\n${kbContext}\n\nAnswer questions about the user's notes, help summarize content, or answer general questions.${context ? '\n\nAdditional context: '+context : ''}`;
    const aiRes = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ model, prompt: message, system: systemPrompt, stream: false }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await aiRes.json();
    res.json({ response: data.response, model });
  } catch(e) {
    if (e.message.includes('Ollama') || e.name === 'TimeoutError' || e.code === 'ECONNREFUSED') {
      res.status(503).json({ error: 'ollama_not_running', message: 'Ollama is not running. Install from ollama.com and run: ollama pull llama3.2' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

router.get('/ai/status', authMiddleware, async (req, res) => {
  try {
    const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    res.json({ running: true, models: data.models?.map(m => m.name) || [] });
  } catch {
    res.json({ running: false, models: [] });
  }
});

module.exports = router;

// ── WEBHOOK TESTER ────────────────────────────────────────────────────────────
const webhookStore = {}; // in-memory: { id: { requests: [], created } }

router.post('/webhook/create', authMiddleware, (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const id = uuidv4().slice(0, 8);
  webhookStore[id] = { id, requests: [], created: new Date().toISOString(), active: true };
  // Auto-cleanup after 2 hours
  setTimeout(() => { delete webhookStore[id]; }, 2 * 60 * 60 * 1000);
  res.json({ id, url: `/webhook/${id}` });
});

// Public webhook receiver - no auth needed (that's the point)
router.all('/webhook/:id', (req, res) => {
  const { id } = req.params;
  if (!webhookStore[id]) {
    return res.status(404).json({ error: 'Webhook endpoint not found or expired' });
  }
  const entry = {
    id: Date.now().toString(),
    method: req.method,
    headers: req.headers,
    body: req.body,
    query: req.query,
    ip: req.ip,
    timestamp: new Date().toISOString(),
  };
  webhookStore[id].requests.unshift(entry);
  webhookStore[id].requests = webhookStore[id].requests.slice(0, 50); // keep last 50
  res.json({ received: true, id: entry.id });
});

router.get('/webhook/:id/requests', authMiddleware, (req, res) => {
  const wh = webhookStore[req.params.id];
  if (!wh) return res.status(404).json({ error: 'Not found or expired' });
  res.json({ id: wh.id, requests: wh.requests, created: wh.created });
});

router.delete('/webhook/:id/requests', authMiddleware, (req, res) => {
  const wh = webhookStore[req.params.id];
  if (wh) wh.requests = [];
  res.json({ cleared: true });
});
