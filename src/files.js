// server.properties, player lists (ops/whitelist/bans) and a sandboxed
// text-file editor for config files inside the server folder.
const fs = require('fs');
const path = require('path');
const { getJson } = require('./net');

// --- server.properties ----------------------------------------------------

function propsPath(dir) { return path.join(dir, 'server.properties'); }

function unescapeProp(v) { return v.replace(/\\(.)/g, '$1'); }
function escapeProp(v) { return String(v).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/=/g, '\\='); }

function readProperties(dir) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(propsPath(dir), 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = unescapeProp(line.slice(i + 1));
  }
  return out;
}

// Rewrites only the changed keys, keeping comments and order intact.
function writeProperties(dir, patch) {
  let text = '';
  try { text = fs.readFileSync(propsPath(dir), 'utf8'); } catch { /* new file */ }
  const remaining = { ...patch };
  const lines = text.split(/\r?\n/).map((line) => {
    if (!line || line.startsWith('#')) return line;
    const i = line.indexOf('=');
    if (i < 0) return line;
    const key = line.slice(0, i).trim();
    if (!(key in remaining)) return line;
    const value = remaining[key];
    delete remaining[key];
    return `${key}=${escapeProp(value)}`;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(remaining)) lines.push(`${k}=${escapeProp(v)}`);
  fs.writeFileSync(propsPath(dir), lines.join('\n') + '\n');
}

function acceptEula(dir) {
  fs.writeFileSync(path.join(dir, 'eula.txt'), `#Accepted via MC Server Manager (https://aka.ms/MinecraftEULA)\n#${new Date().toString()}\neula=true\n`);
}

function eulaAccepted(dir) {
  try { return /eula\s*=\s*true/i.test(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8')); } catch { return false; }
}

// --- player lists ---------------------------------------------------------

const LISTS = {
  ops: 'ops.json',
  whitelist: 'whitelist.json',
  bans: 'banned-players.json',
  ipbans: 'banned-ips.json',
};

function readList(dir, kind) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, LISTS[kind]), 'utf8')); } catch { return []; }
}

function writeList(dir, kind, list) {
  fs.writeFileSync(path.join(dir, LISTS[kind]), JSON.stringify(list, null, 2));
}

function dashedUuid(id) {
  return id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

async function lookupPlayer(name) {
  const data = await getJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
  if (!data) throw new Error(`No Minecraft account named "${name}"`);
  return { name: data.name, uuid: dashedUuid(data.id) };
}

function mcDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} +0000`;
}

// Used only while the server is stopped; when it is running the matching
// console command is sent instead so the server's in-memory list stays
// authoritative (it would overwrite the file on shutdown otherwise).
async function editListOffline(dir, kind, action, value, reason) {
  const list = readList(dir, kind);
  if (action === 'remove') {
    const v = value.toLowerCase();
    writeList(dir, kind, list.filter((e) => (e.name || e.ip || '').toLowerCase() !== v));
    return;
  }
  if (kind === 'ipbans') {
    list.push({ ip: value, created: mcDate(), source: 'Server', expires: 'forever', reason: reason || 'Banned by an operator.' });
  } else {
    const player = await lookupPlayer(value);
    if (list.some((e) => e.uuid === player.uuid)) return;
    if (kind === 'ops') list.push({ ...player, level: 4, bypassesPlayerLimit: false });
    else if (kind === 'whitelist') list.push(player);
    else list.push({ ...player, created: mcDate(), source: 'Server', expires: 'forever', reason: reason || 'Banned by an operator.' });
  }
  writeList(dir, kind, list);
}

function listCommand(kind, action, value, reason) {
  const add = action === 'add';
  switch (kind) {
    case 'ops': return `${add ? 'op' : 'deop'} ${value}`;
    case 'whitelist': return `whitelist ${add ? 'add' : 'remove'} ${value}`;
    case 'bans': return add ? `ban ${value}${reason ? ' ' + reason : ''}` : `pardon ${value}`;
    case 'ipbans': return add ? `ban-ip ${value}${reason ? ' ' + reason : ''}` : `pardon-ip ${value}`;
    default: throw new Error('Unknown list');
  }
}

// --- config file editor ---------------------------------------------------

const TEXT_EXT = new Set(['.yml', '.yaml', '.json', '.json5', '.properties', '.toml', '.txt', '.cfg', '.conf', '.ini', '.snbt', '.mcmeta']);
const SKIP_DIRS = new Set(['world', 'world_nether', 'world_the_end', 'libraries', 'versions', 'cache', 'logs', 'crash-reports', '.paper-remapped', 'bStats', 'node_modules', 'mods', 'defaultconfigs_backup']);
const SKIP_FILES = new Set(['usercache.json', 'version_history.json', 'banned-ips.json', 'banned-players.json', 'ops.json', 'whitelist.json']);

function listConfigFiles(dir) {
  const level = readProperties(dir)['level-name'] || 'world';
  const skip = new Set([...SKIP_DIRS, level, `${level}_nether`, `${level}_the_end`]);
  const out = [];
  const walk = (abs, rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith('.') && depth < 4) walk(path.join(abs, e.name), r, depth + 1);
      } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase()) && !SKIP_FILES.has(e.name)) {
        const size = fs.statSync(path.join(abs, e.name)).size;
        if (size < 2 * 1024 * 1024) out.push({ path: r, size });
      }
    }
  };
  walk(dir, '', 0);
  return out.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
}

function safeJoin(dir, rel) {
  const root = path.resolve(dir);
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep)) throw new Error('Path is outside the server folder');
  return target;
}

function readText(dir, rel) { return fs.readFileSync(safeJoin(dir, rel), 'utf8'); }

function writeText(dir, rel, text) {
  const file = safeJoin(dir, rel);
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file, text);
}

module.exports = {
  readProperties, writeProperties, acceptEula, eulaAccepted,
  readList, editListOffline, listCommand, lookupPlayer,
  listConfigFiles, readText, writeText, safeJoin,
};
