// Server software: Paper/Purpur build updates, version lists for new
// servers, and Paper's recommended JVM flags / required Java version.
const fs = require('fs');
const path = require('path');
const { getJson, download } = require('./net');
const { DEFAULT_FLAGS, versionHistoryFile } = require('./server');

const FILL = 'https://fill.papermc.io/v3/projects/paper';
const PURPUR = 'https://api.purpurmc.org/v2/purpur';
const versionInfoCache = new Map();

async function paperVersionInfo(mcVersion) {
  if (!mcVersion) return null;
  if (versionInfoCache.has(mcVersion)) return versionInfoCache.get(mcVersion);
  const info = await getJson(`${FILL}/versions/${encodeURIComponent(mcVersion)}`).catch(() => null);
  if (info) versionInfoCache.set(mcVersion, info);
  return info;
}

async function recommendedFlags(server) {
  const info = await paperVersionInfo(server.mcVersion);
  return info?.version?.java?.flags?.recommended || DEFAULT_FLAGS;
}

// Minimum Java major for a Minecraft version. Paper's API knows exactly;
// otherwise use Mojang's published requirements.
async function requiredJava(server) {
  const info = await paperVersionInfo(server.mcVersion);
  const min = info?.version?.java?.version?.minimum;
  if (min) return min;
  const v = server.mcVersion || '';
  const [a, b, c] = v.split('.').map(Number);
  if (a >= 26) return 25;
  if (a === 1 && (b > 20 || (b === 20 && (c || 0) >= 5))) return 21;
  if (a === 1 && b >= 18) return 17;
  if (a === 1 && b === 17) return 16;
  return 8;
}

async function listVersions(type) {
  if (type === 'purpur') {
    const res = await getJson(PURPUR);
    return [...res.versions].reverse();
  }
  const res = await getJson(FILL);
  return Object.values(res.versions).flat().filter((v) => !/-(pre|rc)/.test(v));
}

function jarMtime(server) {
  try { return fs.statSync(path.join(server.dir, server.jar || 'server.jar')).mtimeMs; } catch { return null; }
}

// Paper only rewrites version_history.json when it next starts, so right
// after an update that file still names the old version. The manager's own
// record of the jar it installed wins while that jar is unchanged.
function installedInfo(server) {
  const rec = server.installedJar;
  if (rec && rec.mtime === jarMtime(server)) return { mcVersion: rec.mcVersion, build: rec.build, pendingStart: true };
  try {
    const vh = JSON.parse(fs.readFileSync(versionHistoryFile(server.dir), 'utf8'));
    const m = String(vh.currentVersion).match(/^([\w.-]+?)-(\d+)-\w+ \(MC: ([^)]+)\)/);
    return m ? { mcVersion: m[3], build: Number(m[2]), pendingStart: false } : { mcVersion: server.mcVersion, build: null };
  } catch {
    return { mcVersion: server.mcVersion, build: null };
  }
}

async function latestBuild(type, mcVersion) {
  if (type === 'purpur') {
    const res = await getJson(`${PURPUR}/${mcVersion}`);
    if (!res) return null;
    const build = Number(res.builds.latest);
    return { build, url: `${PURPUR}/${mcVersion}/${build}/download`, channel: 'STABLE' };
  }
  const builds = await getJson(`${FILL}/versions/${encodeURIComponent(mcVersion)}/builds`);
  if (!builds || !builds.length) return null;
  const pick = builds.find((b) => b.channel === 'STABLE') || builds[0];
  const dl = pick.downloads['server:default'];
  return { build: pick.id, url: dl.url, sha256: dl.checksums.sha256, size: dl.size, channel: pick.channel, time: pick.time };
}

async function checkSoftware(server) {
  if (server.type !== 'paper' && server.type !== 'purpur') {
    return { supported: false, type: server.type, mcVersion: server.mcVersion };
  }
  const { mcVersion, build, pendingStart } = installedInfo(server);
  const [latest, versions, info] = await Promise.all([
    mcVersion ? latestBuild(server.type, mcVersion) : null,
    listVersions(server.type).catch(() => []),
    server.type === 'paper' ? paperVersionInfo(mcVersion) : null,
  ]);
  const newestMc = versions[0] || null;
  return {
    supported: true,
    type: server.type,
    mcVersion,
    build,
    pendingStart: Boolean(pendingStart),
    latest,
    updateAvailable: Boolean(latest && build && latest.build > build),
    newestMc,
    newerMcAvailable: Boolean(newestMc && mcVersion && newestMc !== mcVersion && versions.indexOf(mcVersion) > 0),
    versions: versions.slice(0, 40),
    support: info?.version?.support || null,
  };
}

// Downloads a build into the server's jar, keeping the old jar alongside.
async function installJar(server, mcVersion, onProgress) {
  const latest = await latestBuild(server.type, mcVersion);
  if (!latest) throw new Error(`No ${server.type} builds for ${mcVersion}`);
  const jar = path.join(server.dir, server.jar || 'server.jar');
  const tmp = path.join(server.dir, `.${path.basename(jar)}.new`);
  await download(latest.url, tmp, { sha256: latest.sha256, onProgress });
  if (fs.existsSync(jar)) {
    const oldBuild = installedInfo(server).build;
    fs.renameSync(jar, `${jar}.old${oldBuild ? '-' + oldBuild : ''}`);
  }
  fs.renameSync(tmp, jar);
  return { ...latest, installedJar: { mcVersion, build: latest.build, mtime: jarMtime(server) } };
}

module.exports = { recommendedFlags, requiredJava, listVersions, checkSoftware, installJar, installedInfo };
