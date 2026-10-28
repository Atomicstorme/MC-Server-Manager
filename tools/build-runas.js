// Compiles tools/mc-runas/Program.cs to build/bin/mc-runas.exe with the C#
// compiler that ships with Windows (.NET Framework 4.x), so the repo keeps
// only the source. Runs before every build (see "predist" in package.json).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(__dirname, 'mc-runas', 'Program.cs');
const out = path.join(root, 'build', 'bin', 'mc-runas.exe');
const windir = process.env.WINDIR || 'C:\\Windows';
const csc = ['Framework64', 'Framework']
  .map((d) => path.join(windir, 'Microsoft.NET', d, 'v4.0.30319', 'csc.exe'))
  .find((f) => fs.existsSync(f));

if (!csc) {
  console.error('build-runas: csc.exe not found (needs Windows with .NET Framework 4.x).');
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync(csc, ['-nologo', '-optimize', '-target:exe', '-r:System.Security.dll', `-out:${out}`, src], { stdio: 'inherit' });
console.log(`build-runas: ${path.relative(root, out)}`);
