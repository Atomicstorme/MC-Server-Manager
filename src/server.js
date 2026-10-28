// Runs one Minecraft server as a child process: launch command, console
// I/O, lifecycle, player tracking, TPS polling and CPU/RAM sampling.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { javaVersion } = require('./java');

const LOG_LIMIT = 5000;
const HISTORY_LIMIT = 900; // 30 min at 2s
const SAMPLE_MS = 2000;

// --- detection ------------------------------------------------------------

function findArgsFile(dir, group) {
  const base = path.join(dir, 'libraries', ...group);
  try {
    const versions = fs.readdirSync(base).filter((v) => fs.existsSync(path.join(base, v, 'win_args.txt')));
    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const v = versions.pop();
    return v ? { version: v, file: path.relative(dir, path.join(base, v, 'win_args.txt')) } : null;
  } catch {
    return null;
  }
}

function findInstaller(dir) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(neoforge|forge)-([\w.-]+?)-installer\.jar$/);
      if (m) return { type: m[1], version: m[2], file: f };
    }
  } catch { /* unreadable */ }
  return null;
}

function detectServer(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const jars = (() => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.jar')); } catch { return []; } })();
  const result = { type: 'vanilla', jar: jars.includes('server.jar') ? 'server.jar' : jars[0] || 'server.jar', mcVersion: null, loaderVersion: null };

  // NeoForge 21.1.x is Minecraft 1.21.1; from 26.x the numbers line up.
  const neoMc = (v) => {
    const [a, b] = v.split('.').map(Number);
    return a >= 26 ? `${a}.${b}` : `1.${a}${b ? '.' + b : ''}`;
  };
  const neo = findArgsFile(dir, ['net', 'neoforged', 'neoforge']);
  const forge = findArgsFile(dir, ['net', 'minecraftforge', 'forge']);
  if (neo) return { ...result, type: 'neoforge', loaderVersion: neo.version, mcVersion: neoMc(neo.version) };
  if (forge) return { ...result, type: 'forge', loaderVersion: forge.version, mcVersion: forge.version.split('-')[0] };
  // Modpack folders often ship only the installer until first launch.
  const installer = findInstaller(dir);
  if (installer) {
    const mcVersion = installer.type === 'neoforge' ? neoMc(installer.version) : installer.version.split('-')[0];
    return { ...result, type: installer.type, loaderVersion: installer.version, mcVersion };
  }
  if (has('fabric-server-launch.jar')) return { ...result, type: 'fabric', jar: 'fabric-server-launch.jar' };

  const history = versionHistoryFile(dir);
  if (history) {
    try {
      const vh = JSON.parse(fs.readFileSync(history, 'utf8'));
      const m = String(vh.currentVersion).match(/MC: ([^)]+)\)/);
      const isPurpur = jars.some((j) => /purpur/i.test(j)) || /purpur/i.test(vh.currentVersion);
      return { ...result, type: isPurpur ? 'purpur' : 'paper', mcVersion: m ? m[1] : null, loaderVersion: String(vh.currentVersion).split(' ')[0] };
    } catch { /* fall through */ }
  }
  if (has('plugins') || has('bukkit.yml')) return { ...result, type: 'paper' };
  return result;
}

// Paper 26+ keeps it in .paper/; older Paper and Purpur in the server folder.
function versionHistoryFile(dir) {
  return [path.join(dir, '.paper', 'version_history.json'), path.join(dir, 'version_history.json')].find((f) => fs.existsSync(f)) || null;
}

const PLUGIN_TYPES = new Set(['paper', 'purpur']);
const MOD_TYPES = new Set(['fabric', 'neoforge', 'forge']);

