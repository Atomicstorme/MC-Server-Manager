// Plugins (Paper/Purpur) and mods (Fabric/NeoForge/Forge): listing, enable/
// disable, install from file or Modrinth, and update checks via Modrinth
// (file hash) and Spiget (SpigotMC "Name-S<resource>-<version>.jar" files).
const fs = require('fs');
const path = require('path');
const { getJson, postJson, download, hashFile } = require('./net');
const { readEntryText } = require('./zip');
const { PLUGIN_TYPES } = require('./server');

const MODRINTH = 'https://api.modrinth.com/v2';
const SPIGET = 'https://api.spiget.org/v2';
const SPIGOT_NAME = /-S(\d+)-(\d+)\.jar$/;

function addonKind(server) { return PLUGIN_TYPES.has(server.type) ? 'plugin' : 'mod'; }
function addonDir(server) { return path.join(server.dir, addonKind(server) === 'plugin' ? 'plugins' : 'mods'); }

function loadersFor(server) {
  switch (server.type) {
    case 'purpur': return ['purpur', 'paper', 'spigot', 'bukkit'];
    case 'paper': return ['paper', 'spigot', 'bukkit'];
    case 'fabric': return ['fabric'];
    case 'neoforge': return ['neoforge'];
    case 'forge': return ['forge'];
    default: return [];
  }
}

function yamlField(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n#]+)`, 'm'));
  return m ? m[1].trim() : null;
}

function tomlField(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, 'm'));
  return m ? m[1].trim() : null;
}

async function readMeta(file) {
  try {
    const entry = await readEntryText(file, ['paper-plugin.yml', 'plugin.yml', 'fabric.mod.json', 'META-INF/neoforge.mods.toml', 'META-INF/mods.toml']);
    if (!entry) return {};
    if (entry.name.endsWith('.yml')) {
      return { name: yamlField(entry.text, 'name'), version: yamlField(entry.text, 'version'), description: yamlField(entry.text, 'description'), author: yamlField(entry.text, 'author') };
    }
    if (entry.name === 'fabric.mod.json') {
      const j = JSON.parse(entry.text);
      return { name: j.name || j.id, version: j.version, description: j.description, author: Array.isArray(j.authors) ? j.authors.map((a) => a.name || a).join(', ') : null };
    }
    const version = tomlField(entry.text, 'version');
    return { name: tomlField(entry.text, 'displayName') || tomlField(entry.text, 'modId'), version: version && !version.includes('${') ? version : null, description: tomlField(entry.text, 'description'), author: tomlField(entry.text, 'authors') };
  } catch {
    return {};
  }
}

