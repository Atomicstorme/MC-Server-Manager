// Zip creation (archiver) and extraction/reading (yauzl).
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const yauzl = require('yauzl');

const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);

// Lists files under entries, dropping excluded paths and files another
// process holds locked. A running server locks some files on Windows
// (session.lock, plugin H2/SQLite databases), and one unreadable file must
// not fail the whole backup.
function collectFiles(entries, exclude) {
  const files = [];
  const skipped = [];
  const excluded = (rel) => rel.endsWith('session.lock') || exclude.some((e) => rel === e || rel.startsWith(e + '/'));
  const visit = (abs, rel) => {
    if (excluded(rel)) return;
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) visit(path.join(abs, name), `${rel}/${name}`);
      return;
    }
    try {
      // Reading a byte catches range locks, which open() alone does not.
      const fd = fs.openSync(abs, 'r');
      try { fs.readSync(fd, Buffer.alloc(1), 0, 1, 0); } finally { fs.closeSync(fd); }
      files.push({ abs, rel, stats: st });
    } catch (err) {
      if (!LOCKED.has(err.code)) throw err;
      skipped.push(rel);
    }
  };
  for (const { abs, rel } of entries) visit(abs, rel);
  return { files, skipped };
}

// entries: [{ abs, rel }] where rel is the path inside the archive. Folders
// are added recursively. Resolves { path, size, skipped }.
function createZip(dest, entries, { onProgress, exclude = [] } = {}) {
  const { files, skipped } = collectFiles(entries, exclude);
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = dest + '.part';
    const output = fs.createWriteStream(part);
    const archive = archiver('zip', { zlib: { level: 6 } });
    let failed = null;
    output.on('close', () => {
      // The stream must be closed before Windows lets us delete or rename it.
      if (failed) { fs.rmSync(part, { force: true }); reject(failed); return; }
      fs.renameSync(part, dest);
      resolve({ path: dest, size: archive.pointer(), skipped });
    });
    const fail = (err) => {
      if (failed) return;
      failed = err;
      archive.abort();
      output.destroy();
    };
    output.on('error', fail);
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') console.warn(err); });
    archive.on('error', fail);
    if (onProgress) archive.on('progress', (p) => onProgress(p.fs));
    archive.pipe(output);
    for (const f of files) archive.file(f.abs, { name: f.rel, stats: f.stats });
    archive.finalize();
  });
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

// Extracts every entry into destDir, refusing paths that escape it.
async function extractZip(file, destDir, { onProgress } = {}) {
  const zip = await openZip(file);
  const root = path.resolve(destDir);
  let done = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        const target = path.resolve(root, entry.fileName);
        if (target !== root && !target.startsWith(root + path.sep)) {
          reject(new Error(`Unsafe path in archive: ${entry.fileName}`));
          return;
        }
        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(target, { recursive: true });
          zip.readEntry();
          return;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, (err, stream) => {
          if (err) { reject(err); return; }
          const out = fs.createWriteStream(target);
          out.on('close', () => {
            done += 1;
            if (onProgress) onProgress({ done, total: zip.entryCount });
            zip.readEntry();
          });
          out.on('error', reject);
          stream.pipe(out);
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

// Reads the first entry whose name is in `names` as text (e.g. plugin.yml
// inside a plugin jar). Returns { name, text } or null.
async function readEntryText(file, names) {
  const zip = await openZip(file);
  try {
    return await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', () => resolve(null));
      zip.on('entry', (entry) => {
        if (!names.includes(entry.fileName)) { zip.readEntry(); return; }
        zip.openReadStream(entry, (err, stream) => {
          if (err) { reject(err); return; }
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => resolve({ name: entry.fileName, text: Buffer.concat(chunks).toString('utf8') }));
          stream.on('error', reject);
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

module.exports = { createZip, extractZip, readEntryText };