// runAs: { exe, credFile } for isolated servers; Java is then started by
// mc-runas.exe as the limited account, with the console relayed.
function buildLaunch(server, recommendedFlags, { gcLog = false, runAs = null } = {}) {
  const dir = server.dir;
  if (server.type === 'custom') {
    return { command: server.customCommand, args: [], shell: true };
  }
  const java = server.javaPath || 'java';
  const args = [`-Xms${server.minRamMb}M`, `-Xmx${server.maxRamMb}M`];
  // Trust the Windows certificate store, not just Java's bundled one, so
  // HTTPS works behind antivirus web shields and corporate proxies (Paper
  // downloads the Mojang jar on first run and fails with PKIX otherwise).
  if (process.platform === 'win32') args.push('-Djavax.net.ssl.trustStoreType=Windows-ROOT');
  // GC summaries on stdout give the heap actually in use; the process
  // working set is the whole heap when Xms = Xmx with AlwaysPreTouch.
  if (gcLog) args.push('-Xlog:gc:stdout:uptime,tags');
  if (server.useRecommendedFlags) args.push(...recommendedFlags);
  if (server.jvmArgs.trim()) args.push(...server.jvmArgs.trim().split(/\s+/));

  if (server.type === 'neoforge' || server.type === 'forge') {
    const group = server.type === 'neoforge' ? ['net', 'neoforged', 'neoforge'] : ['net', 'minecraftforge', 'forge'];
    const argsFile = findArgsFile(dir, group);
    if (!argsFile) throw new Error(`Could not find the ${server.type} win_args.txt under libraries/. Run the installer with --installServer first.`);
    // user_jvm_args.txt goes first so the manager's memory settings win.
    const jvm = fs.existsSync(path.join(dir, 'user_jvm_args.txt')) ? ['@user_jvm_args.txt'] : [];
    return wrap(runAs, dir, { command: java, args: [...jvm, ...args, `@${argsFile.file}`, 'nogui'], shell: false });
  }
  if (!fs.existsSync(path.join(dir, server.jar))) throw new Error(`${server.jar} was not found in ${dir}`);
  return wrap(runAs, dir, { command: java, args: [...args, '-jar', server.jar, 'nogui'], shell: false });
}

// A command line started as another account is capped at 1024 characters
// (CreateProcessWithLogonW), so the JVM options move into a Java @argfile.
// Options before the main jar / last @file are moved; @files and program
// arguments stay put, since @files don't nest.
const ARGFILE = '.mcsm-jvm-args.txt';

function wrap(runAs, dir, launch) {
  if (!runAs) return launch;
  const args = launch.args;
  const jarAt = args.indexOf('-jar');
  const end = jarAt >= 0 ? jarAt : args.map((a) => a.startsWith('@')).lastIndexOf(true);
  const moved = args.slice(0, end).filter((a) => a.startsWith('-'));
  const quote = (a) => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  fs.writeFileSync(path.join(dir, ARGFILE), moved.map(quote).join('\n') + '\n');
  const kept = [];
  args.forEach((a, i) => {
    if (i < end && a.startsWith('-')) { if (!kept.includes(`@${ARGFILE}`)) kept.push(`@${ARGFILE}`); } else kept.push(a);
  });
  return { command: runAs.exe, args: [runAs.credFile, dir, '--', launch.command, ...kept], shell: false, isolated: true };
}

// Aikar-style G1 flags; Paper's API supplies the same list per version, this
// is the fallback when offline or for non-Paper servers.
const DEFAULT_FLAGS = [
  '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch', '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1',
];

