const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const CryptoJS = require('crypto-js');

const db = require('./db');
const { generateToken, authMiddleware, hashPassword, verifyPassword, isSetup } = require('./auth');

if (process.env.NODE_ENV === 'production' && !process.env.VAULT_KEY) {
  console.error('\n❌ VAULT_KEY environment variable is not set.');
  console.error('   Set a strong, random VAULT_KEY before running in production (see .env.example).\n');
  process.exit(1);
}
const VAULT_KEY = process.env.VAULT_KEY || 'knowbase-vault-encryption-key-change-in-prod';

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(db.UPLOAD_DIR, file.fieldname === 'image' ? 'images' : 'docs');
    fs.mkdirSync(dir, { recursive: true }); cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── SETUP & AUTH ─────────────────────────────────────────────────────────────
router.get('/status', (req, res) => res.json({ setup: isSetup() }));

router.post('/setup', (req, res) => {
  if (isSetup()) return res.status(400).json({ error: 'Already configured' });
  const { password, appName } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  db.config.set({ masterHash: hashPassword(password), appName: appName || 'KnowBase', sessionTimeout: 60, createdAt: new Date().toISOString() });
  db.categories.save([
    { id: uuidv4(), name: 'General', color: '#6366f1', protected: false, passwordHash: null, createdAt: new Date().toISOString() },
    { id: uuidv4(), name: 'DevOps & Code', color: '#10b981', protected: false, passwordHash: null, createdAt: new Date().toISOString() },
    { id: uuidv4(), name: 'Personal', color: '#f59e0b', protected: true, passwordHash: hashPassword(password), createdAt: new Date().toISOString() },
  ]);
  db.docCategories.save([
    { id: uuidv4(), name: 'General', color: '#6366f1', protected: false, passwordHash: null, createdAt: new Date().toISOString() },
    { id: uuidv4(), name: 'Contracts', color: '#ef4444', protected: true, passwordHash: hashPassword(password), createdAt: new Date().toISOString() },
    { id: uuidv4(), name: 'References', color: '#10b981', protected: false, passwordHash: null, createdAt: new Date().toISOString() },
  ]);
  res.json({ message: 'Setup complete' });
});

router.post('/login', (req, res) => {
  if (!isSetup()) return res.status(400).json({ error: 'Not setup yet' });
  const { password } = req.body;
  const config = db.config.get();
  if (!verifyPassword(password, config.masterHash)) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: generateToken({ role: 'admin' }), appName: config.appName, sessionTimeout: config.sessionTimeout || 60 });
});

router.post('/change-password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const config = db.config.get();
  if (!verifyPassword(currentPassword, config.masterHash)) return res.status(401).json({ error: 'Current password is wrong' });
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password too short' });
  db.config.set({ ...config, masterHash: hashPassword(newPassword) });
  res.json({ message: 'Password changed' });
});

router.get('/config', authMiddleware, (req, res) => {
  const { masterHash, ...safe } = db.config.get();
  res.json(safe);
});

router.post('/config', authMiddleware, (req, res) => {
  const config = db.config.get();
  const { sessionTimeout, appName } = req.body;
  db.config.set({ ...config, ...(sessionTimeout && { sessionTimeout }), ...(appName && { appName }) });
  res.json({ message: 'Config updated' });
});

router.post('/verify-password', authMiddleware, (req, res) => {
  const config = db.config.get();
  if (!verifyPassword(req.body.password, config.masterHash)) return res.status(401).json({ error: 'Wrong password' });
  res.json({ verified: true });
});

