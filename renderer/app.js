/* global api, drawChart */
'use strict';

const state = {
  app: {},
  servers: [],
  statuses: {},
  logs: {},
  history: {},
  view: 'dashboard',
  update: {},
  system: {},
  version: '',
  releasesUrl: '',
  busy: {},
  javaList: null,
  addonUpdates: {},
};

// --- helpers --------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const call = (channel, ...args) => api.call(channel, ...args);

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}
const fmtDate = (t) => new Date(t).toLocaleString();
const fmtNum = (n) => Number(n).toLocaleString();

function toast(msg, kind = 'info', ms = 4000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// Runs an async action, showing errors as toasts. Returns the result or undefined.
async function attempt(fn, success) {
  try {
    const res = await fn();
    if (success) toast(typeof success === 'function' ? success(res) : success, 'success');
    return res;
  } catch (err) {
    toast(err.message, 'error', 7000);
    return undefined;
  }
}

// modal({ title, body, buttons: [{ label, value, cls }] }) -> { value, data }
function modal({ title, body = '', buttons = [{ label: 'OK', value: 'ok', cls: 'primary' }], onMount }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><form class="modal"><h2>${esc(title)}</h2><div class="body">${body}</div><div class="buttons">${buttons
      .map((b, i) => `<button type="${i === buttons.length - 1 ? 'submit' : 'button'}" class="btn ${b.cls || ''}" data-value="${esc(b.value)}">${esc(b.label)}</button>`)
      .join('')}</div></form></div>`;
    const form = $('form', root);
    const finish = (value) => {
      const data = {};
      for (const el of $$('[name]', form)) data[el.name] = el.type === 'checkbox' ? el.checked : el.value;
      root.innerHTML = '';
      resolve({ value, data });
    };
    $$('button[data-value]', form).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); finish(b.dataset.value); }));
    form.addEventListener('submit', (e) => { e.preventDefault(); finish(buttons[buttons.length - 1].value); });
    $('.modal-backdrop', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-backdrop')) finish(null); });
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(null); });
    onMount?.(form);
    ($('input, select, textarea', form) || $('button[type=submit]', form))?.focus();
  });
}

async function confirmModal(title, text, label = 'Continue', cls = 'primary') {
  const { value } = await modal({ title, body: `<p>${text}</p>`, buttons: [{ label: 'Cancel', value: 'cancel' }, { label, value: 'ok', cls }] });
  return value === 'ok';
}

const active = () => state.servers.find((s) => s.id === state.app.activeServerId) || null;
const status = (id = state.app.activeServerId) => state.statuses[id] || { status: 'stopped', players: [] };
const isRunning = (id) => ['running', 'starting', 'stopping'].includes(status(id).status);
const isPluginServer = (s) => s && (s.type === 'paper' || s.type === 'purpur');
const TYPE_LABEL = { paper: 'Paper', purpur: 'Purpur', vanilla: 'Vanilla', fabric: 'Fabric', neoforge: 'NeoForge', forge: 'Forge', custom: 'Custom' };

// --- navigation -----------------------------------------------------------

const NAV = [
  ['dashboard', '◉', 'Dashboard'],
  ['console', '›_', 'Console'],
  ['players', '☺', 'Players & admin'],
  ['properties', '☰', 'Server settings'],
  ['files', '✎', 'Config files'],
  ['backups', '⛁', 'Backups'],
  ['addons', '✚', 'Plugins'],
  ['software', '⇪', 'Server version'],
  ['launch', '☕', 'Java & launch'],
];

function renderSidebar() {
  const s = active();
  $('#server-picker').innerHTML = state.servers.length
    ? `<select id="server-select">${state.servers.map((x) => `<option value="${x.id}" ${x.id === s?.id ? 'selected' : ''}>${esc(x.name)}${isRunning(x.id) ? ' ●' : ''}</option>`).join('')}</select>
       <div class="row"><button class="btn small" id="add-server">+ Add server</button></div>`
    : `<button class="btn small primary" id="add-server">+ Add server</button>`;
  $('#server-select')?.addEventListener('change', (e) => switchServer(e.target.value));
  $('#add-server').addEventListener('click', addServerFlow);

  $('#nav').innerHTML = s
    ? NAV.map(([view, icon, label]) => {
      const text = view === 'addons' ? (isPluginServer(s) ? 'Plugins' : 'Mods') : label;
      return `<button class="nav-item ${state.view === view ? 'active' : ''}" data-view="${view}"><span class="nav-icon">${icon}</span>${text}</button>`;
    }).join('')
    : '';
  $$('#nav .nav-item').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
  $('#nav-app').classList.toggle('active', state.view === 'app');
  $('#app-version').textContent = `v${state.version}${state.packaged ? '' : ' (dev)'}`;
  $('#update-dot').classList.toggle('hidden', !['ready', 'available'].includes(state.update.status));
}

function go(view) {
  state.view = view;
  renderSidebar();
  renderView();
}

async function switchServer(id) {
  state.app = await call('app:set', { activeServerId: id });
  await loadServerData(id);
  renderAll();
}

async function loadServerData(id) {
  if (!id) return;
  state.logs[id] = await call('server:logs', id);
  state.history[id] = await call('server:history', id);
}

function renderAll() {
  renderSidebar();
  renderTopbar();
  renderView();
  renderBanner();
}

// --- top bar --------------------------------------------------------------

function renderTopbar() {
  const s = active();
  const bar = $('#topbar');
  if (!s) { bar.innerHTML = '<span class="title">MC Server Manager</span>'; return; }
  const st = status();
  const running = isRunning(s.id);
  const version = s.mcVersion ? ` ${s.mcVersion}` : '';
  bar.innerHTML = `
    <span class="title">${esc(s.name)}</span>
    <span class="tag">${TYPE_LABEL[s.type] || s.type}${esc(version)}</span>
    <span class="pill ${st.status}">${st.status[0].toUpperCase() + st.status.slice(1)}</span>
    <span class="muted" id="uptime">${st.startedAt ? 'Up ' + fmtDuration(Date.now() - st.startedAt) : ''}</span>
    <span class="spacer"></span>
    <button class="btn primary" id="btn-start" ${running ? 'disabled' : ''}>▶ Start</button>
    <button class="btn" id="btn-restart" ${st.status !== 'running' ? 'disabled' : ''}>↻ Restart</button>
    <button class="btn" id="btn-stop" ${!running || st.status === 'stopping' ? 'disabled' : ''}>■ Stop</button>
    <button class="btn danger" id="btn-kill" ${!running ? 'disabled' : ''} title="Force-kill the process without saving">Kill</button>
    <button class="btn ghost" id="btn-folder" title="Open server folder">📁</button>`;
  $('#btn-start').addEventListener('click', startServer);
  $('#btn-stop').addEventListener('click', () => attempt(() => call('server:stop', s.id)));
  $('#btn-restart').addEventListener('click', () => attempt(() => call('server:restart', s.id)));
  $('#btn-kill').addEventListener('click', async () => {
    if (await confirmModal('Force-kill server?', 'The server will not save. Players may lose recent progress and the world could be damaged. Use Stop unless the server is frozen.', 'Kill', 'danger')) {
      attempt(() => call('server:kill', s.id));
    }
  });
  $('#btn-folder').addEventListener('click', () => call('shell:openServerPath', s.id));
}

// Picks a Java that satisfies the server's Minecraft version, offering to
// download one if nothing installed is new enough. Returns false to abort.
async function ensureJava(s) {
  if (s.type === 'custom') return true;
  const required = await call('java:required', s.id).catch(() => null);
  state.javaList = state.javaList || await call('java:detect');
  const current = s.javaPath ? state.javaList.find((j) => j.path.toLowerCase() === s.javaPath.toLowerCase()) : null;
  if (current && (!required || current.major >= required)) return true;

  const candidates = state.javaList.filter((j) => !required || j.major >= required).sort((a, b) => a.major - b.major);
  if (!s.javaPath && candidates.length) {
    await updateServer(s.id, { javaPath: candidates[0].path });
    toast(`Using Java ${candidates[0].version} (${candidates[0].path})`);
    return true;
  }
  const msg = current
    ? `This server needs Java ${required}+, but the selected Java is ${current.version}.`
    : s.javaPath ? `The selected Java (${s.javaPath}) could not be found.` : `This server needs Java ${required}+, and no suitable Java was found on this PC.`;
  const buttons = [{ label: 'Cancel', value: 'cancel' }];
  if (current) buttons.push({ label: 'Start anyway', value: 'anyway' });
  if (candidates.length) buttons.push({ label: `Use Java ${candidates[0].major}`, value: 'use' });
  buttons.push({ label: `Download Java ${required}`, value: 'install', cls: 'primary' });
  const { value } = await modal({ title: 'Java required', body: `<p>${esc(msg)}</p><p class="muted">The manager can download Eclipse Temurin ${required} (free, about 50 MB) into its own folder. Nothing else on your PC changes.</p>`, buttons });
  if (value === 'anyway') return true;
  if (value === 'use') { await updateServer(s.id, { javaPath: candidates[0].path }); return true; }
  if (value !== 'install') return false;
  const info = await attempt(() => call('java:install', required), (j) => `Installed Java ${j.version}`);
  if (!info) return false;
  state.javaList = null;
  await updateServer(s.id, { javaPath: info.path });
  return true;
}

async function startServer() {
  const s = active();
  if (!s) return;
  if (!(await ensureJava(s))) return;
  try {
    await call('server:start', s.id);
    if (state.view !== 'console' && state.view !== 'dashboard') go('console');
  } catch (err) {
    if (err.code !== 'EULA') { toast(err.message, 'error', 8000); return; }
    const { value } = await modal({
      title: 'Minecraft EULA',
      body: '<p>To run a Minecraft server you must agree to the <a href="https://aka.ms/MinecraftEULA" target="_blank">Minecraft End User License Agreement</a>.</p>',
      buttons: [{ label: 'Cancel', value: 'no' }, { label: 'I agree, start server', value: 'yes', cls: 'primary' }],
    });
    if (value !== 'yes') return;
    await call('eula:accept', s.id);
    startServer();
  }
}

async function updateServer(id, patch) {
  const updated = await call('servers:update', id, patch);
  state.servers = state.servers.map((s) => (s.id === id ? updated : s));
  return updated;
}

// --- add server -----------------------------------------------------------

async function addServerFlow() {
  const { value } = await modal({
    title: 'Add a server',
    body: `<p>Manage a server folder you already have, or create a new Paper/Purpur server.</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Create new server', value: 'new' }, { label: 'Add existing folder', value: 'existing', cls: 'primary' }],
  });
  if (value === 'existing') return addExisting();
  if (value === 'new') return createNew();
}

