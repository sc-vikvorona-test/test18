const EventEmitter = require('events');

class JobQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.concurrency = options.concurrency || 5;
    this.retries = options.retries || 3;
    this.pending = [];
    this.running = 0;
    this.completed = 0;
    this.failed = 0;
  }

  add(job) {
    return new Promise((resolve, reject) => {
      this.pending.push({ job, resolve, reject, attempts: 0 });
      this._process();
    });
  }

  _process() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const item = this.pending.shift();
      this.running++;
      this._execute(item);
    }
  }

  async _execute(item) {
    try {
      item.attempts++;
      const result = await item.job();
      this.running--;
      this.completed++;
      item.resolve(result);
      this.emit('completed', { result });
      this._process();
    } catch (err) {
      if (item.attempts < this.retries) {
        this.pending.unshift(item);
        this.running--;
        this._process();
      } else {
        this.running--;
        this.failed++;
        item.reject(err);
        this.emit('failed', { error: err });
        this._process();
      }
    }
  }

  stats() {
    return {
      pending: this.pending.length,
      running: this.running,
      completed: this.completed,
      failed: this.failed,
    };
  }
}

module.exports = { JobQueue };
