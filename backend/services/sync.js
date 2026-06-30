const fs = require('fs');
const path = require('path');
const db = require('../db');
const gdrive = require('./gdrive');

const MANIFEST_FILE = path.join(db.DATA_DIR, 'sync-manifest.json');
const SYNCED_DIRS = [
  { local: db.DATA_DIR, label: 'data' },
  { local: db.UPLOAD_DIR, label: 'uploads' },
  { local: db.WATCH_DIR, label: 'watch' },
];
// Files that must never leave this machine
const EXCLUDE_FILES = new Set(['sync-config.json', 'sync-manifest.json']);

let state = {
  status: 'idle', // idle | syncing | offline | error
  lastPush: null,
  lastPull: null,
  lastError: null,
  pendingChanges: false,
  autoSync: true,
};
let debounceTimer = null;
let retryInterval = null;
let syncing = false;

function readManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch { return {}; }
}
function writeManifest(m) { fs.writeFileSync(MANIFEST_FILE, JSON.stringify(m, null, 2)); }

function getState() {
  return { ...state, connected: gdrive.isConnected() };
}

function setState(patch) { state = { ...state, ...patch }; }

// Walk a local directory recursively, returns [{ relPath: 'data/articles.json', fullPath, mtimeMs }]
function walkDir(dir, baseLabel, relSoFar = '') {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'processed' && baseLabel === 'watch') continue; // skip already-imported watch files
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const rel = path.join(relSoFar, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walkDir(full, baseLabel, rel));
    } else {
      if (baseLabel === 'data' && EXCLUDE_FILES.has(entry.name)) continue;
      const stat = fs.statSync(full);
      out.push({ relPath: path.join(baseLabel, rel), fullPath: full, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

function isOnline() {
  return fetch('https://www.googleapis.com/generate_204', { method: 'GET', signal: AbortSignal.timeout(4000) })
    .then(() => true).catch(() => false);
}

// ── PUSH: walk local files, upload anything changed since manifest, to mirrored Drive folder structure ──
async function push() {
  if (syncing) return getState();
  if (!gdrive.isConnected()) throw new Error('not_connected');
  syncing = true; setState({ status: 'syncing', lastError: null });
  try {
    const online = await isOnline();
    if (!online) { setState({ status: 'offline', pendingChanges: true }); syncing = false; return getState(); }

    const rootId = await gdrive.ensureRootSyncFolder();
    const manifest = readManifest();
    const folderIdCache = { '': rootId };

    async function folderIdFor(relDir) {
      if (folderIdCache[relDir]) return folderIdCache[relDir];
      const segments = relDir.split(path.sep).filter(Boolean);
      const id = await gdrive.ensureFolderPath(rootId, segments);
      folderIdCache[relDir] = id;
      return id;
    }

    let allFiles = [];
    for (const dir of SYNCED_DIRS) allFiles = allFiles.concat(walkDir(dir.local, dir.label));
    const presentPaths = new Set(allFiles.map(f => f.relPath));

    let uploaded = 0;
    for (const f of allFiles) {
      const prev = manifest[f.relPath];
      if (prev && prev.mtimeMs === f.mtimeMs) continue; // unchanged
      const parentDir = path.dirname(f.relPath) === '.' ? '' : path.dirname(f.relPath);
      const parentId = await folderIdFor(parentDir);
      const name = path.basename(f.relPath);
      const driveId = prev?.driveId || (await gdrive.findChild(name, parentId, false))?.id;
      const result = await gdrive.uploadFile(f.fullPath, parentId, name, driveId);
      manifest[f.relPath] = { driveId: result.id, mtimeMs: f.mtimeMs, syncedAt: new Date().toISOString() };
      uploaded++;
    }

    // Anything that was synced before but no longer exists locally → delete from Drive too,
    // so Drive stays a true mirror instead of an ever-growing pile of orphaned files.
    let deleted = 0;
    const deleteFailures = [];
    for (const relPath of Object.keys(manifest)) {
      if (!presentPaths.has(relPath)) {
        const entry = manifest[relPath];
        if (entry?.driveId) {
          try {
            await gdrive.deleteFile(entry.driveId);
          } catch (e) {
            console.error(`Sync: failed to delete "${relPath}" (driveId ${entry.driveId}) from Drive:`, e.message);
            deleteFailures.push({ relPath, error: e.message });
            continue; // keep the manifest entry so we retry next push instead of losing track of it
          }
        }
        delete manifest[relPath];
        deleted++;
      }
    }

    writeManifest(manifest);
    const parts = [];
    if (uploaded) parts.push(`pushed ${uploaded} file(s)`);
    if (deleted) parts.push(`removed ${deleted} file(s)`);
    if (deleteFailures.length) parts.push(`${deleteFailures.length} deletion(s) failed`);
    db.activityLog.log('sync', 'system', parts.length ? parts.join(', ') + ' on Google Drive' : 'Push: everything already up to date');
    if (deleteFailures.length) {
      setState({ status: 'error', lastPush: new Date().toISOString(), lastError: `Failed to delete from Drive: ${deleteFailures.map(f => f.relPath).join(', ')}`, pendingChanges: true });
    } else {
      setState({ status: 'idle', lastPush: new Date().toISOString(), pendingChanges: false, lastError: null });
    }
    return { ...getState(), uploaded, deleted, deleteFailures };
  } catch (e) {
    setState({ status: 'error', lastError: e.message, pendingChanges: true });
    throw e;
  } finally {
    syncing = false;
  }
}

// ── PULL: download everything from Drive sync folder, overwriting local files ──
async function pull() {
  if (syncing) return getState();
  if (!gdrive.isConnected()) throw new Error('not_connected');
  syncing = true; setState({ status: 'syncing', lastError: null });
  try {
    const online = await isOnline();
    if (!online) { setState({ status: 'offline' }); syncing = false; throw new Error('offline'); }

    const rootId = await gdrive.ensureRootSyncFolder();
    const files = await gdrive.listFolderRecursive(rootId);
    const manifest = readManifest();
    const drivePaths = new Set(files.map(f => f.relPath));
    let downloaded = 0;
    for (const f of files) {
      // f.relPath like 'data/articles.json' or 'uploads/docs/x.pdf'
      const topDir = f.relPath.split(path.sep)[0];
      const dirCfg = SYNCED_DIRS.find(d => d.label === topDir);
      if (!dirCfg) continue;
      const rest = f.relPath.split(path.sep).slice(1).join(path.sep);
      const destPath = path.join(dirCfg.local, rest);
      await gdrive.downloadFile(f.id, destPath);
      const stat = fs.statSync(destPath);
      manifest[f.relPath] = { driveId: f.id, mtimeMs: stat.mtimeMs, syncedAt: new Date().toISOString() };
      downloaded++;
    }

    // Files we previously synced that are no longer in Drive (deleted from another machine) → remove locally too
    let removedLocally = 0;
    for (const relPath of Object.keys(manifest)) {
      if (!drivePaths.has(relPath)) {
        const topDir = relPath.split(path.sep)[0];
        const dirCfg = SYNCED_DIRS.find(d => d.label === topDir);
        if (dirCfg) {
          const rest = relPath.split(path.sep).slice(1).join(path.sep);
          const localPath = path.join(dirCfg.local, rest);
          if (fs.existsSync(localPath)) { try { fs.unlinkSync(localPath); removedLocally++; } catch {} }
        }
        delete manifest[relPath];
      }
    }

    writeManifest(manifest);
    const parts = [];
    if (downloaded) parts.push(`pulled ${downloaded} file(s)`);
    if (removedLocally) parts.push(`removed ${removedLocally} local file(s)`);
    db.activityLog.log('sync', 'system', parts.length ? parts.join(', ') + ' from Google Drive' : 'Pull: nothing new');
    setState({ status: 'idle', lastPull: new Date().toISOString(), lastError: null });
    return { ...getState(), downloaded, removedLocally };
  } catch (e) {
    setState({ status: 'error', lastError: e.message });
    throw e;
  } finally {
    syncing = false;
  }
}

// ── Auto-sync: debounced trigger fired whenever app data changes ──
function scheduleAutoSync() {
  if (!state.autoSync || !gdrive.isConnected()) return;
  setState({ pendingChanges: true });
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    push().catch(() => {}); // errors already captured in state
  }, 8000);
}

// Retry loop: if there are pending changes (e.g. we were offline), try again periodically
function startRetryLoop() {
  if (retryInterval) clearInterval(retryInterval);
  retryInterval = setInterval(() => {
    if (state.autoSync && state.pendingChanges && gdrive.isConnected() && !syncing) {
      push().catch(() => {});
    }
  }, 30000);
}

function setAutoSync(enabled) {
  setState({ autoSync: enabled });
  const cfg = gdrive.readSyncConfig();
  cfg.autoSync = enabled;
  gdrive.writeSyncConfig(cfg);
}

function init() {
  const cfg = gdrive.readSyncConfig();
  setState({ autoSync: cfg.autoSync !== false });
  db.setChangeListener(() => scheduleAutoSync());
  startRetryLoop();
}

module.exports = { init, push, pull, getState, scheduleAutoSync, setAutoSync };
