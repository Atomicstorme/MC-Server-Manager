const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Config } = require('./src/config');
const { ServerProcess, detectServer } = require('./src/server');
const java = require('./src/java');
const files = require('./src/files');
const backups = require('./src/backups');
const addons = require('./src/addons');
const software = require('./src/software');
const tunnel = require('./src/tunnel');
const { Scheduler } = require('./src/scheduler');
const { Updater, RELEASES_PAGE_URL } = require('./src/updater');

app.setAppUserModelId('com.jai13.mcservermanager');
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;
let tray = null;
let quitting = false;
// Launched by the Windows sign-in entry (see applyLoginItem): stay in the tray.
const STARTED_AT_LOGIN = process.argv.includes('--startup');
const config = new Config(app.getPath('userData'));
const JAVA_DIR = path.join(app.getPath('userData'), 'java');
// Limited-account launcher and its credentials (tools/setup-isolation.ps1).
const RUN_AS = {
  exe: app.isPackaged ? path.join(process.resourcesPath, 'bin', 'mc-runas.exe') : path.join(__dirname, 'build', 'bin', 'mc-runas.exe'),
  credFile: path.join(app.getPath('userData'), 'runas.dat'),
};
const procs = new Map(); // server id -> ServerProcess
const busy = new Map(); // server id -> description of a running task

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

const updater = new Updater({ send, getAutoDownload: () => config.app.autoDownloadUpdates });

// --- servers --------------------------------------------------------------

function serverOrThrow(id) {
  const s = config.server(id);
  if (!s) throw new Error('Unknown server');
  return s;
}

function refreshDetection(id) {
  const s = serverOrThrow(id);
  if (s.type === 'custom' || !fs.existsSync(s.dir)) return s;
  const d = detectServer(s.dir);
  // "vanilla" is detection's fallback, e.g. a new Paper server that hasn't
  // run yet, so it never overrides a type the user or creator chose.
  const patch = {
    type: d.type === 'vanilla' ? s.type : d.type,
    mcVersion: d.mcVersion || s.mcVersion,
    loaderVersion: d.loaderVersion || s.loaderVersion,
    jar: s.jar && fs.existsSync(path.join(s.dir, s.jar)) ? s.jar : d.jar,
  };
  // A jar the manager just installed beats version_history.json, which
  // Paper only rewrites on its next start.
  const installed = software.installedInfo({ ...s, ...patch });
  if (installed.pendingStart) {
    patch.mcVersion = installed.mcVersion;
    patch.loaderVersion = `${installed.mcVersion}-${installed.build}`;
  }
  return config.updateServer(id, patch);
}

function getProc(id) {
  if (procs.has(id)) return procs.get(id);
  const server = serverOrThrow(id);
  const proc = new ServerProcess(server, { getRecommendedFlags: (s) => software.recommendedFlags(s), runAs: RUN_AS, beforeAutoStart: autoUpdate });
  proc.on('status', (snap) => { send('server:status', snap); updateTray(); });
  proc.on('log', (entry) => send('server:log', { id, entry }));
  proc.on('stats', (snap) => send('server:stats', { ...snap, sample: proc.history[proc.history.length - 1] }));
  proc.on('players', (snap) => send('server:players', snap));
  procs.set(id, proc);
  return proc;
}

// Runs while a server is down for a scheduled restart or a round reset.
// Only stable builds of the Minecraft version it already runs, and plugin
// releases; the replaced files are kept in <server>/.mcsm-old.
const lastAutoUpdate = new Map(); // server id -> time of last check
async function autoUpdate(proc) {
  const server = config.server(proc.server.id);
  if (!server?.autoUpdate) return;
  // Minigames can reset every few minutes; checking hourly is plenty.
  if (Date.now() - (lastAutoUpdate.get(server.id) || 0) < 3600 * 1000) return;
  lastAutoUpdate.set(server.id, Date.now());
  proc.log('Checking for updates before starting…', 'system', 'manager');
  await withBusy(server.id, 'Installing updates', async () => {
    const sw = await software.checkSoftware(server).catch(() => null);
    if (sw?.supported && sw.build && sw.latest?.channel === 'STABLE' && sw.latest.build > sw.build) {
      const res = await software.installJar(server, sw.mcVersion, progress(server.id, 'Updating server'));
      config.updateServer(server.id, { loaderVersion: `${sw.mcVersion}-${res.build}`, installedJar: res.installedJar });
      proc.log(`Updated ${server.type} ${sw.mcVersion} build ${sw.build} → ${res.build}.`, 'system', 'manager');
    }
    if (server.type === 'vanilla' || server.type === 'custom') return;
    const updates = await addons.checkUpdates(server);
    for (const [file, u] of Object.entries(updates)) {
      if (!u.download) continue;
      try {
        const name = await addons.applyUpdate(server, file, u, progress(server.id, 'Updating'));
        proc.log(`Updated ${file} (${u.current} → ${u.latest}) as ${name}.`, 'system', 'manager');
      } catch (err) {
        proc.log(`Could not update ${file}: ${err.message}`, 'warn', 'manager');
      }
    }
  });
  proc.server = config.server(server.id);
}

