// Finds Java installs on this PC and installs Eclipse Temurin on demand.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { getJson, download } = require('./net');
const { extractZip } = require('./zip');

const EXE = process.platform === 'win32' ? 'java.exe' : 'java';

function searchRoots(managedDir) {
  const env = process.env;
  const roots = [managedDir];
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], 'D:\\Program Files', 'D:\\Program Files (x86)']) {
    if (!base) continue;
    for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru', 'Android\\openjdk']) {
      roots.push(path.join(base, vendor));
    }
  }
  if (env.APPDATA) roots.push(path.join(env.APPDATA, '.minecraft', 'runtime'));
  if (env.LOCALAPPDATA) {
    roots.push(path.join(env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'));
    const pkgs = path.join(env.LOCALAPPDATA, 'Packages');
    try {
      for (const p of fs.readdirSync(pkgs)) {
        if (p.startsWith('Microsoft.4297127D64EC6')) roots.push(path.join(pkgs, p, 'LocalCache', 'Local', 'runtime'));
      }
    } catch { /* no launcher */ }
  }
  roots.push(path.join(os.homedir(), '.jdks'));
  return roots;
}

// Walks a few levels under root looking for bin/java.exe.
function findJavaExes(root, depth = 4, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  const exe = path.join(root, 'bin', EXE);
  if (fs.existsSync(exe)) { out.push(exe); return out; }
  if (depth === 0) return out;
  for (const e of entries) if (e.isDirectory()) findJavaExes(path.join(root, e.name), depth - 1, out);
  return out;
}

function javaVersion(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['-version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      const text = `${stderr}\n${stdout}`;
      const m = text.match(/version "([^"]+)"/);
      if (!m) { resolve(null); return; }
      const parts = m[1].split(/[._-]/).map(Number);
      const major = parts[0] === 1 ? parts[1] : parts[0];
      const vendor = (text.match(/^(.*Runtime Environment.*)$/m) || [])[1] || '';
      resolve({ path: exe, version: m[1], major, vendor: vendor.trim() });
    });
  });
}

function whereJava() {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', ['java'], { windowsHide: true }, (err, stdout) => {
      resolve(err ? [] : stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

// extra: java paths already chosen for servers, so a Java outside the usual
// install folders is still listed instead of showing as "not found".
async function detectJava(managedDir, extra = []) {
  const found = new Set(extra);
  if (process.env.JAVA_HOME) found.add(path.join(process.env.JAVA_HOME, 'bin', EXE));
  for (const p of await whereJava()) found.add(p);
  for (const root of searchRoots(managedDir)) for (const exe of findJavaExes(root)) found.add(exe);

  const results = [];
  const seen = new Set();
  for (const exe of found) {
    if (!fs.existsSync(exe)) continue;
    const real = fs.realpathSync(exe).toLowerCase();
    if (seen.has(real)) continue;
    seen.add(real);
    const info = await javaVersion(exe);
    if (info) results.push({ ...info, managed: exe.toLowerCase().startsWith(managedDir.toLowerCase()) });
  }
  return results.sort((a, b) => b.major - a.major);
}

// Downloads the latest Temurin JRE for a feature version (e.g. 25) into
// managedDir and returns its java.exe path.
async function installTemurin(feature, managedDir, onProgress) {
  const url = `https://api.adoptium.net/v3/assets/latest/${feature}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`;
  let assets = await getJson(url);
  let imageType = 'jre';
  if (!assets || !assets.length) {
    // Some feature versions only ship a JDK.
    assets = await getJson(url.replace('image_type=jre', 'image_type=jdk'));
    imageType = 'jdk';
  }
  if (!assets || !assets.length) throw new Error(`No Temurin ${feature} build is available for Windows x64.`);
  const pkg = assets[0].binary.package;
  const name = `temurin-${feature}-${imageType}`;
  const zipPath = path.join(managedDir, `${name}.zip`);
  const dest = path.join(managedDir, name);

  onProgress?.({ stage: 'download', received: 0, total: pkg.size });
  await download(pkg.link, zipPath, { sha256: pkg.checksum, onProgress: (p) => onProgress?.({ stage: 'download', ...p }) });
  onProgress?.({ stage: 'extract' });
  fs.rmSync(dest, { recursive: true, force: true });
  await extractZip(zipPath, dest);
  fs.rmSync(zipPath, { force: true });

  const exe = findJavaExes(dest)[0];
  if (!exe) throw new Error('Java downloaded but java.exe was not found in the archive.');
  return javaVersion(exe);
}

module.exports = { detectJava, installTemurin, javaVersion };