async function addExisting() {
  const picked = await attempt(() => call('servers:pickFolder'));
  if (!picked) return;
  if (picked.empty) {
    toast('That folder is empty. Use "Create new server" to set one up there.', 'error');
    return;
  }
  const d = picked.detected;
  const folderName = picked.dir.split(/[\\/]/).pop();
  const { value, data } = await modal({
    title: 'Add existing server',
    body: `
      <p class="muted mono small">${esc(picked.dir)}</p>
      <label class="field"><span>Name</span><input name="name" value="${esc(folderName)}"></label>
      <label class="field"><span>Detected type</span>
        <select name="type">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${k === d.type ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <span class="hint">${d.mcVersion ? `Minecraft ${esc(d.mcVersion)}` : 'Minecraft version unknown'}${d.loaderVersion ? ` · ${esc(d.loaderVersion)}` : ''} · jar: ${esc(d.jar)}</span>
      </label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Add server', value: 'add', cls: 'primary' }],
  });
  if (value !== 'add') return;
  const server = await attempt(() => call('servers:add', { dir: picked.dir, name: data.name, type: data.type, jar: d.jar, mcVersion: d.mcVersion }));
  if (server) await afterServerAdded(server);
}

async function createNew() {
  const versions = await attempt(() => call('software:versions', 'paper'));
  if (!versions) return;
  const { value, data } = await modal({
    title: 'Create new server',
    body: `
      <label class="field"><span>Name</span><input name="name" value="My Server" required></label>
      <label class="field"><span>Software</span><select name="type" id="new-type"><option value="paper">Paper (recommended, supports plugins)</option><option value="purpur">Purpur (Paper fork with extra options)</option></select></label>
      <label class="field"><span>Minecraft version</span><select name="mcVersion" id="new-version">${versions.map((v) => `<option>${esc(v)}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="eula"> I agree to the <a href="https://aka.ms/MinecraftEULA" target="_blank">Minecraft EULA</a></label>
      <p class="muted small">Next you'll choose an empty folder for the server.</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Choose folder…', value: 'go', cls: 'primary' }],
    onMount(form) {
      $('#new-type', form).addEventListener('change', async (e) => {
        const list = await call('software:versions', e.target.value).catch(() => []);
        $('#new-version', form).innerHTML = list.map((v) => `<option>${esc(v)}</option>`).join('');
      });
    },
  });
  if (value !== 'go') return;
  const picked = await attempt(() => call('servers:pickFolder'));
  if (!picked) return;
  if (!picked.empty && !(await confirmModal('Folder is not empty', `${esc(picked.dir)} already has files in it. The server jar will be added alongside them.`))) return;
  const server = await attempt(() => call('servers:create', { dir: picked.dir, name: data.name, type: data.type, mcVersion: data.mcVersion, acceptEula: data.eula }), 'Server created');
  if (server) await afterServerAdded(server);
}

async function afterServerAdded(server) {
  const st = await call('app:state');
  Object.assign(state, { app: st.app, servers: st.servers });
  await switchServer(server.id);
  go('dashboard');
}

// --- views ----------------------------------------------------------------

const views = {};
let viewCleanup = null;

function renderView() {
  viewCleanup?.();
  viewCleanup = null;
  const root = $('#view');
  root.className = '';
  const s = active();
  if (!s && state.view !== 'app') { renderWelcome(root); return; }
  const v = views[state.view] || views.dashboard;
  viewCleanup = v(root, s) || null;
}

function renderWelcome(root) {
  root.innerHTML = `<div class="welcome">
    <img src="../build/icon.png" alt="">
    <h2 style="font-size:20px;margin-top:16px">Welcome to MC Server Manager</h2>
    <p class="muted">Start, stop and monitor your Minecraft servers, edit settings, manage players, plugins, mods and backups, all from one window.</p>
    <div class="row"><button class="btn" id="w-new">Create new server</button><button class="btn primary" id="w-add">Add existing server folder</button></div>
  </div>`;
  $('#w-add').addEventListener('click', addExisting);
  $('#w-new').addEventListener('click', createNew);
}

// Dashboard ----------------------------------------------------------------

views.dashboard = (root, s) => {
  root.innerHTML = `
    <div class="grid cols-6" id="stats"></div>
    <div class="grid cols-2" style="margin-top:12px">
      <div class="card chart-card"><h3>CPU usage</h3><canvas id="c-cpu"></canvas></div>
      <div class="card chart-card"><h3>Memory</h3><canvas id="c-mem"></canvas></div>
      <div class="card chart-card"><h3>TPS (ticks per second)</h3><canvas id="c-tps"></canvas></div>
      <div class="card chart-card"><h3>Players online</h3><canvas id="c-players"></canvas></div>
    </div>
    <div class="grid cols-2" style="margin-top:12px">
      <div class="card"><div class="section-title"><h3 style="margin:0">Recent console</h3><span class="spacer"></span><button class="btn small" id="open-console">Open console</button></div><div class="console mini" id="mini-console"></div></div>
      <div class="card"><h3>Quick actions</h3><div class="row wrap" id="quick"></div>
        <h3 style="margin-top:16px">Server</h3>
        <div class="muted mono small">${esc(s.dir)}</div>
        <div class="row wrap" style="margin-top:8px">
          <button class="btn small" data-nav="backups">Back up now…</button>
          <button class="btn small" data-nav="addons">${isPluginServer(s) ? 'Plugins' : 'Mods'}</button>
          <button class="btn small" data-nav="software">Check for server updates</button>
        </div>
      </div>
    </div>`;
  $('#open-console').addEventListener('click', () => go('console'));
  $$('[data-nav]', root).forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
  renderQuickActions($('#quick'), s);
  updateDashboard();
  renderConsoleInto($('#mini-console'), (state.logs[s.id] || []).slice(-60));
  const timer = setInterval(updateDashboard, 2000);
  const onResize = () => drawCharts();
  window.addEventListener('resize', onResize);
  return () => { clearInterval(timer); window.removeEventListener('resize', onResize); };
};

function updateDashboard() {
  const s = active();
  if (!s || state.view !== 'dashboard' || !$('#stats')) return;
  const st = status();
  const running = st.status === 'running';
  const used = st.heap ?? st.mem;
  const memPct = st.maxMem ? Math.min(100, (used / st.maxMem) * 100) : 0;
  const tpsTag = st.tps == null ? '' : st.tps >= 19 ? 'green' : st.tps >= 15 ? 'yellow' : 'red';
  const cells = [
    ['Status', st.status[0].toUpperCase() + st.status.slice(1), st.pid ? `PID ${st.pid}` : ''],
    ['Uptime', st.startedAt ? fmtDuration(Date.now() - st.startedAt) : '—', st.startedAt ? `since ${new Date(st.startedAt).toLocaleTimeString()}` : ''],
    ['Players', running ? `${st.players.length}${st.maxPlayers ? ' / ' + st.maxPlayers : ''}` : '—', st.players.slice(0, 3).join(', ') + (st.players.length > 3 ? '…' : '')],
    ['TPS', st.tps != null && running ? `<span class="tag ${tpsTag}" style="font-size:18px">${st.tps.toFixed(1)}</span>` : '—', st.mspt != null ? `${st.mspt.toFixed(1)} ms/tick` : 'target 20.0'],
    ['CPU', running || st.status === 'starting' ? `${(st.cpu || 0).toFixed(0)}%` : '—', `${state.system.cores} cores`],
    st.heap != null
      ? ['Memory', fmtBytes(st.heap), `heap in use of ${fmtBytes(s.maxRamMb * 1048576)}<span title="Java reserves the whole heap from Windows up front, so Task Manager shows this much"> · process ${fmtBytes(st.mem)}</span><div class="meter"><div style="width:${memPct}%"></div></div>`]
      : ['Memory', st.mem ? fmtBytes(st.mem) : '—', `process, of ${fmtBytes(s.maxRamMb * 1048576)} max<div class="meter"><div style="width:${memPct}%"></div></div>`],
  ];
  $('#stats').innerHTML = cells.map(([l, v, sub]) => `<div class="stat"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`).join('');
  $('#uptime') && ($('#uptime').textContent = st.startedAt ? 'Up ' + fmtDuration(Date.now() - st.startedAt) : '');
  drawCharts();
}

function drawCharts() {
  const s = active();
  if (!s || !$('#c-cpu')) return;
  const h = state.history[s.id] || [];
  drawChart($('#c-cpu'), h.map((p) => ({ t: p.t, v: p.cpu })), { max: 100, format: (v) => `${v.toFixed(0)}%`, color: '#58a6ff' });
  drawChart($('#c-mem'), h.map((p) => ({ t: p.t, v: (p.heap ?? p.mem) / 1048576 })), { max: s.maxRamMb * 1.1, format: (v) => (v >= 1024 ? `${(v / 1024).toFixed(1)}G` : `${v.toFixed(0)}M`), color: '#c792ea' });
  drawChart($('#c-tps'), h.map((p) => ({ t: p.t, v: p.tps })), { max: 21, format: (v) => v.toFixed(0), color: '#5cc46b' });
  drawChart($('#c-players'), h.map((p) => ({ t: p.t, v: p.players })), { max: Math.max(5, ...h.map((p) => p.players + 1)), format: (v) => v.toFixed(0), color: '#e0b341' });
}

function renderQuickActions(el, s) {
  const actions = [
    ['Save world', 'save-all'],
    ['Make it day', 'time set day'],
    ['Clear weather', 'weather clear'],
    ['Whitelist on', 'whitelist on'],
    ['Whitelist off', 'whitelist off'],
  ];
  el.innerHTML = actions.map(([label, cmd]) => `<button class="btn small" data-cmd="${esc(cmd)}">${label}</button>`).join('') + '<button class="btn small" id="qa-say">Broadcast message…</button>';
  $$('[data-cmd]', el).forEach((b) => b.addEventListener('click', () => sendCommand(s.id, b.dataset.cmd)));
  $('#qa-say', el).addEventListener('click', async () => {
    const { value, data } = await modal({ title: 'Broadcast message', body: '<input name="msg" placeholder="Message to all players" required>', buttons: [{ label: 'Cancel', value: null }, { label: 'Send', value: 'send', cls: 'primary' }] });
    if (value === 'send' && data.msg.trim()) sendCommand(s.id, `say ${data.msg.trim()}`);
  });
}

function sendCommand(id, cmd) {
  return attempt(() => call('server:command', id, cmd));
}

// Console ------------------------------------------------------------------

const commandHistory = [];

function lineHtml(e) {
  const time = new Date(e.t).toLocaleTimeString();
  return `<div class="l-${e.level}">${e.source === 'manager' ? `[${time} MANAGER] ` : ''}${esc(e.text)}</div>`;
}

function renderConsoleInto(el, entries) {
  el.innerHTML = entries.map(lineHtml).join('');
  el.scrollTop = el.scrollHeight;
}

views.console = (root, s) => {
  root.className = 'fill';
  root.innerHTML = `
    <div class="row" style="margin-bottom:8px">
      <input id="console-filter" placeholder="Filter lines…" style="width:240px">
      <label class="check small"><input type="checkbox" id="console-autoscroll" checked> Auto-scroll</label>
      <span class="spacer"></span>
      <button class="btn small" id="console-latest">Load latest.log</button>
      <button class="btn small" id="console-clear">Clear view</button>
    </div>
    <div class="console" id="console"></div>
    <form class="console-input" id="console-form">
      <input id="console-cmd" placeholder="${isRunning(s.id) ? 'Type a server command (no slash), e.g. say hello, op Steve, gamemode creative Steve' : 'Start the server to send commands'}" autocomplete="off" spellcheck="false">
      <button class="btn primary" type="submit">Send</button>
    </form>`;
  const el = $('#console');
  let filter = '';
  const refresh = () => {
    const entries = (state.logs[s.id] || []).filter((e) => !filter || e.text.toLowerCase().includes(filter));
    renderConsoleInto(el, entries.slice(-2000));
  };
  refresh();
  $('#console-filter').addEventListener('input', (e) => { filter = e.target.value.toLowerCase(); refresh(); });
  $('#console-clear').addEventListener('click', () => { state.logs[s.id] = []; refresh(); });
  $('#console-latest').addEventListener('click', async () => {
    const lines = await attempt(() => call('server:latestLog', s.id));
    if (!lines) return;
    state.logs[s.id] = lines.map((text) => ({ t: Date.now(), text, level: /ERROR/.test(text) ? 'error' : /WARN/.test(text) ? 'warn' : 'info', source: 'file' }));
    refresh();
  });

  let histIdx = -1;
  const input = $('#console-cmd');
  input.focus();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && commandHistory.length) { histIdx = Math.min(commandHistory.length - 1, histIdx + 1); input.value = commandHistory[commandHistory.length - 1 - histIdx]; e.preventDefault(); }
    if (e.key === 'ArrowDown') { histIdx = Math.max(-1, histIdx - 1); input.value = histIdx < 0 ? '' : commandHistory[commandHistory.length - 1 - histIdx]; e.preventDefault(); }
  });
  $('#console-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cmd = input.value.trim().replace(/^\//, '');
    if (!cmd) return;
    if (commandHistory[commandHistory.length - 1] !== cmd) commandHistory.push(cmd);
    histIdx = -1;
    input.value = '';
    await sendCommand(s.id, cmd);
  });

  const off = api.on('server:log', ({ id, entry }) => {
    if (id !== s.id || (filter && !entry.text.toLowerCase().includes(filter))) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.insertAdjacentHTML('beforeend', lineHtml(entry));
    while (el.childElementCount > 2000) el.firstElementChild.remove();
    if ($('#console-autoscroll').checked && atBottom) el.scrollTop = el.scrollHeight;
  });
  return off;
};

// Players & admin ------------------------------------------------------------

let playersTab = 'online';

views.players = (root, s) => {
  const tabs = [['online', 'Online'], ['ops', 'Operators'], ['whitelist', 'Whitelist'], ['bans', 'Banned players'], ['ipbans', 'Banned IPs']];
  root.innerHTML = `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${playersTab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div id="players-body"></div>`;
  $$('.tab', root).forEach((b) => b.addEventListener('click', () => { playersTab = b.dataset.tab; views.players(root, s); }));
  const body = $('#players-body');
  if (playersTab === 'online') renderOnline(body, s);
  else renderList(body, s, playersTab);
  const off = api.on('server:players', (snap) => { if (snap.id === s.id && playersTab === 'online') renderOnline(body, s); });
  return off;
};

const avatar = (name) => `<img src="https://mc-heads.net/avatar/${encodeURIComponent(name)}/24" alt="" loading="lazy">`;

function renderOnline(body, s) {
  const st = status(s.id);
  const running = st.status === 'running';
  body.innerHTML = `
    <div class="card">
      <div class="section-title"><h2>Online players</h2><span class="muted">${running ? `${st.players.length}${st.maxPlayers ? ' / ' + st.maxPlayers : ''}` : 'Server offline'}</span></div>
      ${!running ? '<div class="empty">Start the server to see who is online.</div>' : !st.players.length ? '<div class="empty">Nobody is online right now.</div>' : `
      <table><thead><tr><th>Player</th><th style="text-align:right">Actions</th></tr></thead><tbody>
      ${st.players.map((p) => `<tr><td><div class="player">${avatar(p)}<b>${esc(p)}</b></div></td><td><div class="actions">
        <select class="gm" data-p="${esc(p)}"><option value="">Gamemode…</option><option>survival</option><option>creative</option><option>adventure</option><option>spectator</option></select>
        <button class="btn small" data-act="msg" data-p="${esc(p)}">Message</button>
        <button class="btn small" data-act="op" data-p="${esc(p)}">Op</button>
        <button class="btn small" data-act="deop" data-p="${esc(p)}">De-op</button>
        <button class="btn small" data-act="kick" data-p="${esc(p)}">Kick</button>
        <button class="btn small danger" data-act="ban" data-p="${esc(p)}">Ban</button>
      </div></td></tr>`).join('')}</tbody></table>`}
    </div>
    <div class="card"><h3>World &amp; server controls</h3><div class="row wrap" id="admin-quick"></div>
      <div class="row wrap" style="margin-top:10px">
        <label class="row">Difficulty <select id="diff"><option value="">—</option><option>peaceful</option><option>easy</option><option>normal</option><option>hard</option></select></label>
        <label class="row">Time <select id="time"><option value="">—</option><option>day</option><option>noon</option><option>night</option><option>midnight</option></select></label>
        <label class="row">Weather <select id="weather"><option value="">—</option><option>clear</option><option>rain</option><option>thunder</option></select></label>
      </div>
    </div>`;
  renderQuickActions($('#admin-quick', body), s);
  for (const [sel, cmd] of [['#diff', 'difficulty'], ['#time', 'time set'], ['#weather', 'weather']]) {
    $(sel, body).addEventListener('change', (e) => { if (e.target.value) { sendCommand(s.id, `${cmd} ${e.target.value}`); e.target.value = ''; } });
  }
  $$('.gm', body).forEach((el) => el.addEventListener('change', () => { if (el.value) sendCommand(s.id, `gamemode ${el.value} ${el.dataset.p}`); el.value = ''; }));
  $$('[data-act]', body).forEach((b) => b.addEventListener('click', async () => {
    const p = b.dataset.p;
    const act = b.dataset.act;
    if (act === 'op' || act === 'deop') return sendCommand(s.id, `${act} ${p}`);
    const prompts = { msg: ['Message', 'Message text'], kick: ['Kick', 'Reason (optional)'], ban: ['Ban', 'Reason (optional)'] };
    const [label, placeholder] = prompts[act];
    const { value, data } = await modal({ title: `${label} ${p}`, body: `<input name="text" placeholder="${placeholder}" ${act === 'msg' ? 'required' : ''}>`, buttons: [{ label: 'Cancel', value: null }, { label, value: 'go', cls: act === 'ban' ? 'danger' : 'primary' }] });
    if (value !== 'go') return;
    const text = data.text.trim();
    sendCommand(s.id, act === 'msg' ? `tell ${p} ${text}` : `${act} ${p}${text ? ' ' + text : ''}`);
  }));
}

async function renderList(body, s, kind) {
  const lists = await attempt(() => call('lists:read', s.id));
  if (!lists) return;
  const list = lists[kind];
  const isIp = kind === 'ipbans';
  const titles = { ops: 'Operators', whitelist: 'Whitelisted players', bans: 'Banned players', ipbans: 'Banned IP addresses' };
  const hasReason = kind === 'bans' || kind === 'ipbans';
  body.innerHTML = `<div class="card">
    <div class="section-title"><h2>${titles[kind]}</h2><span class="muted">${list.length}</span></div>
    <form class="row" id="list-add" style="margin-bottom:12px">
      <input name="value" placeholder="${isIp ? 'IP address' : 'Player name'}" required style="width:220px">
      ${hasReason ? '<input name="reason" placeholder="Reason (optional)" style="flex:1">' : ''}
      <button class="btn primary" type="submit">${kind === 'bans' || kind === 'ipbans' ? 'Ban' : 'Add'}</button>
    </form>
    ${list.length ? `<table><thead><tr><th>${isIp ? 'IP' : 'Player'}</th>${kind === 'ops' ? '<th>Level</th>' : ''}${hasReason ? '<th>Reason</th><th>Since</th>' : ''}<th></th></tr></thead><tbody>
      ${list.map((e) => `<tr><td>${isIp ? esc(e.ip) : `<div class="player">${avatar(e.name)}${esc(e.name)}</div>`}</td>
        ${kind === 'ops' ? `<td>${e.level}</td>` : ''}${hasReason ? `<td>${esc(e.reason)}</td><td class="muted">${esc(e.created)}</td>` : ''}
        <td><div class="actions"><button class="btn small" data-remove="${esc(isIp ? e.ip : e.name)}">${hasReason ? 'Unban' : 'Remove'}</button></div></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">Empty</div>'}
    <p class="muted small">${isRunning(s.id) ? 'Changes are sent to the running server as commands.' : 'The server is stopped, so changes are written to the file directly (player names are looked up with Mojang).'}</p>
  </div>`;
  $('#list-add', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const ok = await attempt(() => call('lists:edit', s.id, kind, 'add', f.value.value.trim(), f.reason?.value.trim()), 'Saved');
    if (ok !== undefined) renderList(body, s, kind);
  });
  $$('[data-remove]', body).forEach((b) => b.addEventListener('click', async () => {
    await attempt(() => call('lists:edit', s.id, kind, 'remove', b.dataset.remove));
    renderList(body, s, kind);
  }));
}

// Server settings (server.properties) ----------------------------------------

const PROPS = [
  ['General', [
    ['motd', 'text', 'Message shown in the multiplayer server list'],
    ['max-players', 'number'],
    ['gamemode', ['survival', 'creative', 'adventure', 'spectator'], 'Default game mode for new players'],
    ['force-gamemode', 'bool', 'Put players back into the default mode on join'],
    ['difficulty', ['peaceful', 'easy', 'normal', 'hard']],
    ['hardcore', 'bool'],
    ['pvp', 'bool'],
    ['allow-flight', 'bool', 'Stops kicks for flying (needed for some plugins/mods)'],
    ['spawn-protection', 'number', 'Radius around spawn only ops can build in (0 = off)'],
    ['player-idle-timeout', 'number', 'Minutes before idle players are kicked (0 = never)'],
    ['enable-command-block', 'bool'],
    ['spawn-monsters', 'bool'],
    ['spawn-animals', 'bool'],
    ['spawn-npcs', 'bool'],
  ]],
  ['Access', [
    ['white-list', 'bool', 'Only whitelisted players can join'],
    ['enforce-whitelist', 'bool', 'Kick non-whitelisted players when the whitelist reloads'],
    ['online-mode', 'bool', 'Check accounts with Mojang. Only turn off behind a proxy like Velocity.'],
    ['enforce-secure-profile', 'bool', 'Require signed chat (Mojang-verified keys)'],
    ['hide-online-players', 'bool'],
  ]],
  ['World', [
    ['level-name', 'text', 'World folder name'],
    ['level-seed', 'text', 'Only used when a new world is generated'],
    ['level-type', ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified', 'minecraft:single_biome_surface']],
    ['generate-structures', 'bool'],
    ['max-world-size', 'number'],
  ]],
  ['Performance', [
    ['view-distance', 'number', 'Chunks sent to players (lower = less lag)'],
    ['simulation-distance', 'number', 'Chunks that tick around players'],
    ['entity-broadcast-range-percentage', 'number'],
    ['network-compression-threshold', 'number'],
    ['max-tick-time', 'number', 'Watchdog: ms before a frozen server is killed (-1 = off)'],
    ['pause-when-empty-seconds', 'number', 'Pause the server when empty for this long (-1 = never)'],
    ['sync-chunk-writes', 'bool'],
  ]],
  ['Network', [
    ['server-port', 'number'],
    ['server-ip', 'text', 'Leave blank to listen on all addresses'],
    ['enable-status', 'bool', 'Show in server list'],
    ['enable-query', 'bool'],
    ['query.port', 'number'],
    ['enable-rcon', 'bool', 'Remote console access'],
    ['rcon.port', 'number'],
    ['rcon.password', 'password'],
  ]],
  ['Resource pack', [
    ['resource-pack', 'text', 'Direct download URL'],
    ['resource-pack-sha1', 'text'],
    ['require-resource-pack', 'bool'],
    ['resource-pack-prompt', 'text'],
  ]],
];
const KNOWN_PROPS = new Set(PROPS.flatMap(([, items]) => items.map((i) => i[0])));
const SECRET = /password|secret/;

views.properties = (root, s) => {
  root.innerHTML = '<div class="empty">Loading…</div>';
  call('props:read', s.id).then((props) => {
    const field = ([key, type, hint]) => {
      if (!(key in props)) return '';
      const v = props[key];
      let input;
      if (type === 'bool') input = `<label class="check"><input type="checkbox" data-key="${key}" ${v === 'true' ? 'checked' : ''}> ${key}</label>`;
      else if (Array.isArray(type)) input = `<select data-key="${key}">${[...new Set([v, ...type])].map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      else input = `<input type="${type === 'number' ? 'number' : type === 'password' ? 'password' : 'text'}" data-key="${key}" value="${esc(v)}">`;
      return `<label class="field">${type === 'bool' ? '' : `<span>${key}</span>`}${input}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;
    };
    const sections = PROPS.map(([title, items]) => {
      const inner = items.map(field).join('');
      return inner ? `<div class="card"><h3>${title}</h3><div class="props">${inner}</div></div>` : '';
    }).join('');
    const other = Object.keys(props).filter((k) => !KNOWN_PROPS.has(k)).sort();
    root.innerHTML = `
      <div class="section-title"><h2>server.properties</h2><span class="spacer"></span>
        <span class="muted" id="props-dirty"></span>
        <button class="btn" id="props-reload">Reload</button><button class="btn primary" id="props-save">Save changes</button></div>
      ${isRunning(s.id) ? '<div class="banner warn" style="border-radius:8px;margin-bottom:12px">The server is running. Most changes apply after a restart.</div>' : ''}
      ${sections}
      <div class="card"><h3>All other properties</h3><table><tbody>
        ${other.map((k) => `<tr><td class="mono" style="width:40%">${esc(k)}</td><td><input style="width:100%" type="${SECRET.test(k) ? 'password' : 'text'}" data-key="${esc(k)}" value="${esc(props[k])}"></td></tr>`).join('')}
      </tbody></table></div>`;
    const read = () => {
      const patch = {};
      for (const el of $$('[data-key]', root)) {
        const v = el.type === 'checkbox' ? String(el.checked) : el.value;
        if (v !== props[el.dataset.key]) patch[el.dataset.key] = v;
      }
      return patch;
    };
    root.addEventListener('input', () => { const n = Object.keys(read()).length; $('#props-dirty').textContent = n ? `${n} unsaved change${n > 1 ? 's' : ''}` : ''; });
    $('#props-reload').addEventListener('click', () => views.properties(root, s));
    $('#props-save').addEventListener('click', async () => {
      const patch = read();
      if (!Object.keys(patch).length) { toast('No changes to save'); return; }
      if (await attempt(() => call('props:write', s.id, patch), isRunning(s.id) ? 'Saved. Restart the server to apply.' : 'Saved') !== undefined) views.properties(root, s);
    });
  }).catch((err) => { root.innerHTML = `<div class="empty">${esc(err.message)}</div>`; });
};

// Config files ---------------------------------------------------------------

views.files = (root, s) => {
  root.className = 'fill';
  root.innerHTML = `<div class="editor-layout"><div class="file-list" id="file-list"><div class="empty">Loading…</div></div>
    <div class="editor"><div class="row" style="margin-bottom:8px"><b id="file-name" class="mono">Select a file</b><span class="muted" id="file-dirty"></span><span class="spacer"></span>
      <input id="file-filter" placeholder="Filter files…" style="width:180px">
      <button class="btn small" id="file-open" disabled>Show in folder</button><button class="btn small" id="file-revert" disabled>Revert</button><button class="btn small primary" id="file-save" disabled>Save (Ctrl+S)</button></div>
      <textarea id="file-text" spellcheck="false" disabled></textarea>
      <div class="muted small" style="margin-top:6px">A .bak copy of the previous version is kept next to each saved file. Most plugin configs reload on restart or with the plugin's reload command.</div></div></div>`;
  let current = null;
  let original = '';
  let all = [];
  const ta = $('#file-text');
  const dirty = () => current && ta.value !== original;
  const updateDirty = () => { $('#file-dirty').textContent = dirty() ? '● unsaved' : ''; };

  const renderList = (filter = '') => {
    $('#file-list').innerHTML = all.filter((f) => f.path.toLowerCase().includes(filter)).map((f) => `<button data-path="${esc(f.path)}" class="${f.path === current ? 'active' : ''}" title="${esc(f.path)}">${esc(f.path)}</button>`).join('') || '<div class="empty">No config files</div>';
    $$('#file-list button').forEach((b) => b.addEventListener('click', () => open(b.dataset.path)));
  };
  const open = async (rel) => {
    if (dirty() && !(await confirmModal('Discard changes?', `You have unsaved changes in ${esc(current)}.`, 'Discard', 'danger'))) return;
    const text = await attempt(() => call('files:read', s.id, rel));
    if (text === undefined) return;
    current = rel;
    original = text;
    ta.value = text;
    ta.disabled = false;
    ['#file-save', '#file-revert', '#file-open'].forEach((id) => { $(id).disabled = false; });
    $('#file-name').textContent = rel;
    updateDirty();
    renderList($('#file-filter').value.toLowerCase());
  };
  const save = async () => {
    if (!current) return;
    if (await attempt(() => call('files:write', s.id, current, ta.value), `Saved ${current}`) !== undefined) { original = ta.value; updateDirty(); }
  };
  ta.addEventListener('input', updateDirty);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 's' && e.ctrlKey) { e.preventDefault(); save(); }
    if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); updateDirty(); }
  });
  $('#file-save').addEventListener('click', save);
  $('#file-revert').addEventListener('click', () => { ta.value = original; updateDirty(); });
  $('#file-open').addEventListener('click', () => call('shell:openServerPath', s.id, current.split('/').slice(0, -1).join('/')));
  $('#file-filter').addEventListener('input', (e) => renderList(e.target.value.toLowerCase()));
  call('files:list', s.id).then((files) => { all = files; renderList(); }).catch((e) => toast(e.message, 'error'));
};

// Backups ----------------------------------------------------------------------

views.backups = (root, s) => {
  const b = s.backup;
  root.innerHTML = `
    <div class="card">
      <div class="section-title"><h2>Backups</h2><span class="spacer"></span>
        <button class="btn" id="bk-open">Open backup folder</button>
        <button class="btn" id="bk-full">Full backup</button>
        <button class="btn primary" id="bk-now">Back up worlds now</button></div>
      <div id="bk-list"><div class="empty">Loading…</div></div>
    </div>
    <div class="card">
      <h3>Automatic backups</h3>
      <div class="props">
        <label class="check"><input type="checkbox" id="bk-enabled" ${b.enabled ? 'checked' : ''}> Back up automatically</label>
        <label class="field"><span>Every (hours)</span><input type="number" min="0.25" step="0.25" id="bk-interval" value="${b.intervalHours}"></label>
        <label class="field"><span>Keep last (automatic backups)</span><input type="number" min="1" id="bk-keep" value="${b.keep}"><span class="hint">Older automatic backups are deleted. Manual ones are always kept.</span></label>
        <label class="field"><span>What to back up</span><select id="bk-scope"><option value="worlds" ${b.scope === 'worlds' ? 'selected' : ''}>Worlds only</option><option value="full" ${b.scope === 'full' ? 'selected' : ''}>Whole server (worlds, plugins, configs)</option></select></label>
        <label class="field"><span>Backup folder</span><div class="row"><input id="bk-dir" value="${esc(b.dir)}" placeholder="Default: next to the server folder" style="flex:1"><button class="btn small" id="bk-pick">Browse</button></div></label>
      </div>
      <p class="muted small">Automatic backups only run if the server has been online since the last one. While the server is running, saving is paused during the backup so the world files are consistent.${b.lastRun ? ` Last automatic backup: ${fmtDate(b.lastRun)}.` : ''}</p>
      <button class="btn primary" id="bk-save">Save backup settings</button>
    </div>`;

  const load = async () => {
    const res = await attempt(() => call('backups:list', s.id));
    if (!res) return;
    $('#bk-open').onclick = () => call('shell:open', res.dir);
    const el = $('#bk-list');
    if (!res.items.length) { el.innerHTML = `<div class="empty">No backups yet. They will be saved to <span class="mono">${esc(res.dir)}</span></div>`; return; }
    const total = res.items.reduce((n, i) => n + i.size, 0);
    el.innerHTML = `<p class="muted">${res.items.length} backups · ${fmtBytes(total)} · <span class="mono">${esc(res.dir)}</span></p>
      <table><thead><tr><th>Created</th><th>Type</th><th>Size</th><th>File</th><th></th></tr></thead><tbody>
      ${res.items.map((i) => `<tr><td>${fmtDate(i.created)}</td><td><span class="tag">${i.scope === 'full' ? 'Full' : 'Worlds'}</span> ${i.auto ? '<span class="tag">auto</span>' : ''}</td><td>${fmtBytes(i.size)}</td><td class="mono small">${esc(i.name)}</td>
        <td><div class="actions"><button class="btn small" data-restore="${esc(i.name)}">Restore</button><button class="btn small danger" data-del="${esc(i.name)}">Delete</button></div></td></tr>`).join('')}
      </tbody></table>`;
    $$('[data-restore]', el).forEach((btn) => btn.addEventListener('click', async () => {
      if (isRunning(s.id)) { toast('Stop the server before restoring a backup.', 'error'); return; }
      if (!(await confirmModal('Restore backup?', `This replaces the folders in <b>${esc(btn.dataset.restore)}</b> (for example your world). The current versions are moved into a "pre-restore" folder inside the backup folder, so nothing is deleted.`, 'Restore', 'danger'))) return;
      const r = await attempt(() => call('backups:restore', s.id, btn.dataset.restore), 'Backup restored');
      if (r?.movedAsideTo) toast(`Previous files moved to ${r.movedAsideTo}`, 'info', 8000);
    }));
    $$('[data-del]', el).forEach((btn) => btn.addEventListener('click', async () => {
      if (!(await confirmModal('Delete backup?', `${esc(btn.dataset.del)} will be permanently deleted.`, 'Delete', 'danger'))) return;
      await attempt(() => call('backups:delete', s.id, btn.dataset.del));
      load();
    }));
  };
  load();

  const backupNow = async (scope) => {
    const { value, data } = await modal({ title: scope === 'full' ? 'Full server backup' : 'Back up worlds', body: '<label class="field"><span>Note (optional)</span><input name="note" placeholder="e.g. before 1.21 update"></label>', buttons: [{ label: 'Cancel', value: null }, { label: 'Start backup', value: 'go', cls: 'primary' }] });
    if (value !== 'go') return;
    await attempt(() => call('backups:create', s.id, { scope, note: data.note }), (r) => `Backup saved (${fmtBytes(r.size)})`);
    load();
  };
  $('#bk-now').addEventListener('click', () => backupNow('worlds'));
  $('#bk-full').addEventListener('click', () => backupNow('full'));
  $('#bk-pick').addEventListener('click', async () => { const d = await call('backups:pickDir'); if (d) $('#bk-dir').value = d; });
  $('#bk-save').addEventListener('click', async () => {
    const patch = { backup: { enabled: $('#bk-enabled').checked, intervalHours: Number($('#bk-interval').value) || 6, keep: Number($('#bk-keep').value) || 10, scope: $('#bk-scope').value, dir: $('#bk-dir').value.trim() } };
    if (await attempt(() => updateServer(s.id, patch), 'Backup settings saved')) load();
  });
  return api.on('backups:changed', ({ id }) => { if (id === s.id) load(); });
};

// Plugins / mods ----------------------------------------------------------------

let addonsTab = 'installed';

views.addons = (root, s) => {
  const noun = isPluginServer(s) ? 'plugin' : 'mod';
  const Noun = noun[0].toUpperCase() + noun.slice(1);
  if (s.type === 'vanilla' || s.type === 'custom') {
    root.innerHTML = `<div class="card"><h2>Plugins &amp; mods</h2><p>${TYPE_LABEL[s.type]} servers don't support plugins or mods. Use Paper or Purpur for plugins, or Fabric/NeoForge for mods. You can create a new Paper server with "+ Add server".</p></div>`;
    return;
  }
  const tabs = [['installed', `Installed ${noun}s`], ['browse', 'Browse Modrinth'], ['updates', 'Updates']];
  root.innerHTML = `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${addonsTab === k ? 'active' : ''}" data-tab="${k}">${l}${k === 'updates' && Object.keys(state.addonUpdates[s.id] || {}).length ? ` <span class="tag green">${Object.keys(state.addonUpdates[s.id]).length}</span>` : ''}</button>`).join('')}</div><div id="addons-body"></div>`;
  $$('.tab', root).forEach((b) => b.addEventListener('click', () => { addonsTab = b.dataset.tab; views.addons(root, s); }));
  const body = $('#addons-body');
  if (addonsTab === 'installed') renderInstalled(body, s, noun, Noun);
  else if (addonsTab === 'browse') renderBrowse(body, s, noun);
  else renderUpdates(body, s, root);
};

async function renderInstalled(body, s, noun, Noun) {
  const res = await attempt(() => call('addons:list', s.id));
  if (!res) return;
  body.innerHTML = `<div class="card">
    <div class="section-title"><h2>${res.items.length} ${noun}s</h2><span class="spacer"></span>
      <button class="btn" id="ad-folder">Open ${noun}s folder</button><button class="btn primary" id="ad-add">Add ${noun} file…</button></div>
    <div class="dropzone" id="ad-drop">Drop .jar files here to install them</div>
    ${res.items.length ? `<table style="margin-top:10px"><thead><tr><th>On</th><th>${Noun}</th><th>Version</th><th>File</th><th>Size</th><th></th></tr></thead><tbody>
      ${res.items.map((a) => `<tr class="${a.enabled ? '' : 'disabled'}"><td><input type="checkbox" data-toggle="${esc(a.file)}" ${a.enabled ? 'checked' : ''}></td>
        <td><b>${esc(a.name)}</b>${a.description ? `<div class="muted small">${esc(a.description.slice(0, 120))}</div>` : ''}</td>
        <td>${esc(a.version || '?')}</td><td class="mono small">${esc(a.file)}</td><td>${fmtBytes(a.size)}</td>
        <td><div class="actions"><button class="btn small danger" data-remove="${esc(a.file)}">Remove</button></div></td></tr>`).join('')}
    </tbody></table>` : `<div class="empty">No ${noun}s installed yet. Browse Modrinth to find some.</div>`}
    <p class="muted small">Changes take effect after the server restarts. Removed ${noun}s go to the Recycle Bin; their config folders are kept.</p>
  </div>`;
  const reload = () => renderInstalled(body, s, noun, Noun);
  $('#ad-folder').addEventListener('click', () => call('shell:open', res.dir));
  $('#ad-add').addEventListener('click', async () => { const added = await attempt(() => call('addons:installFiles', s.id)); if (added?.length) { toast(`Installed ${added.join(', ')}`, 'success'); reload(); } });
  const drop = $('#ad-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    const added = await attempt(() => call('addons:installFiles', s.id, paths));
    if (added?.length) { toast(`Installed ${added.join(', ')}`, 'success'); reload(); } else if (added) toast('Only .jar files can be installed', 'error');
  });
  $$('[data-toggle]', body).forEach((el) => el.addEventListener('change', async () => { await attempt(() => call('addons:toggle', s.id, el.dataset.toggle, el.checked)); reload(); }));
  $$('[data-remove]', body).forEach((el) => el.addEventListener('click', async () => {
    if (!(await confirmModal(`Remove ${noun}?`, `${esc(el.dataset.remove)} will be moved to the Recycle Bin.`, 'Remove', 'danger'))) return;
    await attempt(() => call('addons:remove', s.id, el.dataset.remove));
    reload();
  }));
}

function renderBrowse(body, s, noun) {
  body.innerHTML = `<div class="card">
    <form class="row" id="mr-form"><input id="mr-q" placeholder="Search Modrinth ${noun}s…" style="flex:1">
      <select id="mr-sort"><option value="relevance">Relevance</option><option value="downloads">Downloads</option><option value="follows">Follows</option><option value="updated">Recently updated</option><option value="newest">Newest</option></select>
      <label class="check small"><input type="checkbox" id="mr-any"> Any MC version</label>
      <button class="btn primary" type="submit">Search</button></form>
    <p class="muted small">Showing ${noun}s for ${TYPE_LABEL[s.type]}${s.mcVersion ? ` ${esc(s.mcVersion)}` : ''}. Required dependencies are installed automatically.</p>
    <div id="mr-results"></div></div>`;
  const search = async () => {
    const out = $('#mr-results');
    out.innerHTML = '<div class="empty">Searching…</div>';
    const res = await attempt(() => call('addons:search', s.id, $('#mr-q').value, { sort: $('#mr-sort').value, anyVersion: $('#mr-any').checked }));
    if (!res) { out.innerHTML = ''; return; }
    out.innerHTML = res.hits.length ? res.hits.map((h) => `<div class="result">
      <img src="${esc(h.icon || '')}" alt="">
      <div class="info"><div class="title">${esc(h.title)} <span class="muted small">by ${esc(h.author)}</span></div><div class="desc">${esc(h.description)}</div>
        <div class="row small muted">⬇ ${fmtNum(h.downloads)} ${h.categories.slice(0, 4).map((c) => `<span class="tag">${esc(c)}</span>`).join('')} <a href="https://modrinth.com/project/${esc(h.slug)}" target="_blank">Page</a></div></div>
      <div><button class="btn primary small" data-install="${esc(h.id)}" data-title="${esc(h.title)}">Install</button></div></div>`).join('') : '<div class="empty">No results</div>';
    $$('.result img', out).forEach((img) => img.addEventListener('error', () => { img.style.visibility = 'hidden'; }));
    $$('[data-install]', out).forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Installing…';
      const files = await attempt(() => call('addons:install', s.id, b.dataset.install), (f) => `Installed ${f.join(', ')}. Restart the server to load it.`);
      b.textContent = files ? 'Installed' : 'Install';
      b.disabled = Boolean(files);
    }));
  };
  $('#mr-form').addEventListener('submit', (e) => { e.preventDefault(); search(); });
  $('#mr-sort').addEventListener('change', search);
  search();
}

async function renderUpdates(body, s, root) {
  const known = state.addonUpdates[s.id];
  body.innerHTML = `<div class="card"><div class="section-title"><h2>Updates</h2><span class="spacer"></span><button class="btn" id="up-check">Check for updates</button>${known && Object.keys(known).length ? '<button class="btn primary" id="up-all">Update all</button>' : ''}</div><div id="up-list"></div>
    <p class="muted small">Checks Modrinth (by file fingerprint) and SpigotMC (for files named like Name-S1234-5678.jar). The old file is removed once the new one has downloaded.</p></div>`;
  const list = $('#up-list');
  const render = (updates) => {
    const entries = Object.entries(updates);
    list.innerHTML = !entries.length ? '<div class="empty">Everything is up to date.</div>' : `<table><thead><tr><th>File</th><th>Installed</th><th>Latest</th><th>Source</th><th></th></tr></thead><tbody>
      ${entries.map(([file, u]) => `<tr><td class="mono small">${esc(file)}</td><td>${esc(u.current || '?')}</td><td><b>${esc(u.latest)}</b></td><td><a href="${esc(u.url)}" target="_blank">${u.source === 'spigot' ? 'SpigotMC' : 'Modrinth'}</a></td>
        <td><div class="actions">${u.download ? `<button class="btn small primary" data-update="${esc(file)}">Update</button>` : '<span class="muted small">Download manually</span>'}</div></td></tr>`).join('')}</tbody></table>`;
    $$('[data-update]', list).forEach((b) => b.addEventListener('click', () => applyAddonUpdate(s, b.dataset.update).then(() => views.addons(root, s))));
  };
  const check = async () => {
    list.innerHTML = '<div class="empty">Checking…</div>';
    const updates = await attempt(() => call('addons:checkUpdates', s.id));
    if (!updates) { list.innerHTML = ''; return; }
    state.addonUpdates[s.id] = updates;
    views.addons(root, s);
  };
  $('#up-check').addEventListener('click', check);
  $('#up-all')?.addEventListener('click', async () => {
    for (const file of Object.keys(known)) if (known[file].download) await applyAddonUpdate(s, file);
    views.addons(root, s);
  });
  if (known) render(known); else check();
}

async function applyAddonUpdate(s, file) {
  const u = state.addonUpdates[s.id][file];
  const res = await attempt(() => call('addons:applyUpdate', s.id, file, u), (f) => `Updated to ${f}`);
  if (res) delete state.addonUpdates[s.id][file];
}

// Server version ------------------------------------------------------------------

views.software = (root, s) => {
  root.innerHTML = '<div class="empty">Checking for updates…</div>';
  call('software:check', s.id).then((info) => {
    if (!info.supported) {
      root.innerHTML = `<div class="card"><h2>Server version</h2>
        <p>${TYPE_LABEL[s.type]} ${esc(s.mcVersion || '')}${s.loaderVersion ? ` (loader ${esc(s.loaderVersion)})` : ''}</p>
        <p class="muted">Automatic updates are available for Paper and Purpur servers. To update ${TYPE_LABEL[s.type]}, run its installer for the new version in this folder, then come back and press Start.</p></div>`;
      return;
    }
    const supportTag = info.support?.status === 'UNSUPPORTED' ? '<span class="tag yellow">No longer supported by Paper</span>' : info.support?.status === 'SUPPORTED' ? '<span class="tag green">Supported</span>' : '';
    const name = TYPE_LABEL[info.type];
    root.innerHTML = `
      ${info.pendingStart ? `<div class="banner" style="border-radius:8px;margin-bottom:12px"><span>${name} ${esc(info.mcVersion)} build ${info.build} is installed. Start the server once to finish the upgrade (the first start converts your world and takes longer).</span></div>` : ''}
      ${info.newerMcAvailable ? `<div class="card" style="border-color:var(--accent-dim)">
        <div class="row"><div><h2 style="margin:0">Upgrade to ${name} ${esc(info.newestMc)}</h2>
          <div class="muted" style="margin-top:4px">You're on Minecraft ${esc(info.mcVersion)}. Players will need Minecraft ${esc(info.newestMc)} to join after upgrading.</div></div>
          <span class="spacer"></span>
          <label class="check"><input type="checkbox" id="sw-up-backup" checked> Full backup first</label>
          <button class="btn primary" id="sw-upgrade">Upgrade to ${esc(info.newestMc)}</button></div>
      </div>` : ''}
      <div class="card"><h2>${name} ${esc(info.mcVersion || '?')} ${supportTag}</h2>
        <div class="grid cols-3">
          <div class="stat"><div class="label">Installed build</div><div class="value">${info.build ?? '?'}</div><div class="sub">${info.pendingStart ? 'Waiting for first start' : info.build ? '' : 'Start the server once to record it'}</div></div>
          <div class="stat"><div class="label">Latest build</div><div class="value">${info.latest?.build ?? '—'}</div><div class="sub">${info.latest?.time ? fmtDate(info.latest.time) : ''}</div></div>
          <div class="stat"><div class="label">Newest Minecraft</div><div class="value">${esc(info.newestMc || '—')}</div><div class="sub">${info.newestMc && info.newestMc !== info.mcVersion ? 'A newer version is available' : 'You are on the newest version'}</div></div>
        </div>
        <div class="row" style="margin-top:14px">
          ${info.updateAvailable ? `<button class="btn primary" id="sw-update">Update to build ${info.latest.build}</button>` : '<span class="tag green">Build is up to date</span>'}
          <button class="btn" id="sw-recheck">Check again</button>
        </div>
        <p class="muted small">Builds within the same Minecraft version are safe bug-fix updates. The old jar is kept as ${esc(s.jar)}.old-&lt;build&gt;.</p>
      </div>
      <div class="card"><h3>Change Minecraft version</h3>
        <div class="row"><select id="sw-version">${info.versions.map((v) => `<option ${v === info.mcVersion ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
          <label class="check"><input type="checkbox" id="sw-backup" checked> Full backup first</label>
          <button class="btn" id="sw-change">Install this version</button></div>
        <p class="muted small">Upgrading changes your world permanently; you can't go back to an older version without restoring a backup. Check that your plugins support the new version first.</p>
      </div>`;
    const install = async (version, backupFirst) => {
      if (isRunning(s.id)) { toast('Stop the server first.', 'error'); return; }
      if (backupFirst && !(await attempt(() => call('backups:create', s.id, { scope: 'full', note: `before-${version}` }), 'Backup complete'))) return;
      const res = await attempt(() => call('software:install', s.id, version), (r) => `Installed ${TYPE_LABEL[s.type]} ${version} build ${r.build}`);
      if (res) {
        const st = await call('app:state');
        state.servers = st.servers;
        renderTopbar();
        views.software(root, active());
      }
    };
    $('#sw-update')?.addEventListener('click', () => install(info.mcVersion, false));
    $('#sw-upgrade')?.addEventListener('click', async () => {
      if (await confirmModal(`Upgrade to Minecraft ${esc(info.newestMc)}?`, `Your world will be converted to ${esc(info.newestMc)} on the next start and can't be opened by ${esc(info.mcVersion)} again without restoring a backup. Check that your plugins support ${esc(info.newestMc)}.`, 'Upgrade')) {
        install(info.newestMc, $('#sw-up-backup').checked);
      }
    });
    $('#sw-recheck').addEventListener('click', () => views.software(root, s));
    $('#sw-change').addEventListener('click', async () => {
      const v = $('#sw-version').value;
      if (v === info.mcVersion) { install(v, $('#sw-backup').checked); return; }
      if (await confirmModal(`Switch to Minecraft ${esc(v)}?`, `Your server will move from ${esc(info.mcVersion)} to ${esc(v)}. Players will need a matching game version, and some plugins may stop working.`, 'Switch version')) install(v, $('#sw-backup').checked);
    });
  }).catch((err) => { root.innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`; });
};

// Java & launch ------------------------------------------------------------------

views.launch = (root, s) => {
  // Minecraft gains nothing from heaps beyond ~32 GB, and huge ranges make the slider unusable.
  const totalMb = Math.min(32768, Math.floor(state.system.totalMem / 1048576));
  root.innerHTML = `
    <div class="card"><h2>Java</h2>
      <div class="row"><select id="ln-java" style="flex:1"><option value="">Detecting…</option></select>
        <button class="btn" id="ln-browse">Browse…</button><button class="btn" id="ln-rescan">Rescan</button><button class="btn primary" id="ln-install">Download Java…</button></div>
      <p class="muted small" id="ln-java-hint"></p>
    </div>
    <div class="card"><h2>Memory</h2>
      <div class="props">
        <label class="field"><span>Maximum RAM: <b id="ln-max-label"></b></span><input type="range" id="ln-max" min="1024" max="${totalMb}" step="256" value="${s.maxRamMb}"><span class="hint">Your PC has ${fmtBytes(state.system.totalMem)}. Leave at least 3-4 GB for Windows.</span></label>
        <label class="field"><span>Starting RAM: <b id="ln-min-label"></b></span><input type="range" id="ln-min" min="512" max="${totalMb}" step="256" value="${s.minRamMb}"><span class="hint">Paper recommends setting this the same as maximum.</span></label>
      </div>
    </div>
    <div class="card"><h2>Launch</h2>
      <div class="props">
        <label class="field"><span>Name</span><input id="ln-name" value="${esc(s.name)}"></label>
        <label class="field"><span>Server type</span><select id="ln-type">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${k === s.type ? 'selected' : ''}>${v}</option>`).join('')}</select><span class="hint">Detected automatically; change only if wrong.</span></label>
        <label class="field"><span>Server jar</span><input id="ln-jar" value="${esc(s.jar)}"></label>
        <label class="field"><span>Stop timeout (seconds)</span><input type="number" id="ln-timeout" value="${s.stopTimeoutSec}"><span class="hint">Force-kill if "stop" takes longer than this.</span></label>
        <label class="check"><input type="checkbox" id="ln-flags" ${s.useRecommendedFlags ? 'checked' : ''}> Use optimized JVM flags (Aikar's / Paper recommended)</label>
        <label class="check"><input type="checkbox" id="ln-autostart" ${s.autoStart ? 'checked' : ''}> Start automatically when the manager opens</label>
        <label class="check"><input type="checkbox" id="ln-autoupdate" ${s.autoUpdate ? 'checked' : ''}> Install updates during automatic restarts <span class="hint">(scheduled restarts and round resets: stable ${esc(TYPE_LABEL[s.type] || 'server')} builds for this Minecraft version and plugin releases)</span></label>
        <label class="check"><input type="checkbox" id="ln-auto" ${s.autoRestart ? 'checked' : ''}> Restart automatically if the server crashes</label>
        <label class="check"><input type="checkbox" id="ln-selfstop" ${s.restartOnSelfStop ? 'checked' : ''}> Start again when the server stops itself (minigames that reset each round)</label>
        <label class="check"><input type="checkbox" id="ln-isolated" ${s.isolated ? 'checked' : ''} ${state.isolationReady || s.isolated ? '' : 'disabled'}> Run as the limited <b>mcserver</b> Windows account ${state.isolationReady ? '' : '<span class="hint">(not set up on this PC)</span>'}</label>
      </div>
      <label class="field" style="margin-top:12px"><span>Extra JVM arguments</span><input id="ln-args" class="mono" value="${esc(s.jvmArgs)}" placeholder="e.g. -Dfile.encoding=UTF-8"></label>
      <label class="field ${s.type === 'custom' ? '' : 'hidden'}" id="ln-custom-wrap" style="margin-top:12px"><span>Custom start command</span><input id="ln-custom" class="mono" value="${esc(s.customCommand)}" placeholder="run.bat"><span class="hint">Run in the server folder. Console input still works if the script doesn't pause.</span></label>
    </div>
    <div class="card"><h2>Scheduled restart</h2>
      <div class="row wrap">
        <label class="check"><input type="checkbox" id="ln-rs" ${s.restartSchedule.enabled ? 'checked' : ''}> Restart every day at</label>
        <input type="time" id="ln-rs-time" value="${esc(s.restartSchedule.time)}">
        <span>warning players</span><input type="number" id="ln-rs-warn" min="0" style="width:70px" value="${s.restartSchedule.warnMinutes}"><span>minutes before</span>
      </div>
      <p class="muted small">Daily restarts clear memory leaks from plugins. Runs only while the manager is open (it can stay in the system tray).</p>
    </div>
    <div class="row"><button class="btn primary" id="ln-save">Save launch settings</button><span class="spacer"></span><button class="btn danger" id="ln-remove">Remove server from manager…</button></div>
    <p class="muted small mono">${esc(s.dir)}</p>`;

  const maxEl = $('#ln-max'), minEl = $('#ln-min');
  const labels = () => {
    if (Number(minEl.value) > Number(maxEl.value)) minEl.value = maxEl.value;
    $('#ln-max-label').textContent = fmtBytes(maxEl.value * 1048576);
    $('#ln-min-label').textContent = fmtBytes(minEl.value * 1048576);
  };
  maxEl.addEventListener('input', labels);
  minEl.addEventListener('input', labels);
  labels();
  $('#ln-type').addEventListener('change', (e) => $('#ln-custom-wrap').classList.toggle('hidden', e.target.value !== 'custom'));

  let required = null;
  const fillJava = async (rescan) => {
    if (rescan || !state.javaList) state.javaList = await call('java:detect').catch(() => []);
    required = await call('java:required', s.id).catch(() => null);
    const list = state.javaList;
    const sel = $('#ln-java');
    const opts = list.map((j) => `<option value="${esc(j.path)}">Java ${esc(j.version)}${required && j.major < required ? ' (too old)' : ''}${j.managed ? ' · installed by manager' : ''} · ${esc(j.path)}</option>`);
    if (s.javaPath && !list.some((j) => j.path.toLowerCase() === s.javaPath.toLowerCase())) opts.unshift(`<option value="${esc(s.javaPath)}">${esc(s.javaPath)} (not found)</option>`);
    sel.innerHTML = `<option value="">Automatic (pick the best match)</option>${opts.join('')}`;
    sel.value = s.javaPath || '';
    $('#ln-install').textContent = `Download Java ${required || ''}`.trim();
    $('#ln-java-hint').textContent = required ? `Minecraft ${s.mcVersion || ''} needs Java ${required} or newer. ${list.some((j) => j.major >= required) ? '' : 'None found on this PC, so use "Download Java".'}` : '';
  };
  fillJava(false);
  $('#ln-rescan').addEventListener('click', () => fillJava(true));
  $('#ln-browse').addEventListener('click', async () => {
    const info = await attempt(() => call('java:browse'));
    if (!info) return;
    if (!state.javaList.some((j) => j.path === info.path)) state.javaList.unshift(info);
    s.javaPath = info.path;
    await fillJava(false);
  });
  $('#ln-install').addEventListener('click', async () => {
    const feature = required || 21;
    const info = await attempt(() => call('java:install', feature), (j) => `Installed Java ${j.version}`);
    if (!info) return;
    s.javaPath = info.path;
    await updateServer(s.id, { javaPath: info.path });
    await fillJava(true);
  });

  $('#ln-save').addEventListener('click', async () => {
    const patch = {
      name: $('#ln-name').value.trim() || s.name,
      type: $('#ln-type').value,
      jar: $('#ln-jar').value.trim() || 'server.jar',
      javaPath: $('#ln-java').value,
      maxRamMb: Number(maxEl.value),
      minRamMb: Number(minEl.value),
      stopTimeoutSec: Number($('#ln-timeout').value) || 60,
      useRecommendedFlags: $('#ln-flags').checked,
      autoStart: $('#ln-autostart').checked,
      autoUpdate: $('#ln-autoupdate').checked,
      autoRestart: $('#ln-auto').checked,
      restartOnSelfStop: $('#ln-selfstop').checked,
      isolated: $('#ln-isolated').checked,
      jvmArgs: $('#ln-args').value,
      customCommand: $('#ln-custom').value,
      restartSchedule: { enabled: $('#ln-rs').checked, time: $('#ln-rs-time').value || '04:00', warnMinutes: Number($('#ln-rs-warn').value) || 0 },
    };
    if (await attempt(() => updateServer(s.id, patch), isRunning(s.id) ? 'Saved. Restart the server to apply.' : 'Saved')) { renderSidebar(); renderTopbar(); }
  });
  $('#ln-remove').addEventListener('click', async () => {
    if (!(await confirmModal('Remove server?', `${esc(s.name)} will be removed from the manager. <b>No files are deleted</b>; the folder stays at ${esc(s.dir)}.`, 'Remove', 'danger'))) return;
    if (await attempt(() => call('servers:remove', s.id)) === undefined) return;
    const st = await call('app:state');
    Object.assign(state, { app: st.app, servers: st.servers });
    if (state.app.activeServerId) await loadServerData(state.app.activeServerId);
    state.view = 'dashboard';
    renderAll();
  });
};

// App & updates ---------------------------------------------------------------------

views.app = (root) => {
  const u = state.update;
  const statusText = {
    dev: 'Development build: updates are disabled. Install the .exe to get automatic updates.',
    idle: 'Not checked yet.',
    checking: 'Checking for updates…',
    latest: `You're on the latest version.${u.checkedAt ? ` Checked ${new Date(u.checkedAt).toLocaleTimeString()}.` : ''}`,
    available: `Version ${u.version} is available.`,
    downloading: `Downloading version ${u.version || ''}…`,
    ready: `Version ${u.version} is downloaded and ready to install.`,
    error: `Update check failed: ${u.error}`,
  }[u.status] || '';
  const pct = u.progress?.percent || 0;
  root.innerHTML = `
    <div class="card"><h2>Updates</h2>
      <div class="row"><div><div style="font-size:16px;font-weight:600">MC Server Manager v${esc(state.version)}</div><div class="muted" id="upd-status">${esc(statusText)}</div></div><span class="spacer"></span>
        <button class="btn" id="upd-check" ${u.status === 'dev' || u.status === 'checking' || u.status === 'downloading' ? 'disabled' : ''}>Check for updates</button>
        ${u.status === 'available' ? '<button class="btn primary" id="upd-download">Download update</button>' : ''}
        ${u.status === 'ready' ? '<button class="btn primary" id="upd-install">Restart &amp; install</button>' : ''}
      </div>
      ${u.status === 'downloading' ? `<div class="progress" style="margin-top:12px"><div style="width:${pct}%"></div></div><div class="muted small" style="margin-top:4px">${pct.toFixed(0)}%${u.progress ? ` · ${fmtBytes(u.progress.transferred)} of ${fmtBytes(u.progress.total)} · ${fmtBytes(u.progress.bytesPerSecond)}/s` : ''}</div>` : ''}
      ${u.releaseNotes ? `<h3 style="margin-top:14px">What's new in ${esc(u.version)}</h3><pre class="notes">${esc(u.releaseNotes.replace(/<[^>]+>/g, ''))}</pre>` : ''}
      <div class="props" style="margin-top:14px">
        <label class="check"><input type="checkbox" id="app-autodl" ${state.app.autoDownloadUpdates ? 'checked' : ''}> Download updates automatically in the background</label>
      </div>
      <p class="muted small">Updates come from <a href="${esc(state.releasesUrl)}" target="_blank">GitHub Releases</a> and are checked at launch and every 6 hours. Only the changed parts are downloaded. Installing an update stops running servers safely first.</p>
    </div>
    <div class="card"><h2>Behaviour</h2>
      <div class="props">
        <label class="check"><input type="checkbox" id="app-login" ${state.app.startWithWindows ? 'checked' : ''} ${state.packaged ? '' : 'disabled'}> Start MC Server Manager when Windows starts (opens in the system tray)</label>
        <label class="check"><input type="checkbox" id="app-tray" ${state.app.minimizeToTray ? 'checked' : ''}> Keep running in the system tray when the window is closed while a server is running</label>
      </div>
      <p class="muted small">Pick which servers start with the manager in each server's Launch settings. Windows starts the manager when you sign in, not before.</p>
    </div>
    <div class="card"><h2>About</h2>
      <p class="muted">${esc(state.system.cpu || '')} · ${state.system.cores} cores · ${fmtBytes(state.system.totalMem)} RAM</p>
      <p class="muted small">Free and open source under the <a href="https://github.com/Atomicstorme/MC-Server-Manager/blob/main/LICENSE" target="_blank">GNU GPL v3</a>. <a href="https://github.com/Atomicstorme/MC-Server-Manager" target="_blank">Source code</a>.</p>
      <p class="muted small">Plugin and mod search by Modrinth. Server builds from PaperMC and PurpurMC. Java from Eclipse Adoptium. Player heads from mc-heads.net.</p>
    </div>`;
  $('#upd-check')?.addEventListener('click', () => call('update:check'));
  $('#upd-download')?.addEventListener('click', () => call('update:download'));
  $('#upd-install')?.addEventListener('click', installUpdate);
  $('#app-autodl').addEventListener('change', async (e) => { state.app = await call('app:set', { autoDownloadUpdates: e.target.checked }); });
  $('#app-login').addEventListener('change', async (e) => { state.app = await call('app:set', { startWithWindows: e.target.checked }); });
  $('#app-tray').addEventListener('change', async (e) => { state.app = await call('app:set', { minimizeToTray: e.target.checked }); });
};

async function installUpdate() {
  const running = state.servers.filter((s) => isRunning(s.id));
  if (running.length && !(await confirmModal('Install update?', `${running.map((s) => esc(s.name)).join(', ')} will be stopped safely before the manager restarts. Start ${running.length > 1 ? 'them' : 'it'} again afterwards.`, 'Stop servers & update'))) return;
  call('update:install');
}

function renderBanner() {
  const u = state.update;
  const el = $('#update-banner');
  if (u.status === 'ready' && !state.bannerDismissed) {
    el.className = 'banner';
    el.innerHTML = `<span>MC Server Manager <b>${esc(u.version)}</b> is ready to install.</span><span class="spacer"></span><button class="btn small primary" id="bn-install">Restart now</button><button class="btn small ghost" id="bn-later">Later</button>`;
    $('#bn-install').addEventListener('click', installUpdate);
    $('#bn-later').addEventListener('click', () => { state.bannerDismissed = true; renderBanner(); });
  } else if (u.status === 'available' && !state.bannerDismissed) {
    el.className = 'banner';
    el.innerHTML = `<span>Version <b>${esc(u.version)}</b> is available.</span><span class="spacer"></span><button class="btn small primary" id="bn-dl">Download</button><button class="btn small ghost" id="bn-later">Later</button>`;
    $('#bn-dl').addEventListener('click', () => call('update:download'));
    $('#bn-later').addEventListener('click', () => { state.bannerDismissed = true; renderBanner(); });
  } else {
    el.className = 'banner hidden';
  }
}

// --- live events -------------------------------------------------------------------

api.on('server:status', (snap) => {
  const prev = state.statuses[snap.id]?.status;
  state.statuses[snap.id] = snap;
  if (snap.id === state.app.activeServerId) {
    renderTopbar();
    if (state.view === 'dashboard') updateDashboard();
    if (state.view === 'console' && (prev === 'stopped' || prev === 'crashed' || snap.status === 'stopped')) {
      const input = $('#console-cmd');
      if (input) input.placeholder = isRunning(snap.id) ? 'Type a server command (no slash)' : 'Start the server to send commands';
    }
  }
  if (snap.status === 'running' && prev === 'starting') toast(`${state.servers.find((s) => s.id === snap.id)?.name} is online`, 'success');
  if (snap.status === 'crashed') toast(`${state.servers.find((s) => s.id === snap.id)?.name} crashed. Check the console.`, 'error', 8000);
  renderSidebar();
});
api.on('server:log', ({ id, entry }) => {
  const logs = (state.logs[id] = state.logs[id] || []);
  logs.push(entry);
  if (logs.length > 5000) logs.splice(0, logs.length - 5000);
  if (id === state.app.activeServerId && state.view === 'dashboard') {
    const mini = $('#mini-console');
    if (mini) {
      mini.insertAdjacentHTML('beforeend', lineHtml(entry));
      while (mini.childElementCount > 60) mini.firstElementChild.remove();
      mini.scrollTop = mini.scrollHeight;
    }
  }
});
api.on('server:stats', (snap) => {
  Object.assign(state.statuses[snap.id] || (state.statuses[snap.id] = snap), snap);
  const h = (state.history[snap.id] = state.history[snap.id] || []);
  if (snap.sample) h.push(snap.sample);
  if (h.length > 900) h.splice(0, h.length - 900);
});
api.on('server:players', (snap) => {
  state.statuses[snap.id] = { ...state.statuses[snap.id], ...snap };
  if (snap.id === state.app.activeServerId && state.view === 'dashboard') updateDashboard();
});
api.on('task:busy', ({ id, label }) => {
  if (label) state.busy[id] = label; else delete state.busy[id];
  const bar = $('#task-bar');
  const labels = Object.values(state.busy);
  bar.classList.toggle('hidden', !labels.length);
  $('#task-label').textContent = labels.join(', ');
  $('#task-fill').style.width = '0';
  $('#task-fill').parentElement.classList.add('indeterminate');
});
api.on('task:progress', (p) => {
  const fill = $('#task-fill');
  let pct = null;
  if (p.received != null && p.total) pct = (p.received / p.total) * 100; // downloads
  else if (p.done != null && p.total) pct = (p.done / p.total) * 100; // zip extraction
  else if (p.totalBytes) pct = (p.processedBytes / p.totalBytes) * 100; // backups
  if (pct != null) {
    fill.parentElement.classList.remove('indeterminate');
    fill.style.width = `${pct.toFixed(1)}%`;
  }
  const extra = p.received ? ` ${fmtBytes(p.received)}${p.total ? ' / ' + fmtBytes(p.total) : ''}` : p.processedBytes ? ` ${fmtBytes(p.processedBytes)}` : '';
  $('#task-label').textContent = `${p.label}${p.file ? ' ' + p.file : ''}${extra}`;
});
api.on('update:state', (u) => {
  if (u.status !== state.update.status) state.bannerDismissed = false;
  state.update = u;
  renderBanner();
  renderSidebar();
  if (state.view === 'app') renderView();
});
api.on('app:quitting', ({ count }) => {
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><div class="modal"><h2>Stopping ${count} server${count > 1 ? 's' : ''}…</h2><p>Saving worlds safely before closing. This can take up to a minute.</p><div class="progress indeterminate"><div></div></div></div></div>`;
});

// --- boot --------------------------------------------------------------------------

(async function boot() {
  const st = await call('app:state');
  Object.assign(state, {
    app: st.app, servers: st.servers, statuses: st.statuses, version: st.version, packaged: st.packaged,
    system: st.system, update: st.update, releasesUrl: st.releasesUrl, isolationReady: st.isolationReady,
  });
  if (!state.app.activeServerId && state.servers[0]) state.app.activeServerId = state.servers[0].id;
  await loadServerData(state.app.activeServerId);
  renderAll();
})();