// --- process --------------------------------------------------------------

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|§[0-9a-fk-or]/gi;
// Paper 26.3+ logs these as "System chat: <name> joined the game".
const JOIN = /\]: (?:System chat: )?([A-Za-z0-9_.]{1,17}) joined the game/;
const LEAVE = /\]: (?:System chat: )?([A-Za-z0-9_.]{1,17}) left the game/;
const LIST = /There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)$/;
// EssentialsX: "There are 1 out of maximum 100 players online." followed by
// one "<group>: <names>" line per permission group.
const ESS_LIST = /There are (\d+) out of maximum (\d+) players online/;
const ESS_GROUP = /\]: [^:<>]{1,32}: (.+)$/;
const PAPER_TPS = /TPS from last 1m, 5m, 15m: \*?([\d.]+),\s*\*?([\d.]+),\s*\*?([\d.]+)/;
const FORGE_TPS = /Overall\s*:\s*Mean tick time: ([\d.]+) ms\. Mean TPS: ([\d.]+)/;
const VANILLA_TICK = /Average time per tick: ([\d.]+)ms/;
// "[12.3s][gc] GC(5) Pause Young (Normal) (G1 Evacuation Pause) 1024M->256M(32768M) 5.1ms"
const GC_LINE = /^\[[\d.]+s\]\[gc[\w,]*\s*\]/;
const GC_HEAP = /(\d+)([KMG])->(\d+)([KMG])\((\d+)([KMG])\)/;
const UNIT = { K: 1024, M: 1048576, G: 1073741824 };
// Stats line from mc-runas.exe: "\x01MCSTAT <cpuMs> <workingSetBytes>".
const RUNAS_STAT = /^\x01MCSTAT (\d+) (\d+)/;
const DONE = /Done \([\d.,]+s\)! For help, type/;
// Lines produced by our own silent polls, hidden from the console.
const POLL_NOISE = [PAPER_TPS, FORGE_TPS, LIST, ESS_LIST, VANILLA_TICK, /Mean tick time:/, /Target tick rate:/, /The game is running normally/, /^\s*$/];

class ServerProcess extends EventEmitter {
  // beforeAutoStart(proc): run while the server is down for an automatic
  // restart (scheduled, or a minigame stopping itself), e.g. to install updates.
  constructor(server, { getRecommendedFlags, runAs = null, beforeAutoStart = null }) {
    super();
    this.server = server;
    this.getRecommendedFlags = getRecommendedFlags;
    this.runAs = runAs;
    this.beforeAutoStart = beforeAutoStart;
    this.updating = false;
    this.proc = null;
    this.status = 'stopped';
    this.logs = [];
    this.players = new Set();
    this.maxPlayers = null;
    this.tps = null;
    this.mspt = null;
    this.startedAt = null;
    this.history = [];
    this.crashes = [];
    this.stopRequested = false;
    this.silentUntil = 0;
    this.timers = [];
    this.sampler = null;
    this.lastCpu = null;
    this.mem = 0;
    this.heap = null;
    this.cpu = 0;
    this.buffer = '';
  }

  snapshot() {
    return {
      id: this.server.id,
      status: this.status,
      pid: this.proc?.pid || null,
      startedAt: this.startedAt,
      players: [...this.players],
      maxPlayers: this.maxPlayers,
      tps: this.tps,
      mspt: this.mspt,
      cpu: this.cpu,
      mem: this.mem,
      heap: this.heap,
      maxMem: this.server.maxRamMb * 1024 * 1024,
    };
  }

  setStatus(status) {
    this.status = status;
    this.emit('status', this.snapshot());
  }

  log(text, level = 'info', source = 'server') {
    const entry = { t: Date.now(), text, level, source };
    this.logs.push(entry);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.emit('log', entry);
  }