// ── ARTICLE CATEGORIES ───────────────────────────────────────────────────────
router.get('/categories', authMiddleware, (req, res) => {
  res.json(db.categories.all().map(c => ({ ...c, passwordHash: undefined, hasPassword: c.protected })));
});
router.post('/categories', authMiddleware, (req, res) => {
  const { name, color, protected: p, password } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const cat = { id: uuidv4(), name, color: color||'#6366f1', protected: !!p, passwordHash: p&&password?hashPassword(password):null, createdAt: new Date().toISOString() };
  db.categories.create(cat);
  res.json({ ...cat, passwordHash: undefined, hasPassword: cat.protected });
});
router.put('/categories/:id', authMiddleware, (req, res) => {
  const { name, color, protected: p, password } = req.body;
  const updates = { name, color, protected: !!p };
  if (p && password) updates.passwordHash = hashPassword(password);
  if (!p) updates.passwordHash = null;
  db.categories.update(req.params.id, updates);
  res.json({ message: 'Updated' });
});
router.delete('/categories/:id', authMiddleware, (req, res) => {
  db.categories.delete(req.params.id);
  db.articles.save(db.articles.all().filter(a => a.categoryId !== req.params.id));
  res.json({ message: 'Deleted' });
});
router.post('/categories/:id/unlock', authMiddleware, (req, res) => {
  const cat = db.categories.find(req.params.id);
  if (!cat) return res.status(404).json({ error: 'Not found' });
  if (!cat.protected || !cat.passwordHash) return res.json({ unlocked: true });
  if (!verifyPassword(req.body.password, cat.passwordHash)) return res.status(401).json({ error: 'Wrong password' });
  res.json({ unlocked: true, catToken: generateToken({ catId: req.params.id, type: 'category' }) });
});

// ── DOCUMENT CATEGORIES ──────────────────────────────────────────────────────
router.get('/doc-categories', authMiddleware, (req, res) => {
  res.json(db.docCategories.all().map(c => ({ ...c, passwordHash: undefined, hasPassword: c.protected })));
});
router.post('/doc-categories', authMiddleware, (req, res) => {
  const { name, color, protected: p, password } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const cat = { id: uuidv4(), name, color: color||'#6366f1', protected: !!p, passwordHash: p&&password?hashPassword(password):null, createdAt: new Date().toISOString() };
  db.docCategories.create(cat);
  res.json({ ...cat, passwordHash: undefined, hasPassword: cat.protected });
});
router.put('/doc-categories/:id', authMiddleware, (req, res) => {
  const { name, color, protected: p, password } = req.body;
  const updates = { name, color, protected: !!p };
  if (p && password) updates.passwordHash = hashPassword(password);
  if (!p) updates.passwordHash = null;
  db.docCategories.update(req.params.id, updates);
  res.json({ message: 'Updated' });
});
router.delete('/doc-categories/:id', authMiddleware, (req, res) => {
  db.docCategories.delete(req.params.id);
  db.documents.save(db.documents.all().map(d => d.categoryId === req.params.id ? { ...d, categoryId: '' } : d));
  res.json({ message: 'Deleted' });
});
router.post('/doc-categories/:id/unlock', authMiddleware, (req, res) => {
  const cat = db.docCategories.find(req.params.id);
  if (!cat) return res.status(404).json({ error: 'Not found' });
  if (!cat.protected || !cat.passwordHash) return res.json({ unlocked: true });
  if (!verifyPassword(req.body.password, cat.passwordHash)) return res.status(401).json({ error: 'Wrong password' });
  res.json({ unlocked: true, catToken: generateToken({ catId: req.params.id, type: 'doc-category' }) });
});

// ── ARTICLES ─────────────────────────────────────────────────────────────────
router.get('/articles', authMiddleware, (req, res) => {
  const { categoryId, search, tag, pinned, status } = req.query;
  let arts = db.articles.all();
  if (categoryId) arts = arts.filter(a => a.categoryId === categoryId);
  if (pinned === 'true') arts = arts.filter(a => a.pinned);
  if (tag) arts = arts.filter(a => (a.tags||[]).includes(tag));
  if (status) arts = arts.filter(a => (a.status||'published') === status);
  if (search) {
    const q = search.toLowerCase();
    arts = arts.filter(a => a.title.toLowerCase().includes(q) || (a.content||'').replace(/<[^>]*>/g,'').toLowerCase().includes(q) || (a.tags||[]).some(t => t.toLowerCase().includes(q)));
  }
  res.json(arts.map(a => ({ ...a, content: undefined, contentPreview: (a.content||'').replace(/<[^>]*>/g,'').slice(0,160) })));
});

