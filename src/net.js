// HTTP helpers shared by the Paper, Modrinth, Mojang and Java downloaders.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const USER_AGENT = 'Atomicstorme/mc-server-manager (github.com/Atomicstorme/MC-Server-Manager-releases)';

async function getJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return res.json();
}

function postJson(url, body) {
  return getJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Streams url to dest via a .part file, reporting progress and optionally
// verifying a sha1/sha256 checksum before moving it into place.
async function download(url, dest, { onProgress, sha1, sha256 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const algo = sha256 ? 'sha256' : sha1 ? 'sha1' : null;
  const hash = algo ? crypto.createHash(algo) : null;
  let received = 0;

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    if (hash) hash.update(chunk);
    if (onProgress) onProgress({ received, total });
  });
  await pipeline(body, fs.createWriteStream(part));

  if (hash) {
    const digest = hash.digest('hex');
    const expected = (sha256 || sha1).toLowerCase();
    if (digest !== expected) {
      fs.rmSync(part, { force: true });
      throw new Error(`Checksum mismatch for ${path.basename(dest)}`);
    }
  }
  fs.renameSync(part, dest);
  return dest;
}

function hashFile(file, algo = 'sha1') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = { getJson, postJson, download, hashFile, USER_AGENT };
