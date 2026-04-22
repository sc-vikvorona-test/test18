class Scheduler {
  constructor() {
    this.tasks = new Map();
    this.timers = new Map();
  }

  schedule(name, intervalMs, fn) {
    if (this.tasks.has(name)) {
      this.cancel(name);
    }
    this.tasks.set(name, { fn, intervalMs, lastRun: null, runs: 0, errors: 0 });
    const timer = setInterval(async () => {
      const task = this.tasks.get(name);
      task.lastRun = new Date();
      task.runs++;
      try {
        await fn();
      } catch (err) {
        task.errors++;
        console.error(`Scheduled task ${name} failed:`, err);
      }
    }, intervalMs);
    this.timers.set(name, timer);
  }

  cancel(name) {
    const timer = this.timers.get(name);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(name);
      this.tasks.delete(name);
    }
  }

  cancelAll() {
    for (const name of this.timers.keys()) {
      this.cancel(name);
    }
  }

  status() {
    const result = {};
    for (const [name, task] of this.tasks.entries()) {
      result[name] = {
        lastRun: task.lastRun,
        runs: task.runs,
        errors: task.errors,
        intervalMs: task.intervalMs,
      };
    }
    return result;
  }
}

module.exports = { Scheduler };
