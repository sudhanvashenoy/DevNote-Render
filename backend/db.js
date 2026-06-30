const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const WATCH_DIR = path.join(__dirname, '..', 'watch');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
[DATA_DIR, UPLOAD_DIR, WATCH_DIR, BACKUP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const FILES = {
  config: path.join(DATA_DIR, 'config.json'),
  categories: path.join(DATA_DIR, 'categories.json'),
  articles: path.join(DATA_DIR, 'articles.json'),
  docCategories: path.join(DATA_DIR, 'doc-categories.json'),
  documents: path.join(DATA_DIR, 'documents.json'),
  vault: path.join(DATA_DIR, 'vault.json'),
  notes: path.join(DATA_DIR, 'notes.json'),
  revisions: path.join(DATA_DIR, 'revisions.json'),
  recentlyViewed: path.join(DATA_DIR, 'recently-viewed.json'),
  activityLog: path.join(DATA_DIR, 'activity-log.json'),
};

function read(file) { if (!fs.existsSync(file)) return []; try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return []; } }
function readObj(file) { if (!fs.existsSync(file)) return {}; try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return {}; } }

let changeListener = null;
function setChangeListener(fn) { changeListener = fn; }
function notifyChange() { if (changeListener) { try { changeListener(); } catch {} } }

function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  if (path.basename(file) !== 'sync-config.json' && path.basename(file) !== 'sync-manifest.json') notifyChange();
}

function makeStore(file) {
  return {
    all: () => read(file),
    save: (data) => write(file, data),
    find: (id) => read(file).find(x => x.id === id),
    create: (item) => { const all = read(file); all.push(item); write(file, all); return item; },
    update: (id, updates) => { write(file, read(file).map(x => x.id === id ? { ...x, ...updates, updatedAt: new Date().toISOString() } : x)); },
    delete: (id) => write(file, read(file).filter(x => x.id !== id)),
  };
}

// Activity log helper
function logActivity(action, entity, detail) {
  try {
    const log = read(FILES.activityLog);
    log.unshift({ id: Date.now().toString(), action, entity, detail, timestamp: new Date().toISOString() });
    write(FILES.activityLog, log.slice(0, 500)); // keep last 500
  } catch {}
}

module.exports = {
  UPLOAD_DIR, WATCH_DIR, BACKUP_DIR, DATA_DIR,
  setChangeListener, notifyChange,
  config: { get: () => readObj(FILES.config), set: (data) => write(FILES.config, data) },
  categories: makeStore(FILES.categories),
  articles: makeStore(FILES.articles),
  docCategories: makeStore(FILES.docCategories),
  documents: {
    ...makeStore(FILES.documents),
    delete: (id) => {
      const doc = read(FILES.documents).find(d => d.id === id);
      if (doc?.filePath && fs.existsSync(doc.filePath)) { try { fs.unlinkSync(doc.filePath); } catch {} }
      write(FILES.documents, read(FILES.documents).filter(d => d.id !== id));
    },
  },
  vault: makeStore(FILES.vault),
  notes: {
    get: () => readObj(FILES.notes),
    set: (data) => write(FILES.notes, { ...data, updatedAt: new Date().toISOString() }),
  },
  revisions: {
    all: () => read(FILES.revisions),
    forArticle: (articleId) => read(FILES.revisions).filter(r => r.articleId === articleId).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)),
    create: (rev) => { const all = read(FILES.revisions); all.push(rev); write(FILES.revisions, all); return rev; },
    find: (id) => read(FILES.revisions).find(r => r.id === id),
    pruneForArticle: (articleId, keep=20) => {
      const all = read(FILES.revisions);
      const forArt = all.filter(r => r.articleId === articleId).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
      const toDelete = new Set(forArt.slice(keep).map(r => r.id));
      if (toDelete.size) write(FILES.revisions, all.filter(r => !toDelete.has(r.id)));
    },
    save: (data) => write(FILES.revisions, data),
  },
  recentlyViewed: {
    get: () => read(FILES.recentlyViewed),
    push: (articleId) => {
      let rv = read(FILES.recentlyViewed).filter(id => id !== articleId);
      rv.unshift(articleId);
      write(FILES.recentlyViewed, rv.slice(0, 10));
    },
  },
  activityLog: {
    all: () => read(FILES.activityLog),
    log: logActivity,
  },
};
