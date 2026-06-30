// One-time repair script: collapses the deeply nested watch/processed/processed/...
// folders caused by the old watcher bug back into a single flat watch/processed/
// folder, keeping every already-imported file. Safe to run multiple times.
const fs = require('fs');
const path = require('path');

const WATCH_DIR = path.join(__dirname, '..', '..', 'watch');
const FLAT_PROCESSED = path.join(WATCH_DIR, 'processed');

function collectFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else out.push(full);
  }
  return out;
}

function uniqueDestPath(destDir, name) {
  let dest = path.join(destDir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let i = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(destDir, `${base}-${i}${ext}`);
    i++;
  }
  return dest;
}

function main() {
  if (!fs.existsSync(WATCH_DIR)) {
    console.log('No watch/ directory found, nothing to do.');
    return;
  }
  fs.mkdirSync(FLAT_PROCESSED, { recursive: true });

  // Anything sitting directly inside watch/ (not yet processed) is left alone.
  // We only touch the processed/ subtree.
  const topProcessed = path.join(WATCH_DIR, 'processed');
  if (!fs.existsSync(topProcessed)) {
    console.log('No processed/ folder found, nothing to do.');
    return;
  }

  const files = collectFiles(topProcessed);
  let moved = 0;
  for (const f of files) {
    const dest = uniqueDestPath(FLAT_PROCESSED, path.basename(f));
    if (path.resolve(f) === path.resolve(dest)) continue; // already flat
    fs.renameSync(f, dest);
    moved++;
  }

  // Remove now-empty nested directories (deepest first)
  function removeEmptyDirs(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name));
    }
    if (dir !== FLAT_PROCESSED && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  }
  removeEmptyDirs(topProcessed);
  // Make sure the flat folder itself still exists after cleanup
  fs.mkdirSync(FLAT_PROCESSED, { recursive: true });

  console.log(`Done. Flattened ${moved} file(s) into watch/processed/.`);
}

main();