  async start() {
    if (this.proc) throw new Error('Server is already running');
    if (this.updating) throw new Error('Installing updates; the server starts by itself when they finish.');
    const eula = path.join(this.server.dir, 'eula.txt');
    if (this.server.type !== 'custom' && (!fs.existsSync(eula) || !/eula\s*=\s*true/i.test(fs.readFileSync(eula, 'utf8')))) {
      throw Object.assign(new Error('You must accept the Minecraft EULA before starting.'), { code: 'EULA' });
    }
    await this.installLoaderIfNeeded();
    const flags = this.server.useRecommendedFlags ? await this.getRecommendedFlags(this.server) : [];
    // -Xlog needs Java 9+; older Java would refuse to start with it.
    const jv = this.server.type === 'custom' ? null : await javaVersion(this.server.javaPath || 'java');
    let runAs = null;
    if (this.server.isolated && this.server.type !== 'custom') {
      if (!this.runAs || !fs.existsSync(this.runAs.exe) || !fs.existsSync(this.runAs.credFile)) {
        throw new Error('This server is set to run as the limited mcserver account, but that account is not set up on this PC.');
      }
      const home = os.homedir().toLowerCase();
      if ((this.server.javaPath || '').toLowerCase().startsWith(home)) {
        throw new Error('The limited account cannot read Java inside your user folder. Pick a Java outside it in Launch settings.');
      }
      runAs = this.runAs;
    }
    const launch = buildLaunch(this.server, flags, { gcLog: Boolean(jv && jv.major >= 9), runAs });

    this.stopRequested = false;
    this.players.clear();
    this.tps = null;
    this.mspt = null;
    this.heap = null;
    this.buffer = '';
    this.setStatus('starting');
    this.log(`> ${launch.command} ${launch.args.join(' ')}`, 'system', 'manager');

    const proc = spawn(launch.command, launch.args, {
      cwd: this.server.dir,
      shell: launch.shell,
      windowsHide: true,
      env: { ...process.env, TERM: 'dumb' },
    });
    this.proc = proc;
    this.startedAt = Date.now();

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => this.onData(d));
    // stderr is mostly JVM warnings; real errors are caught by the level regex.
    proc.stderr.on('data', (d) => this.onData(d));
    proc.on('error', (err) => {
      this.log(`Failed to launch: ${err.message}${err.code === 'ENOENT' ? ' (is the Java path correct?)' : ''}`, 'error', 'manager');
    });
    proc.on('exit', (code, signal) => this.onExit(code, signal));

