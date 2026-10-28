// Automatic backups and daily scheduled restarts, checked every 30 seconds.
const fs = require('fs');

class Scheduler {
  constructor({ config, getProc, runBackup }) {
    this.config = config;
    this.getProc = getProc;
    this.runBackup = runBackup;
    this.lastActive = new Map(); // server id -> last time seen running
    this.restartDone = new Map(); // server id -> date string of last restart
    this.warned = new Map();
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => console.error('scheduler', e)), 30000);
  }

  async tick() {
    const now = Date.now();
    for (const server of this.config.servers()) {
      const proc = this.getProc(server.id);
      if (proc?.status === 'running') this.lastActive.set(server.id, now);
      await this.maybeBackup(server, proc, now);
      this.maybeRestart(server, proc, new Date(now));
    }
  }

  // Only backs up servers that have actually run since the last backup, so
  // an idle server does not fill the disk with identical zips.
  async maybeBackup(server, proc, now) {
    const b = server.backup;
    if (!b.enabled || !fs.existsSync(server.dir)) return;
    if (now - (b.lastRun || 0) < b.intervalHours * 3600 * 1000) return;
    if ((this.lastActive.get(server.id) || 0) <= (b.lastRun || 0)) return;
    this.config.updateServer(server.id, { backup: { lastRun: now } });
    await this.runBackup(server.id, { scope: b.scope, auto: true });
  }

  maybeRestart(server, proc, now) {
    const r = server.restartSchedule;
    if (!r.enabled || !proc || proc.status !== 'running') return;
    const [h, m] = r.time.split(':').map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    const day = target.toDateString();
    if (this.restartDone.get(server.id) === day) return;
    const minsLeft = Math.ceil((target - now) / 60000);
    if (minsLeft < 0) return;

    const warnKey = `${day}:${minsLeft}`;
    if (minsLeft > 0 && minsLeft <= r.warnMinutes && (minsLeft === r.warnMinutes || minsLeft <= 1) && this.warned.get(server.id) !== warnKey) {
      this.warned.set(server.id, warnKey);
      proc.write(`say Scheduled restart in ${minsLeft} minute${minsLeft === 1 ? '' : 's'}.`);
    }
    if (minsLeft === 0) {
      this.restartDone.set(server.id, day);
      proc.write('say Restarting now. See you in a minute!');
      proc.log('Scheduled restart.', 'system', 'manager');
      proc.restart({ auto: true }).catch((e) => proc.log(e.message, 'error', 'manager'));
    }
  }
}

module.exports = { Scheduler };
