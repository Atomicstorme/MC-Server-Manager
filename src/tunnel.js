// The playit.gg agent runs as the Windows service "playitd". Reading its
// state needs no rights; changing it runs fixed sc.exe commands through a
// UAC prompt, so the manager itself never runs as administrator.
const { execFile } = require('child_process');
const path = require('path');

const SERVICE = 'playitd';
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const SC = path.join(SYSTEM32, 'sc.exe');

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 120000 }, (err, stdout) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || '') }));
  });
}

async function status() {
  const [query, qc, failure, flag] = await Promise.all([
    run(SC, ['query', SERVICE]),
    run(SC, ['qc', SERVICE]),
    run(SC, ['qfailure', SERVICE]),
    run(SC, ['qfailureflag', SERVICE]),
  ]);
  if (query.code === 1060 || /1060/.test(query.out)) return { installed: false };
  const state = (query.out.match(/STATE\s+:\s+\d+\s+(\w+)/) || [])[1] || 'UNKNOWN';
  const startType = qc.out.match(/START_TYPE\s+:\s+\d+\s+(\w+)(\s+\(DELAYED\))?/) || [];
  return {
    installed: true,
    state, // RUNNING, STOPPED, START_PENDING, ...
    exitCode: Number((query.out.match(/WIN32_EXIT_CODE\s+:\s+(\d+)/) || [])[1] || 0),
    startType: startType[1] || 'UNKNOWN',
    delayedStart: Boolean(startType[2]),
    // Restart actions only cover a clean "stopped with an error" exit (how
    // playitd quits when the network isn't up yet) when the flag is set too.
    restartOnFailure: /FAILURE_ACTIONS\s+:\s+RESTART/.test(failure.out) && /NONCRASH_FAILURES:\s+TRUE/.test(flag.out),
  };
}

// Runs the given sc.exe argument lists as administrator in one UAC prompt.
async function elevate(commands) {
  const line = commands.map((args) => `"${SC}" ${args.join(' ')}`).join(' && ');
  // cmd /s /c "..." strips only the outer quotes; -EncodedCommand avoids
  // a second round of command-line quoting for PowerShell itself.
  const script = [
    '$ErrorActionPreference = "Stop"',
    `try { $p = Start-Process -FilePath '${path.join(SYSTEM32, 'cmd.exe')}' -ArgumentList '/s /c "${line.replace(/'/g, "''")}"' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode }`,
    'catch { exit 1223 }',
  ].join('\n');
  const res = await run(path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  if (res.code === 1223) throw new Error('Cancelled at the Windows administrator prompt.');
  if (res.code !== 0) throw new Error(`Windows refused the change (sc.exe exit code ${res.code}).`);
}

// patch: { delayedStart?, restartOnFailure?, start? }
async function apply(patch) {
  const cur = await status();
  if (!cur.installed) throw new Error('playit.gg is not installed.');
  const cmds = [];
  if ('delayedStart' in patch) cmds.push(['config', SERVICE, 'start=', patch.delayedStart ? 'delayed-auto' : 'auto']);
  if ('restartOnFailure' in patch) {
    cmds.push(patch.restartOnFailure
      ? ['failure', SERVICE, 'reset=', '86400', 'actions=', 'restart/60000/restart/60000/restart/60000']
      : ['failure', SERVICE, 'reset=', '0', 'actions=', '""']);
    cmds.push(['failureflag', SERVICE, patch.restartOnFailure ? '1' : '0']);
  }
  if (patch.start && cur.state !== 'RUNNING') cmds.push(['start', SERVICE]);
  if (cmds.length) await elevate(cmds);
  return status();
}

module.exports = { status, apply };
