// Persistent app settings: the list of managed servers plus app-wide prefs.
// Stored as JSON in Electron's userData folder so it survives updates.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_APP = {
  minimizeToTray: true,
  autoDownloadUpdates: true,
  startWithWindows: false, // opens hidden in the tray at sign-in
  activeServerId: null,
};

const DEFAULT_SERVER = {
  name: 'Minecraft Server',
  dir: '',
  type: 'paper', // paper | purpur | vanilla | fabric | neoforge | forge | custom
  jar: 'server.jar',
  javaPath: '',
  minRamMb: 2048,
  maxRamMb: 4096,
  jvmArgs: '',
  useRecommendedFlags: true,
  customCommand: '', // type=custom: full command line run in the server dir
  autoRestart: true,
  autoStart: false, // start when the manager opens
  autoUpdate: false, // install server/plugin updates during automatic restarts
  restartOnSelfStop: false, // minigames that stop the server to reset a round
  isolated: false, // run as the limited "mcserver" Windows account via mc-runas.exe
  stopTimeoutSec: 60,
  tpsPollSec: 30,
  backup: {
    enabled: false,
    intervalHours: 6,
    keep: 10,
    scope: 'worlds', // worlds | full
    dir: '', // empty = <server dir>/../<server folder>-backups
    lastRun: 0,
  },
  restartSchedule: {
    enabled: false,
    time: '04:00',
    warnMinutes: 5,
  },
};

class Config {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'config.json');
    this.data = { app: { ...DEFAULT_APP }, servers: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data.app = { ...DEFAULT_APP, ...raw.app };
      this.data.servers = (raw.servers || []).map(normalizeServer);
    } catch {
      // first run or unreadable file: start fresh
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get app() { return this.data.app; }

  setApp(patch) {
    Object.assign(this.data.app, patch);
    this.save();
    return this.data.app;
  }

  servers() { return this.data.servers; }

  server(id) { return this.data.servers.find((s) => s.id === id) || null; }

  addServer(fields) {
    const server = normalizeServer({ ...fields, id: crypto.randomUUID() });
    this.data.servers.push(server);
    if (!this.data.app.activeServerId) this.data.app.activeServerId = server.id;
    this.save();
    return server;
  }

  updateServer(id, patch) {
    const server = this.server(id);
    if (!server) throw new Error('Unknown server');
    const { backup, restartSchedule, ...rest } = patch;
    Object.assign(server, rest);
    if (backup) Object.assign(server.backup, backup);
    if (restartSchedule) Object.assign(server.restartSchedule, restartSchedule);
    this.save();
    return server;
  }

  removeServer(id) {
    this.data.servers = this.data.servers.filter((s) => s.id !== id);
    if (this.data.app.activeServerId === id) {
      this.data.app.activeServerId = this.data.servers[0]?.id || null;
    }
    this.save();
  }
}

function normalizeServer(s) {
  return {
    ...DEFAULT_SERVER,
    ...s,
    backup: { ...DEFAULT_SERVER.backup, ...(s.backup || {}) },
    restartSchedule: { ...DEFAULT_SERVER.restartSchedule, ...(s.restartSchedule || {}) },
  };
}

module.exports = { Config };
