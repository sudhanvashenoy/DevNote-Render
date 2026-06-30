const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const db = require('../db');

function createBackup() {
  return new Promise((resolve, reject) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const outPath = path.join(db.BACKUP_DIR, `knowbase-backup-${timestamp}.zip`);
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => {
      db.activityLog.log('backup', 'system', `Backup created: ${path.basename(outPath)} (${(archive.pointer()/1024).toFixed(1)} KB)`);
      resolve({ path: outPath, filename: path.basename(outPath), size: archive.pointer() });
    });
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(db.DATA_DIR, 'data');
    archive.directory(db.UPLOAD_DIR, 'uploads');
    archive.finalize();
  });
}

function listBackups() {
  const dir = db.BACKUP_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.zip')).map(f => {
    const stat = fs.statSync(path.join(dir, f));
    return { filename: f, size: stat.size, created: stat.mtime.toISOString() };
  }).sort((a,b) => new Date(b.created) - new Date(a.created));
}

module.exports = { createBackup, listBackups };
