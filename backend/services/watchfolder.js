const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

let watcher = null;

function startWatcher() {
  const watchDir = db.WATCH_DIR;
  if (watcher) watcher.close();
  // Ignore dotfiles AND the "processed" output folder itself — without this,
  // moving a file into processed/ re-triggers an 'add' event for that same
  // folder (since it's still inside the watched tree), which creates a new
  // nested processed/processed/... folder forever and fills the disk.
  watcher = chokidar.watch(watchDir, {
    ignored: (p) => {
      const rel = path.relative(watchDir, p);
      if (!rel) return false;
      const base = path.basename(p);
      if (base.startsWith('.')) return true;
      return rel.split(path.sep).includes('processed');
    },
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 1000 },
  });
  watcher.on('add', filePath => processFile(filePath));
  console.log(`Watch folder: ${watchDir}`);
}

function processFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath, ext);
  if (!['.md','.txt'].includes(ext)) return;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const htmlContent = ext === '.md' ? mdToHtml(content) : `<p>${content.replace(/\n/g,'</p><p>')}</p>`;
    if (!db.articles.all().find(a => a.title === name)) {
      db.articles.create({ id: uuidv4(), title: name, content: htmlContent, categoryId: '', tags: ['watch-folder'], pinned: false, status: 'published', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      db.activityLog.log('import', 'article', `Imported "${name}" from watch folder`);
    }
    const done = path.join(path.dirname(filePath), 'processed');
    fs.mkdirSync(done, { recursive: true });
    fs.renameSync(filePath, path.join(done, path.basename(filePath)));
  } catch(e) { console.error('Watch folder error:', e.message); }
}

function mdToHtml(md) {
  return md.replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/`(.+?)`/g,'<code>$1</code>').replace(/^- (.+)$/gm,'<li>$1</li>').replace(/\n\n/g,'</p><p>');
}

module.exports = { startWatcher };
