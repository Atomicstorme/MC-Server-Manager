// World/full-server backups as zip files, with restore and retention.
const fs = require('fs');
const path = require('path');
const { createZip, extractZip } = require('./zip');

// Folders never worth backing up in a "full" backup: regenerated or huge.
const FULL_EXCLUDE = ['cache', 'libraries', 'versions', 'logs', 'crash-reports', 'bluemap', 'plugins/spark/tmp', '.paper-remapped'];

function backupDir(server) {
  if (server.backup.dir) return server.backup.dir;
  return path.join(path.dirname(server.dir), `${path.basename(server.dir)}-backups`);
}

function readProp(dir, key) {
  try {
    const text = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// The level folder plus Bukkit's split _nether/_the_end folders if present.
function worldFolders(dir) {
  const level = readProp(dir, 'level-name') || 'world';
  return [level, `${level}_nether`, `${level}_the_end`].filter((f) => fs.existsSync(path.join(dir, f)));
}

function listBackups(server) {
  const dir = backupDir(server);
  let all = [];
  try { all = fs.readdirSync(dir); } catch { return []; }
  // A .part older than an hour is a backup interrupted by a crash or quit.
  for (const f of all.filter((n) => n.endsWith('.zip.part'))) {
    const p = path.join(dir, f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 3600 * 1000) fs.rmSync(p, { force: true }); } catch { /* in use */ }
  }
  const files = all.filter((f) => f.endsWith('.zip'));
  return files
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      const scope = name.includes('_full_') ? 'full' : 'worlds';
      const auto = name.includes('_auto');
      return { name, path: path.join(dir, name), size: st.size, created: st.mtimeMs, scope, auto };
    })
    .sort((a, b) => b.created - a.created);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// proc: the ServerProcess, used to pause world saving while zipping so the
// region files are consistent.
async function createBackup(server, proc, { scope = 'worlds', auto = false, note = '', onProgress } = {}) {
  const running = proc && proc.status === 'running';
  const label = note ? `_${note.replace(/[^\w-]+/g, '-').slice(0, 40)}` : '';
  const name = `${stamp()}_${scope}${auto ? '_auto' : ''}${label}.zip`;
  const dest = path.join(backupDir(server), name);

  let entries;
  if (scope === 'full') {
    entries = fs.readdirSync(server.dir).map((f) => ({ abs: path.join(server.dir, f), rel: f }));
  } else {
    entries = worldFolders(server.dir).map((f) => ({ abs: path.join(server.dir, f), rel: f }));
    if (!entries.length) throw new Error('No world folder found to back up.');
  }

  if (running) {
    proc.log(`Backup started (${scope}); pausing world saves.`, 'system', 'manager');
    proc.write('save-off');
    proc.write('save-all flush');
    await new Promise((r) => setTimeout(r, 5000));
  }
  try {
    const exclude = scope === 'full' ? [...FULL_EXCLUDE] : [];
    const rel = path.relative(server.dir, backupDir(server));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) exclude.push(rel.split(path.sep).join('/'));
    const result = await createZip(dest, entries, { onProgress, exclude });
    if (proc && result.skipped.length) {
      proc.log(`Backup skipped ${result.skipped.length} file(s) locked by the running server: ${result.skipped.slice(0, 5).join(', ')}${result.skipped.length > 5 ? ', …' : ''}`, 'warn', 'manager');
    }
    if (running) proc.log(`Backup saved: ${name}`, 'system', 'manager');
    return { name, ...result };
  } finally {
    if (running) proc.write('save-on');
  }
}

// Removes old automatic backups beyond `keep`. Manual backups are kept.
function pruneBackups(server) {
  const keep = Math.max(1, server.backup.keep || 10);
  const autos = listBackups(server).filter((b) => b.auto);
  for (const b of autos.slice(keep)) fs.rmSync(b.path, { force: true });
}

// Restoring replaces the folders contained in the zip. The current versions
// are moved aside first so a bad restore can be undone by hand.
async function restoreBackup(server, file, onProgress) {
  const tmp = path.join(server.dir, `.restore-${Date.now()}`);
  await extractZip(file, tmp, { onProgress });
  const aside = path.join(backupDir(server), `pre-restore-${stamp()}`);
  try {
    for (const entry of fs.readdirSync(tmp)) {
      const target = path.join(server.dir, entry);
      if (fs.existsSync(target)) {
        fs.mkdirSync(aside, { recursive: true });
        fs.renameSync(target, path.join(aside, entry));
      }
      fs.renameSync(path.join(tmp, entry), target);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { movedAsideTo: fs.existsSync(aside) ? aside : null };
}

function deleteBackup(server, name) {
  const file = path.join(backupDir(server), path.basename(name));
  fs.rmSync(file, { force: true });
}

module.exports = { listBackups, createBackup, restoreBackup, deleteBackup, pruneBackups, backupDir, worldFolders };