router.get('/articles/tags', authMiddleware, (req, res) => {
  const tagMap = {};
  db.articles.all().forEach(a => (a.tags||[]).forEach(t => { tagMap[t] = (tagMap[t]||0) + 1; }));
  res.json(Object.entries(tagMap).map(([tag, count]) => ({ tag, count })).sort((a,b) => b.count - a.count));
});

router.get('/articles/:id', authMiddleware, (req, res) => {
  const art = db.articles.find(req.params.id);
  if (!art) return res.status(404).json({ error: 'Not found' });
  const cat = db.categories.find(art.categoryId);
  if (cat && cat.protected) {
    const catToken = req.headers['x-cat-token'];
    if (!catToken) return res.status(403).json({ error: 'Category locked', catId: art.categoryId });
    try {
      const p = require('jsonwebtoken').verify(catToken, process.env.JWT_SECRET || 'knowbase-super-secret-change-in-prod');
      if (p.catId !== art.categoryId) return res.status(403).json({ error: 'Wrong category token' });
    } catch { return res.status(403).json({ error: 'Category locked', catId: art.categoryId }); }
  }
  db.recentlyViewed.push(req.params.id);
  res.json(art);
});

router.post('/articles', authMiddleware, (req, res) => {
  const { title, content, categoryId, tags, pinned, status } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const art = { id: uuidv4(), title, content: content||'', categoryId: categoryId||'', tags: tags||[], pinned: !!pinned, status: status||'published', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  db.articles.create(art);
  // Save initial revision
  db.revisions.create({ id: uuidv4(), articleId: art.id, title: art.title, content: art.content, savedAt: art.createdAt, createdAt: art.createdAt });
  res.json(art);
});

router.put('/articles/:id', authMiddleware, (req, res) => {
  const { title, content, categoryId, tags, pinned, status } = req.body;
  const existing = db.articles.find(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  // Save revision before updating
  db.revisions.create({ id: uuidv4(), articleId: req.params.id, title: existing.title, content: existing.content, savedAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  db.revisions.pruneForArticle(req.params.id, 20);
  db.articles.update(req.params.id, { title, content, categoryId, tags, pinned, status: status||'published' });
  res.json(db.articles.find(req.params.id));
});

router.delete('/articles/:id', authMiddleware, (req, res) => {
  db.articles.delete(req.params.id);
  db.revisions.save(db.revisions.all().filter(r => r.articleId !== req.params.id));
  res.json({ message: 'Deleted' });
});

// Bulk operations
router.post('/articles/bulk', authMiddleware, (req, res) => {
  const { ids, action, categoryId } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'No IDs' });
  if (action === 'delete') {
    ids.forEach(id => db.articles.delete(id));
    res.json({ message: `Deleted ${ids.length} articles` });
  } else if (action === 'move' && categoryId !== undefined) {
    ids.forEach(id => db.articles.update(id, { categoryId }));
    res.json({ message: `Moved ${ids.length} articles` });
  } else if (action === 'status' && req.body.status) {
    ids.forEach(id => db.articles.update(id, { status: req.body.status }));
    res.json({ message: `Updated ${ids.length} articles` });
  } else {
    res.status(400).json({ error: 'Invalid action' });
  }
});

// Revisions
router.get('/articles/:id/revisions', authMiddleware, (req, res) => {
  res.json(db.revisions.forArticle(req.params.id).map(r => ({ ...r, content: undefined, contentPreview: (r.content||'').replace(/<[^>]*>/g,'').slice(0,100) })));
});
router.get('/articles/:id/revisions/:revId', authMiddleware, (req, res) => {
  const rev = db.revisions.find(req.params.revId);
  if (!rev || rev.articleId !== req.params.id) return res.status(404).json({ error: 'Not found' });
  res.json(rev);
});
router.post('/articles/:id/revisions/:revId/restore', authMiddleware, (req, res) => {
  const rev = db.revisions.find(req.params.revId);
  if (!rev) return res.status(404).json({ error: 'Not found' });
  const existing = db.articles.find(req.params.id);
  db.revisions.create({ id: uuidv4(), articleId: req.params.id, title: existing.title, content: existing.content, savedAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  db.articles.update(req.params.id, { title: rev.title, content: rev.content });
  res.json({ message: 'Restored' });
});

// Image upload
router.post('/upload/image', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/images/${req.file.filename}` });
});

// ── DOCUMENTS ────────────────────────────────────────────────────────────────
router.get('/documents', authMiddleware, (req, res) => {
  const { search, tag, categoryId } = req.query;
  let docs = db.documents.all();
  if (categoryId) docs = docs.filter(d => d.categoryId === categoryId);
  if (tag) docs = docs.filter(d => (d.tags||[]).includes(tag));
  if (search) { const q = search.toLowerCase(); docs = docs.filter(d => d.name.toLowerCase().includes(q) || (d.description||'').toLowerCase().includes(q) || (d.tags||[]).some(t => t.toLowerCase().includes(q))); }
  res.json(docs);
});
router.post('/documents/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { name, description, tags, categoryId } = req.body;
  const doc = { id: uuidv4(), name: name||req.file.originalname, description: description||'', tags: tags?JSON.parse(tags):[], categoryId: categoryId||'', filename: req.file.filename, originalName: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size, filePath: req.file.path, url: `/uploads/docs/${req.file.filename}`, createdAt: new Date().toISOString() };
  db.documents.create(doc);
  res.json(doc);
});
router.put('/documents/:id', authMiddleware, (req, res) => {
  db.documents.update(req.params.id, req.body);
  res.json(db.documents.find(req.params.id));
});
router.delete('/documents/:id', authMiddleware, (req, res) => {
  db.documents.delete(req.params.id);
  res.json({ message: 'Deleted' });
});
router.post('/documents/bulk', authMiddleware, (req, res) => {
  const { ids, action, categoryId } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'No IDs' });
  if (action === 'delete') { ids.forEach(id => db.documents.delete(id)); res.json({ message: `Deleted ${ids.length}` }); }
  else if (action === 'move') { ids.forEach(id => db.documents.update(id, { categoryId: categoryId||'' })); res.json({ message: `Moved ${ids.length}` }); }
  else res.status(400).json({ error: 'Invalid action' });
});

// ── QUICK NOTES ──────────────────────────────────────────────────────────────
router.get('/notes', authMiddleware, (req, res) => res.json(db.notes.get()));
router.post('/notes', authMiddleware, (req, res) => {
  db.notes.set({ content: req.body.content || '' });
  res.json({ message: 'Saved' });
});

// ── VAULT ────────────────────────────────────────────────────────────────────
router.get('/vault', authMiddleware, (req, res) => {
  const { search, group } = req.query;
  let entries = db.vault.all().map(v => ({ ...v, password: v.password?'••••••••':'', secret: v.secret?'••••••••':'' }));
  if (search) { const q = search.toLowerCase(); entries = entries.filter(e => e.title.toLowerCase().includes(q) || (e.username||'').toLowerCase().includes(q) || (e.group||'').toLowerCase().includes(q)); }
  if (group) entries = entries.filter(e => e.group === group);
  res.json(entries);
});
router.get('/vault/:id/reveal', authMiddleware, (req, res) => {
  const entry = db.vault.find(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const dec = v => { if (!v) return ''; try { return CryptoJS.AES.decrypt(v, VAULT_KEY).toString(CryptoJS.enc.Utf8)||v; } catch { return v; } };
  res.json({ ...entry, password: dec(entry.password), secret: dec(entry.secret) });
});
router.post('/vault', authMiddleware, (req, res) => {
  const { title, username, password, secret, url, notes, group, type } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const enc = v => v ? CryptoJS.AES.encrypt(v, VAULT_KEY).toString() : '';
  const entry = { id: uuidv4(), title, username: username||'', url: url||'', notes: notes||'', group: group||'General', type: type||'password', password: enc(password), secret: enc(secret), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  db.vault.create(entry);
  res.json({ ...entry, password: '••••••••', secret: '••••••••' });
});
router.put('/vault/:id', authMiddleware, (req, res) => {
  const { title, username, password, secret, url, notes, group, type } = req.body;
  const enc = v => v ? CryptoJS.AES.encrypt(v, VAULT_KEY).toString() : '';
  const updates = { title, username, url, notes, group, type };
  if (password && password !== '••••••••') updates.password = enc(password);
  if (secret && secret !== '••••••••') updates.secret = enc(secret);
  db.vault.update(req.params.id, updates);
  res.json({ message: 'Updated' });
});
router.delete('/vault/:id', authMiddleware, (req, res) => {
  db.vault.delete(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── RECENTLY VIEWED ──────────────────────────────────────────────────────────
router.get('/recently-viewed', authMiddleware, (req, res) => {
  const ids = db.recentlyViewed.get();
  const arts = ids.map(id => db.articles.find(id)).filter(Boolean)
    .map(a => ({ ...a, content: undefined, contentPreview: (a.content||'').replace(/<[^>]*>/g,'').slice(0,120) }));
  res.json(arts);
});

// ── SEARCH ───────────────────────────────────────────────────────────────────
router.get('/search', authMiddleware, (req, res) => {
  const { q, type, categoryId, tag, docCategoryId, status } = req.query;
  if (!q?.trim()) return res.json({ articles: [], documents: [], total: 0 });
  const query = q.toLowerCase().trim();
  const terms = query.split(/\s+/);
  const score = (text, terms) => { if (!text) return 0; const t = text.toLowerCase(); return terms.reduce((s, term) => s + (t.includes(term) ? (t.startsWith(term)?3:1) : 0), 0); };

  let articles = [];
  if (!type || type === 'articles') {
    articles = db.articles.all()
      .map(a => { const plain = (a.content||'').replace(/<[^>]*>/g,''); const sc = score(a.title,terms)*3 + score(plain,terms) + terms.reduce((s,t) => s+((a.tags||[]).some(tg=>tg.toLowerCase().includes(t))?2:0),0); return { ...a, score: sc, content: undefined, contentPreview: plain.slice(0,200) }; })
      .filter(a => a.score > 0)
      .filter(a => !categoryId || a.categoryId === categoryId)
      .filter(a => !tag || (a.tags||[]).includes(tag))
      .filter(a => !status || (a.status||'published') === status)
      .sort((a,b) => b.score - a.score);
  }
  let documents = [];
  if (!type || type === 'documents') {
    documents = db.documents.all()
      .map(d => { const sc = score(d.name,terms)*3 + score(d.description,terms) + terms.reduce((s,t) => s+((d.tags||[]).some(tg=>tg.toLowerCase().includes(t))?2:0),0); return { ...d, score: sc }; })
      .filter(d => d.score > 0)
      .filter(d => !docCategoryId || d.categoryId === docCategoryId)
      .sort((a,b) => b.score - a.score);
  }
  res.json({ articles, documents, total: articles.length + documents.length });
});

// ── STATS ────────────────────────────────────────────────────────────────────
router.get('/stats', authMiddleware, (req, res) => {
  const arts = db.articles.all();
  res.json({
    articles: arts.length,
    documents: db.documents.all().length,
    categories: db.categories.all().length,
    docCategories: db.docCategories.all().length,
    vault: db.vault.all().length,
    pinned: arts.filter(a => a.pinned).length,
    drafts: arts.filter(a => a.status === 'draft').length,
    tags: [...new Set(arts.flatMap(a => a.tags||[]))].length,
  });
});

module.exports = router;