async function listAddons(server) {
  const dir = addonDir(server);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled')); } catch { return []; }
  const out = [];
  for (const file of files) {
    const abs = path.join(dir, file);
    const st = fs.statSync(abs);
    const meta = await readMeta(abs);
    const spigot = file.replace(/\.disabled$/, '').match(SPIGOT_NAME);
    out.push({
      file,
      enabled: !file.endsWith('.disabled'),
      size: st.size,
      modified: st.mtimeMs,
      name: meta.name || file.replace(/(-S\d+-\d+)?\.jar(\.disabled)?$/, ''),
      version: meta.version || null,
      description: meta.description || null,
      author: meta.author || null,
      spigot: spigot ? { resource: Number(spigot[1]), version: Number(spigot[2]) } : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function setEnabled(server, file, enabled) {
  const dir = addonDir(server);
  const base = file.replace(/\.disabled$/, '');
  const from = path.join(dir, path.basename(file));
  const to = path.join(dir, enabled ? base : `${base}.disabled`);
  if (from !== to) fs.renameSync(from, to);
}

function installFiles(server, paths) {
  const dir = addonDir(server);
  fs.mkdirSync(dir, { recursive: true });
  const installed = [];
  for (const p of paths) {
    if (!p.toLowerCase().endsWith('.jar')) continue;
    fs.copyFileSync(p, path.join(dir, path.basename(p)));
    installed.push(path.basename(p));
  }
  return installed;
}

// --- Modrinth -------------------------------------------------------------

async function searchModrinth(server, query, { offset = 0, sort = 'relevance', anyVersion = false } = {}) {
  const kind = addonKind(server);
  const loaders = loadersFor(server);
  const facets = [[`project_type:${kind}`]];
  if (loaders.length) facets.push(loaders.map((l) => `categories:${l}`));
  if (server.mcVersion && !anyVersion) facets.push([`versions:${server.mcVersion}`]);
  if (kind === 'mod') facets.push(['server_side:required', 'server_side:optional']);
  const url = `${MODRINTH}/search?query=${encodeURIComponent(query)}&limit=20&offset=${offset}&index=${sort}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const res = await getJson(url);
  return {
    total: res.total_hits,
    hits: res.hits.map((h) => ({
      id: h.project_id, slug: h.slug, title: h.title, description: h.description, author: h.author,
      downloads: h.downloads, icon: h.icon_url, versions: h.versions, categories: h.display_categories,
    })),
  };
}

async function bestVersion(server, projectId) {
  const loaders = loadersFor(server);
  const params = [`loaders=${encodeURIComponent(JSON.stringify(loaders))}`];
  if (server.mcVersion) params.push(`game_versions=${encodeURIComponent(JSON.stringify([server.mcVersion]))}`);
  const versions = await getJson(`${MODRINTH}/project/${projectId}/version?${params.join('&')}`);
  if (!versions || !versions.length) return null;
  return versions.find((v) => v.version_type === 'release') || versions[0];
}

// Installs a project and its required dependencies. Returns installed names.
async function installModrinth(server, projectId, onProgress, seen = new Set()) {
  if (seen.has(projectId)) return [];
  seen.add(projectId);
  const version = await bestVersion(server, projectId);
  if (!version) throw new Error(`No version compatible with ${server.type} ${server.mcVersion || ''}`.trim());
  const file = version.files.find((f) => f.primary) || version.files[0];
  const dir = addonDir(server);
  await download(file.url, path.join(dir, file.filename), { sha1: file.hashes.sha1, onProgress: (p) => onProgress?.({ file: file.filename, ...p }) });
  const installed = [file.filename];

  const existing = new Set(fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => f.toLowerCase()) : []);
  for (const dep of version.dependencies || []) {
    if (dep.dependency_type !== 'required' || !dep.project_id) continue;
    const project = await getJson(`${MODRINTH}/project/${dep.project_id}`).catch(() => null);
    if (project && [...existing].some((f) => f.includes(project.slug.toLowerCase()))) continue;
    try { installed.push(...(await installModrinth(server, dep.project_id, onProgress, seen))); } catch { /* optional best effort */ }
  }
  return installed;
}

// Returns { [file]: { source, current, latest, url, download } } for addons
// that have a newer compatible version.
async function checkUpdates(server) {
  const addons = (await listAddons(server)).filter((a) => a.enabled);
  const dir = addonDir(server);
  const updates = {};

  const byHash = {};
  for (const a of addons) {
    a.hash = await hashFile(path.join(dir, a.file), 'sha1');
    byHash[a.hash] = a;
  }
  const hashes = Object.keys(byHash);
  if (hashes.length) {
    const body = { hashes, algorithm: 'sha1', loaders: loadersFor(server) };
    if (server.mcVersion) body.game_versions = [server.mcVersion];
    const [known, latest] = await Promise.all([
      postJson(`${MODRINTH}/version_files`, { hashes, algorithm: 'sha1' }).catch(() => ({})),
      postJson(`${MODRINTH}/version_files/update`, body).catch(() => ({})),
    ]);
    await Promise.all(Object.entries(latest || {}).map(async ([hash, newest]) => {
      const addon = byHash[hash];
      const current = known?.[hash];
      // The update endpoint returns betas and snapshots too. Offer only a
      // release, unless the installed file is itself a pre-release.
      let version = newest;
      if (version.version_type !== 'release' && current?.version_type === 'release') {
        version = await bestVersion(server, version.project_id).catch(() => null);
        if (!version || version.version_type !== 'release' || new Date(version.date_published) <= new Date(current.date_published)) return;
      }
      const file = version.files.find((f) => f.primary) || version.files[0];
      if (!addon || file.hashes.sha1 === hash) return;
      updates[addon.file] = {
        source: 'modrinth', current: known?.[hash]?.version_number || addon.version, latest: version.version_number,
        url: `https://modrinth.com/project/${version.project_id}`, download: { url: file.url, filename: file.filename, sha1: file.hashes.sha1 },
      };
    }));
    for (const a of addons) a.onModrinth = Boolean(known?.[a.hash]);
  }

  await Promise.all(addons.filter((a) => a.spigot && !updates[a.file] && !a.onModrinth).map(async (a) => {
    try {
      const [latest, resource] = await Promise.all([
        getJson(`${SPIGET}/resources/${a.spigot.resource}/versions/latest`),
        getJson(`${SPIGET}/resources/${a.spigot.resource}`),
      ]);
      if (!latest || latest.id === a.spigot.version) return;
      const current = await getJson(`${SPIGET}/resources/${a.spigot.resource}/versions/${a.spigot.version}`).catch(() => null);
      const page = `https://www.spigotmc.org/resources/${a.spigot.resource}/`;
      updates[a.file] = {
        source: 'spigot', current: current?.name || a.version, latest: latest.name, url: page,
        download: resource.external || resource.premium ? null : {
          url: `${SPIGET}/resources/${a.spigot.resource}/download`,
          filename: a.file.replace(SPIGOT_NAME, `-S${a.spigot.resource}-${latest.id}.jar`),
        },
      };
    } catch { /* resource removed or API down */ }
  }));
  return updates;
}

// Folder inside the server that keeps the files an update replaced, so a bad
// update can be rolled back by moving the file back.
function oldFilesDir(server) { return path.join(server.dir, '.mcsm-old'); }

// Downloads the new file next to the old one, checks it really is a plugin
// or mod (Spigot can hand back an HTML page), then moves the old one aside.
async function applyUpdate(server, file, update, onProgress) {
  if (!update.download) throw new Error('This plugin must be downloaded manually from its page.');
  const dir = addonDir(server);
  const name = update.download.filename;
  const tmp = path.join(dir, `.${name}.new`);
  await download(update.download.url, tmp, { sha1: update.download.sha1, onProgress });
  const meta = await readMeta(tmp).catch(() => ({}));
  if (!meta.name) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`The download for ${name} is not a valid ${addonKind(server)} jar.`);
  }
  const old = path.join(dir, path.basename(file));
  if (fs.existsSync(old)) {
    fs.mkdirSync(oldFilesDir(server), { recursive: true });
    fs.renameSync(old, path.join(oldFilesDir(server), path.basename(file)));
  }
  fs.renameSync(tmp, path.join(dir, name));
  return name;
}

module.exports = { addonKind, addonDir, oldFilesDir, listAddons, setEnabled, installFiles, searchModrinth, installModrinth, checkUpdates, applyUpdate };