function runningProcs() { return [...procs.values()].filter((p) => p.proc); }

function requireStopped(id, what) {
  const p = procs.get(id);
  if (p && p.proc) throw new Error(`Stop the server before ${what}.`);
}

async function withBusy(id, label, fn) {
  if (busy.has(id)) throw new Error(`Please wait: ${busy.get(id)} is still running.`);
  busy.set(id, label);
  send('task:busy', { id, label });
  try { return await fn(); } finally { busy.delete(id); send('task:busy', { id, label: null }); }
}

function progress(id, label) {
  let last = 0;
  return (p) => {
    const now = Date.now();
    if (now - last < 150) return;
    last = now;
    send('task:progress', { id, label, ...p });
  };
}

async function runBackup(id, opts = {}) {
  const server = serverOrThrow(id);
  return withBusy(id, 'Backup', async () => {
    const proc = procs.get(id);
    try {
      const res = await backups.createBackup(server, proc, { ...opts, onProgress: progress(id, 'Backup') });
      if (opts.auto) backups.pruneBackups(server);
      send('backups:changed', { id });
      return res;
    } catch (err) {
      proc?.log(`Backup failed: ${err.message}`, 'error', 'manager');
      throw err;
    }
  });
}

const scheduler = new Scheduler({ config, getProc: (id) => procs.get(id), runBackup: (id, o) => runBackup(id, o).catch(() => {}) });

// --- IPC ------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }
  });
}

handle('app:state', () => ({
  app: config.app,
  servers: config.servers(),
  statuses: Object.fromEntries([...procs].map(([id, p]) => [id, p.snapshot()])),
  version: app.getVersion(),
  packaged: app.isPackaged,
  system: { totalMem: os.totalmem(), freeMem: os.freemem(), cores: os.cpus().length, cpu: os.cpus()[0]?.model },
  update: updater.state,
  releasesUrl: RELEASES_PAGE_URL,
  isolationReady: fs.existsSync(RUN_AS.exe) && fs.existsSync(RUN_AS.credFile),
}));
handle('app:set', (patch) => {
  const res = config.setApp(patch);
  if ('startWithWindows' in patch) applyLoginItem();
  return res;
});

handle('tunnel:status', () => tunnel.status());
handle('tunnel:apply', (patch) => tunnel.apply(patch));

handle('servers:pickFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { title: 'Choose a server folder', properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  const dir = res.filePaths[0];
  return { dir, detected: detectServer(dir), empty: fs.readdirSync(dir).length === 0 };
});
handle('servers:add', (fields) => {
  const s = config.addServer({ name: fields.name || path.basename(fields.dir), ...fields });
  return refreshDetection(s.id);
});
handle('servers:create', async ({ dir, name, type, mcVersion, acceptEula }) => {
  fs.mkdirSync(dir, { recursive: true });
  const s = config.addServer({ name: name || path.basename(dir), dir, type, mcVersion, jar: 'server.jar' });
  try {
    const res = await withBusy(s.id, 'Downloading server', () => software.installJar(s, mcVersion, progress(s.id, 'Downloading server')));
    config.updateServer(s.id, { installedJar: res.installedJar });
  } catch (err) {
    config.removeServer(s.id);
    throw err;
  }
  if (acceptEula) files.acceptEula(dir);
  return config.server(s.id);
});
handle('servers:update', (id, patch) => {
  const s = config.updateServer(id, patch);
  if (procs.has(id)) procs.get(id).server = s;
  return s;
});
handle('servers:remove', (id) => {
  requireStopped(id, 'removing it');
  procs.delete(id);
  config.removeServer(id);
});
handle('servers:detect', (id) => refreshDetection(id));