    this.lastCpu = null;
    if (!launch.isolated) this.startSampler(proc.pid);
    const poll = Math.max(10, this.server.tpsPollSec || 30) * 1000;
    this.timers.push(setInterval(() => this.poll(), poll));
  }

  // NeoForge/Forge folders that only have the installer jar get
  // `--installServer` run once, with its output shown in the console.
  async installLoaderIfNeeded() {
    const { type, dir } = this.server;
    if (type !== 'neoforge' && type !== 'forge') return;
    const group = type === 'neoforge' ? ['net', 'neoforged', 'neoforge'] : ['net', 'minecraftforge', 'forge'];
    if (findArgsFile(dir, group)) return;
    const installer = findInstaller(dir);
    if (!installer) return;
    this.setStatus('starting');
    this.log(`Installing ${installer.type} ${installer.version} (first launch, this takes a minute)…`, 'system', 'manager');
    const code = await new Promise((resolve) => {
      const p = spawn(this.server.javaPath || 'java', ['-jar', installer.file, '--installServer'], { cwd: dir, windowsHide: true });
      p.stdout.setEncoding('utf8');
      p.stderr.setEncoding('utf8');
      p.stdout.on('data', (d) => d.split(/\r?\n/).filter(Boolean).forEach((l) => this.log(l, 'info', 'installer')));
      p.stderr.on('data', (d) => d.split(/\r?\n/).filter(Boolean).forEach((l) => this.log(l, 'warn', 'installer')));
      p.on('error', (err) => { this.log(err.message, 'error', 'manager'); resolve(-1); });
      p.on('exit', resolve);
    });
    if (code !== 0) {
      this.setStatus('stopped');
      throw new Error(`The ${installer.type} installer failed (exit code ${code}). See the console for details.`);
    }
  }

  onData(chunk, forceLevel) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    // Paper redraws its "> " input prompt before each line when stdin is a pipe.
    for (const raw of lines) this.onLine(raw.replace(ANSI, '').replace(/^(>\s*)+/, ''), forceLevel);
  }

  onLine(line, forceLevel) {
    let m;
    if ((m = line.match(RUNAS_STAT))) { this.recordSample(Number(m[1]), Number(m[2])); return; }
    if (GC_LINE.test(line)) {
      if ((m = line.match(GC_HEAP))) this.heap = Number(m[3]) * UNIT[m[4]];
      return;
    }
    if (this.essList) {
      const list = this.essList;
      this.essList = null;
      if ((m = line.match(ESS_GROUP))) {
        for (const n of m[1].split(',')) list.names.add(n.trim().replace(/^\[AFK\]\s*/i, '').replace(/^~/, ''));
        if (list.names.size < list.want) this.essList = list;
        else { this.players = list.names; this.emit('players', this.snapshot()); }
        if (Date.now() < this.silentUntil) return;
      }
    }
    if ((m = line.match(ESS_LIST))) {
      this.maxPlayers = Number(m[2]);
      if (Number(m[1]) === 0) { this.players.clear(); this.emit('players', this.snapshot()); }
      else this.essList = { want: Number(m[1]), names: new Set() };
    } else if ((m = line.match(JOIN))) { this.players.add(m[1]); this.emit('players', this.snapshot()); }
    else if ((m = line.match(LEAVE))) { this.players.delete(m[1]); this.emit('players', this.snapshot()); }
    else if ((m = line.match(LIST))) {
      this.maxPlayers = Number(m[2]);
      this.players = new Set(m[3].split(',').map((s) => s.trim()).filter(Boolean));
      this.emit('players', this.snapshot());
    } else if ((m = line.match(PAPER_TPS))) { this.tps = Number(m[1]); }
    else if ((m = line.match(FORGE_TPS))) { this.mspt = Number(m[1]); this.tps = Number(m[2]); }
    else if ((m = line.match(VANILLA_TICK))) { this.mspt = Number(m[1]); this.tps = Math.min(20, 1000 / Math.max(50, this.mspt)); }

    if (this.status === 'starting' && DONE.test(line)) {
      this.setStatus('running');
      setTimeout(() => this.poll(), 3000);
    }
    if (Date.now() < this.silentUntil && POLL_NOISE.some((re) => re.test(line))) return;

    const level = forceLevel || (/\b(ERROR|FATAL|SEVERE)\b/.test(line) ? 'error' : /\bWARN(ING)?\b/.test(line) ? 'warn' : 'info');
    this.log(line, level);
  }

  poll() {
    if (this.status !== 'running') return;
    const type = this.server.type;
    const tpsCmd = type === 'neoforge' ? 'neoforge tps' : type === 'forge' ? 'forge tps' : PLUGIN_TYPES.has(type) ? 'tps' : 'tick query';
    this.silentUntil = Date.now() + 2500;
    this.write(tpsCmd);
    this.write('list');
  }

  write(line) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    this.proc.stdin.write(line + '\n');
    return true;
  }

  // A command typed by the user: echoed to the console like a terminal.
  command(line) {
    if (!this.write(line)) throw new Error('Server is not running');
    this.log(`> ${line}`, 'command', 'user');
  }

  stop() {
    if (this.selfRestart) { clearTimeout(this.selfRestart); this.selfRestart = null; }
    if (this.updating) this.cancelAutoStart = true;
    if (!this.proc) return Promise.resolve();
    this.stopRequested = true;
    this.setStatus('stopping');
    this.write('stop');
    const proc = this.proc;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.log(`Server did not stop within ${this.server.stopTimeoutSec}s, killing it.`, 'warn', 'manager');
        this.kill();
      }, (this.server.stopTimeoutSec || 60) * 1000);
      proc.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }

  kill() {
    if (!this.proc) return;
    this.stopRequested = true;
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else this.proc.kill('SIGKILL');
  }

  // auto: a scheduled restart, so beforeAutoStart runs while it is down.
  async restart({ auto = false } = {}) {
    await this.stop();
    if (auto && !(await this.runBeforeAutoStart())) return;
    await this.start();
  }

  // Returns false when the user pressed Stop meanwhile, so it stays down.
  async runBeforeAutoStart() {
    if (!this.beforeAutoStart) return true;
    this.updating = true;
    this.cancelAutoStart = false;
    this.setStatus('starting');
    try {
      await this.beforeAutoStart(this);
    } catch (err) {
      this.log(`Automatic update failed: ${err.message}`, 'error', 'manager');
    } finally {
      this.updating = false;
    }
    if (this.cancelAutoStart) { this.setStatus('stopped'); return false; }
    return true;
  }

  onExit(code, signal) {
    if (this.buffer) { this.onLine(this.buffer.replace(ANSI, '')); this.buffer = ''; }
    this.proc = null;
    this.stopSampler();
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.players.clear();
    this.cpu = 0;
    this.mem = 0;
    this.heap = null;
    this.emit('players', this.snapshot());

    // A clean exit nobody asked for: a minigame resetting its round, or
    // /stop typed in game.
    if (!this.stopRequested && code === 0 && this.server.restartOnSelfStop) {
      this.log('Server stopped itself; starting it again in 5 seconds.', 'system', 'manager');
      this.startedAt = null;
      this.setStatus('stopped');
      this.emit('exit', { code, crashed: false });
      this.selfRestart = setTimeout(async () => {
        this.selfRestart = null;
        if (this.proc || this.status !== 'stopped') return;
        if (!(await this.runBeforeAutoStart())) return;
        this.start().catch((e) => this.log(e.message, 'error', 'manager'));
      }, 5000);
      return;
    }
    const crashed = !this.stopRequested;
    this.log(`Server exited (${signal || `code ${code}`})${crashed ? ' unexpectedly' : ''}.`, crashed ? 'error' : 'system', 'manager');
    this.startedAt = null;
    this.setStatus(crashed ? 'crashed' : 'stopped');
    this.emit('exit', { code, crashed });

    if (crashed && this.server.autoRestart) {
      const now = Date.now();
      this.crashes = this.crashes.filter((t) => now - t < 10 * 60 * 1000);
      this.crashes.push(now);
      if (this.crashes.length > 3) {
        this.log('Crashed more than 3 times in 10 minutes; auto-restart paused.', 'error', 'manager');
        return;
      }
      this.log('Auto-restarting in 10 seconds...', 'warn', 'manager');
      setTimeout(() => { if (!this.proc && this.status === 'crashed') this.start().catch((e) => this.log(e.message, 'error', 'manager')); }, 10000);
    }
  }

  // One long-lived PowerShell per server prints CPU time + working set
  // every couple of seconds (cheaper than spawning a process per sample).
  startSampler(pid) {
    if (process.platform !== 'win32') return;
    const script = `while ($true) { $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { break }; [Console]::Out.WriteLine(('{0} {1}' -f [int64]$p.TotalProcessorTime.TotalMilliseconds, $p.WorkingSet64)); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${SAMPLE_MS} }`;
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    this.sampler = ps;
    this.lastCpu = null;
    let buf = '';
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        const [cpuMs, ws] = l.trim().split(' ').map(Number);
        if (Number.isFinite(cpuMs)) this.recordSample(cpuMs, ws);
      }
    });
    ps.on('error', () => {});
  }

  recordSample(cpuMs, ws) {
    const now = Date.now();
    if (this.lastCpu) {
      const dt = now - this.lastCpu.t;
      this.cpu = Math.max(0, Math.min(100, ((cpuMs - this.lastCpu.ms) / dt / os.cpus().length) * 100));
    }
    this.lastCpu = { t: now, ms: cpuMs };
    this.mem = ws;
    this.history.push({ t: now, cpu: this.cpu, mem: ws, heap: this.heap, tps: this.tps, players: this.players.size });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.emit('stats', this.snapshot());
  }

  stopSampler() {
    if (this.sampler) { this.sampler.kill(); this.sampler = null; }
  }
}

module.exports = { ServerProcess, detectServer, buildLaunch, versionHistoryFile, DEFAULT_FLAGS, PLUGIN_TYPES, MOD_TYPES };
