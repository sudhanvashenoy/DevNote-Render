// Minimal Google Drive client built on native fetch — no external SDK needed.
// Uses OAuth 2.0 "installed app" flow with a loopback redirect handled by our own Express server.
const fs = require('fs');
const path = require('path');
const db = require('../db');

const SYNC_CONFIG_FILE = path.join(db.DATA_DIR, 'sync-config.json');
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

function readSyncConfig() {
  let cfg = {};
  if (fs.existsSync(SYNC_CONFIG_FILE)) {
    try { cfg = JSON.parse(fs.readFileSync(SYNC_CONFIG_FILE, 'utf8')); } catch { cfg = {}; }
  }
  // On hosts with an ephemeral filesystem (e.g. Render free tier), the local
  // sync-config.json is wiped on every restart. If env vars are set, they
  // act as the durable source of truth and take priority over the file,
  // so the app reconnects to Drive automatically instead of losing the
  // connection on every cold start.
  if (process.env.GDRIVE_CLIENT_ID) cfg.clientId = process.env.GDRIVE_CLIENT_ID;
  if (process.env.GDRIVE_CLIENT_SECRET) cfg.clientSecret = process.env.GDRIVE_CLIENT_SECRET;
  if (process.env.GDRIVE_REFRESH_TOKEN) {
    cfg.refreshToken = process.env.GDRIVE_REFRESH_TOKEN;
    cfg.connected = true;
  }
  return cfg;
}
function writeSyncConfig(cfg) {
  fs.writeFileSync(SYNC_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getRedirectUri(req) {
  // Loopback redirect — works for any host/port the app happens to run on
  const host = req?.headers?.host || `localhost:${process.env.PORT || 3333}`;
  return `http://${host}/api/sync/oauth/callback`;
}

function getAuthUrl(req) {
  const cfg = readSyncConfig();
  if (!cfg.clientId) throw new Error('Google Client ID not configured');
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: getRedirectUri(req),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode(code, req) {
  const cfg = readSyncConfig();
  const params = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: getRedirectUri(req),
    grant_type: 'authorization_code',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'OAuth exchange failed');
  cfg.refreshToken = d.refresh_token || cfg.refreshToken;
  cfg.accessToken = d.access_token;
  cfg.accessTokenExpiry = Date.now() + (d.expires_in || 3600) * 1000 - 60000;
  cfg.connected = true;
  cfg.connectedAt = cfg.connectedAt || new Date().toISOString();
  writeSyncConfig(cfg);
  return cfg;
}

async function ensureAccessToken() {
  const cfg = readSyncConfig();
  if (!cfg.refreshToken) throw new Error('not_connected');
  if (cfg.accessToken && cfg.accessTokenExpiry && Date.now() < cfg.accessTokenExpiry) return cfg.accessToken;
  const params = new URLSearchParams({
    refresh_token: cfg.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'Token refresh failed');
  cfg.accessToken = d.access_token;
  cfg.accessTokenExpiry = Date.now() + (d.expires_in || 3600) * 1000 - 60000;
  writeSyncConfig(cfg);
  return cfg.accessToken;
}

async function driveFetch(urlPath, opts = {}) {
  const token = await ensureAccessToken();
  const url = urlPath.startsWith('http') ? urlPath : `https://www.googleapis.com${urlPath}`;
  const headers = Object.assign({ Authorization: `Bearer ${token}` }, opts.headers || {});
  const r = await fetch(url, Object.assign({}, opts, { headers }));
  if (!r.ok) {
    let detail = '';
    try { detail = JSON.stringify(await r.json()); } catch {}
    throw new Error(`Drive API error ${r.status}: ${detail}`);
  }
  return r;
}

// Find a child file/folder by name under a given parent ('root' allowed)
async function findChild(name, parentId, isFolder) {
  const mime = isFolder ? " and mimeType='application/vnd.google-apps.folder'" : '';
  const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false${mime}`;
  const r = await driveFetch(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime,size)&spaces=drive`);
  const d = await r.json();
  return d.files && d.files[0];
}

async function ensureFolder(name, parentId) {
  const existing = await findChild(name, parentId, true);
  if (existing) return existing.id;
  const r = await driveFetch('/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  const d = await r.json();
  return d.id;
}

// Ensure nested folder path (array of segment names) exists under root sync folder, returns final folder id
async function ensureFolderPath(rootId, segments) {
  let parent = rootId;
  for (const seg of segments) {
    parent = await ensureFolder(seg, parent);
  }
  return parent;
}

async function ensureRootSyncFolder() {
  const existing = await findChild('KnowBase-Sync', 'root', true);
  if (existing) return existing.id;
  const r = await driveFetch('/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'KnowBase-Sync', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }),
  });
  const d = await r.json();
  return d.id;
}

function buildMultipart(metadata, fileBuffer, mimeType) {
  const boundary = '-------knowbase' + Date.now();
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(head, 'utf8'), fileBuffer, Buffer.from(tail, 'utf8')]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

// Upload (create or update) a file. Returns { id, modifiedTime }
async function uploadFile(localPath, parentId, name, existingId) {
  const fileBuffer = fs.readFileSync(localPath);
  const metadata = existingId ? { name } : { name, parents: [parentId] };
  const { body, contentType } = buildMultipart(metadata, fileBuffer);
  const urlPath = existingId
    ? `/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,modifiedTime`
    : `/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime`;
  const r = await driveFetch(urlPath, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
  return r.json();
}

async function downloadFile(fileId, destPath) {
  const r = await driveFetch(`/drive/v3/files/${fileId}?alt=media`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
}

async function deleteFile(fileId) {
  try {
    await driveFetch(`/drive/v3/files/${fileId}`, { method: 'DELETE' });
  } catch (e) {
    // If it's already gone (404-ish), treat as success — nothing left to delete
    if (!/404/.test(e.message)) throw e;
  }
}

// Recursively list all files (not folders) under a Drive folder id.
// Returns array of { id, name, modifiedTime, relPath } where relPath is relative to the root folder.
async function listFolderRecursive(folderId, relPath = '') {
  let results = [];
  let pageToken;
  do {
    const q = `'${folderId}' in parents and trashed=false`;
    const params = new URLSearchParams({ q, fields: 'nextPageToken, files(id,name,mimeType,modifiedTime)', pageSize: '1000' });
    if (pageToken) params.set('pageToken', pageToken);
    const r = await driveFetch(`/drive/v3/files?${params.toString()}`);
    const d = await r.json();
    for (const f of d.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        const sub = await listFolderRecursive(f.id, path.join(relPath, f.name));
        results = results.concat(sub);
      } else {
        results.push({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, relPath: path.join(relPath, f.name) });
      }
    }
    pageToken = d.nextPageToken;
  } while (pageToken);
  return results;
}

async function testConnection() {
  await ensureAccessToken();
  const r = await driveFetch('/drive/v3/about?fields=user');
  return r.json();
}

function isConnected() {
  const cfg = readSyncConfig();
  return !!(cfg.clientId && cfg.clientSecret && cfg.refreshToken);
}

function disconnect() {
  const cfg = readSyncConfig();
  delete cfg.refreshToken; delete cfg.accessToken; delete cfg.accessTokenExpiry;
  cfg.connected = false;
  writeSyncConfig(cfg);
}

module.exports = {
  SYNC_CONFIG_FILE,
  readSyncConfig, writeSyncConfig,
  getAuthUrl, exchangeCode, ensureAccessToken,
  ensureRootSyncFolder, ensureFolderPath, ensureFolder, findChild,
  uploadFile, downloadFile, deleteFile, listFolderRecursive,
  testConnection, isConnected, disconnect,
};