handle('server:start', async (id) => {
  refreshDetection(id);
  const p = getProc(id);
  p.server = config.server(id);
  await p.start();
});
handle('server:stop', (id) => getProc(id).stop());
handle('server:restart', (id) => getProc(id).restart());
handle('server:kill', (id) => getProc(id).kill());
handle('server:command', (id, line) => getProc(id).command(line));
handle('server:logs', (id) => (procs.get(id)?.logs || []));
handle('server:history', (id) => (procs.get(id)?.history || []));
handle('server:latestLog', (id) => {
  const file = path.join(serverOrThrow(id).dir, 'logs', 'latest.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-500) : [];
});

handle('eula:status', (id) => files.eulaAccepted(serverOrThrow(id).dir));
handle('eula:accept', (id) => files.acceptEula(serverOrThrow(id).dir));

handle('java:detect', () => java.detectJava(JAVA_DIR, config.servers().map((s) => s.javaPath).filter(Boolean)));
handle('java:required', (id) => software.requiredJava(serverOrThrow(id)));
handle('java:install', (feature) => withBusy('java', `Installing Java ${feature}`, () => java.installTemurin(feature, JAVA_DIR, progress('java', `Java ${feature}`))));
handle('java:browse', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { title: 'Select java.exe', filters: [{ name: 'Java', extensions: ['exe'] }], properties: ['openFile'] });
  if (res.canceled) return null;
  return java.javaVersion(res.filePaths[0]);
});

handle('props:read', (id) => files.readProperties(serverOrThrow(id).dir));
handle('props:write', (id, patch) => files.writeProperties(serverOrThrow(id).dir, patch));

handle('lists:read', (id) => {
  const dir = serverOrThrow(id).dir;
  return { ops: files.readList(dir, 'ops'), whitelist: files.readList(dir, 'whitelist'), bans: files.readList(dir, 'bans'), ipbans: files.readList(dir, 'ipbans') };
});
handle('lists:edit', async (id, kind, action, value, reason) => {
  const server = serverOrThrow(id);
  const p = procs.get(id);
  if (p && p.status === 'running') {
    p.command(files.listCommand(kind, action, value, reason));
    await new Promise((r) => setTimeout(r, 800)); // let the server rewrite its json file
  } else {
    await files.editListOffline(server.dir, kind, action, value, reason);
  }
});

handle('files:list', (id) => files.listConfigFiles(serverOrThrow(id).dir));
handle('files:read', (id, rel) => files.readText(serverOrThrow(id).dir, rel));
handle('files:write', (id, rel, text) => files.writeText(serverOrThrow(id).dir, rel, text));

