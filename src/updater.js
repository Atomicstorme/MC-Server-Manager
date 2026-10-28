// App self-update, same flow as AIhub: installed builds check GitHub
// Releases (the "publish" entry in package.json) on launch and every few
// hours, download in the background and offer a restart once ready. A dev
// checkout run with `npm start` reports "dev build" and never updates.
const { app } = require('electron');

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Keep in sync with "publish" in package.json.
const RELEASES_PAGE_URL = 'https://github.com/Atomicstorme/MC-Server-Manager-releases/releases';

class Updater {
  constructor({ send, getAutoDownload }) {
    this.send = send;
    this.getAutoDownload = getAutoDownload;
    this.state = { status: app.isPackaged ? 'idle' : 'dev', current: app.getVersion() };
    this.autoUpdater = null;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.send('update:state', this.state);
  }

  start() {
    if (!app.isPackaged) return;
    const { autoUpdater } = require('electron-updater');
    this.autoUpdater = autoUpdater;
    autoUpdater.autoDownload = this.getAutoDownload();
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'latest', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => this.set({
      status: autoUpdater.autoDownload ? 'downloading' : 'available',
      version: info.version, releaseNotes: notes(info.releaseNotes), releaseDate: info.releaseDate, checkedAt: Date.now(),
    }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond } }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version, progress: null }));
    autoUpdater.on('error', (err) => this.set({ status: 'error', error: friendly(err) }));

    this.check();
    setInterval(() => this.check(), UPDATE_CHECK_INTERVAL_MS);
  }

  check() {
    if (!this.autoUpdater) return Promise.resolve(this.state);
    this.autoUpdater.autoDownload = this.getAutoDownload();
    return this.autoUpdater.checkForUpdates().then(() => this.state).catch((err) => {
      this.set({ status: 'error', error: friendly(err) });
      return this.state;
    });
  }

  download() {
    if (!this.autoUpdater) return;
    this.set({ status: 'downloading' });
    this.autoUpdater.downloadUpdate().catch((err) => this.set({ status: 'error', error: friendly(err) }));
  }

  install() {
    if (this.autoUpdater && this.state.status === 'ready') this.autoUpdater.quitAndInstall(false, true);
  }
}

function notes(n) {
  if (!n) return '';
  if (Array.isArray(n)) return n.map((x) => x.note).join('\n');
  return String(n);
}

function friendly(err) {
  const msg = String(err?.message || err);
  if (/404/.test(msg)) return 'No releases have been published yet.';
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::/.test(msg)) return 'Could not reach GitHub. Check your internet connection.';
  return msg.split('\n')[0];
}

module.exports = { Updater, RELEASES_PAGE_URL };