handle('backups:list', (id) => {
  const server = serverOrThrow(id);
  return { dir: backups.backupDir(server), items: backups.listBackups(server) };
});
handle('backups:create', (id, opts) => runBackup(id, opts));
handle('backups:restore', (id, name) => {
  requireStopped(id, 'restoring a backup');
  const server = serverOrThrow(id);
  return withBusy(id, 'Restore', () => backups.restoreBackup(server, path.join(backups.backupDir(server), path.basename(name)), progress(id, 'Restore')));
});
handle('backups:delete', (id, name) => { backups.deleteBackup(serverOrThrow(id), name); });
handle('backups:pickDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { title: 'Backup folder', properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

handle('addons:list', async (id) => {
  const server = serverOrThrow(id);
  return { kind: addons.addonKind(server), dir: addons.addonDir(server), items: await addons.listAddons(server), supported: server.type !== 'vanilla' && server.type !== 'custom' };
});
handle('addons:toggle', (id, file, enabled) => addons.setEnabled(serverOrThrow(id), file, enabled));
handle('addons:remove', async (id, file) => {
  const target = path.join(addons.addonDir(serverOrThrow(id)), path.basename(file));
  await shell.trashItem(target);
});
handle('addons:installFiles', async (id, paths) => {
  const server = serverOrThrow(id);
  if (!paths) {
    const res = await dialog.showOpenDialog(mainWindow, { title: `Add ${addons.addonKind(server)}s`, filters: [{ name: 'Jar files', extensions: ['jar'] }], properties: ['openFile', 'multiSelections'] });
    if (res.canceled) return [];
    paths = res.filePaths;
  }
  return addons.installFiles(server, paths);
});
handle('addons:search', (id, query, opts) => addons.searchModrinth(serverOrThrow(id), query, opts));
handle('addons:install', (id, projectId) => addons.installModrinth(serverOrThrow(id), projectId, progress(id, 'Downloading')));
handle('addons:checkUpdates', (id) => addons.checkUpdates(serverOrThrow(id)));
handle('addons:applyUpdate', (id, file, update) => addons.applyUpdate(serverOrThrow(id), file, update, progress(id, 'Updating')));

handle('software:check', (id) => software.checkSoftware(refreshDetection(id)));
handle('software:versions', (type) => software.listVersions(type));
handle('software:install', async (id, mcVersion) => {
  requireStopped(id, 'changing the server version');
  const server = serverOrThrow(id);
  const res = await withBusy(id, 'Updating server', () => software.installJar(server, mcVersion, progress(id, 'Downloading server')));
  config.updateServer(id, { mcVersion, loaderVersion: `${mcVersion}-${res.build}`, installedJar: res.installedJar });
  return res;
});

handle('update:check', () => updater.check());
handle('update:download', () => updater.download());
handle('update:install', async () => {
  await stopAll();
  quitting = true;
  updater.install();
});

handle('shell:open', (target) => shell.openPath(target));
handle('shell:external', (url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});
handle('shell:openServerPath', (id, rel = '') => shell.openPath(rel ? files.safeJoin(serverOrThrow(id).dir, rel) : serverOrThrow(id).dir));

// --- window, tray, quit ---------------------------------------------------

function iconPath() { return path.join(__dirname, 'build', 'icon.png'); }

function createWindow() {
  mainWindow = new BrowserWindow({
    show: !STARTED_AT_LOGIN,
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#14161a',
    title: 'MC Server Manager',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', async (e) => {
    if (quitting) return;
    const running = runningProcs();
    if (!running.length) return;
    e.preventDefault();
    if (config.app.minimizeToTray) {
      mainWindow.hide();
      return;
    }
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      message: `${running.length} server${running.length > 1 ? 's are' : ' is'} still running`,
      detail: 'Stop the servers safely and quit, or keep them running in the system tray?',
      buttons: ['Stop servers and quit', 'Keep running in tray', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) quitApp();
    else if (response === 1) mainWindow.hide();
  });
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function updateTray() {
  if (!tray) return;
  const running = runningProcs();
  tray.setToolTip(running.length ? `MC Server Manager: ${running.map((p) => p.server.name).join(', ')} running` : 'MC Server Manager');
  const serverItems = config.servers().map((s) => {
    const p = procs.get(s.id);
    const status = p?.status || 'stopped';
    return {
      label: `${s.name} (${status})`,
      submenu: [
        { label: 'Start', enabled: !p?.proc, click: () => getProc(s.id).start().catch((e) => dialog.showErrorBox('Could not start', e.message)) },
        { label: 'Stop', enabled: Boolean(p?.proc), click: () => p.stop() },
        { label: 'Restart', enabled: Boolean(p?.proc), click: () => p.restart() },
      ],
    };
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open MC Server Manager', click: showWindow },
    { type: 'separator' },
    ...serverItems,
    { type: 'separator' },
    { label: 'Stop all and quit', click: quitApp },
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.on('click', showWindow);
  updateTray();
}

async function stopAll() {
  await Promise.all(runningProcs().map((p) => p.stop()));
}

async function quitApp() {
  if (quitting) return;
  quitting = true;
  const running = runningProcs();
  if (running.length) {
    showWindow();
    send('app:quitting', { count: running.length });
    await stopAll();
  }
  app.quit();
}

// The installed exe registers itself; a dev build would register electron.exe.
function applyLoginItem() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: Boolean(config.app.startWithWindows), args: ['--startup'] });
}

// One at a time, so two big servers don't load their worlds at once.
async function autoStartServers() {
  for (const s of config.servers().filter((x) => x.autoStart)) {
    const p = getProc(s.id);
    if (p.proc) continue;
    try {
      refreshDetection(s.id);
      p.server = config.server(s.id);
      await p.start();
      await new Promise((resolve) => {
        const timer = setTimeout(done, 180000);
        function done() { clearTimeout(timer); p.off('status', check); resolve(); }
        function check() { if (p.status !== 'starting') done(); }
        p.on('status', check);
        check();
      });
    } catch (err) {
      p.log(`Automatic start failed: ${err.message}`, 'error', 'manager');
    }
  }
}

app.on('second-instance', showWindow);

app.whenReady().then(() => {
  applyLoginItem();
  createWindow();
  createTray();
  scheduler.start();
  updater.start();
  autoStartServers();
});

app.on('before-quit', (e) => {
  if (!quitting && runningProcs().length) {
    e.preventDefault();
    quitApp();
  }
});

app.on('window-all-closed', () => {
  if (!runningProcs().length) app.quit();
});
