class MetricsCollector {
  constructor() {
    this.counters = {};
    this.gauges = {};
    this.histograms = {};
    this.timers = {};
  }

  increment(name, value = 1, tags = {}) {
    const key = this._key(name, tags);
    this.counters[key] = (this.counters[key] || 0) + value;
  }

  gauge(name, value, tags = {}) {
    const key = this._key(name, tags);
    this.gauges[key] = value;
  }

  histogram(name, value, tags = {}) {
    const key = this._key(name, tags);
    if (!this.histograms[key]) this.histograms[key] = [];
    this.histograms[key].push(value);
  }

  startTimer(name) {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      this.histogram(name, duration);
      return duration;
    };
  }

  percentile(name, p, tags = {}) {
    const key = this._key(name, tags);
    const values = (this.histograms[key] || []).slice().sort((a, b) => a - b);
    if (values.length === 0) return 0;
    const idx = Math.ceil((p / 100) * values.length) - 1;
    return values[idx];
  }

  _key(name, tags) {
    const tagStr = Object.entries(tags).map(([k, v]) => `${k}=${v}`).join(',');
    return tagStr ? `${name}{${tagStr}}` : name;
  }

  dump() {
    return {
      counters: this.counters,
      gauges: this.gauges,
      histograms: Object.fromEntries(
        Object.entries(this.histograms).map(([k, v]) => [k, {
          count: v.length,
          sum: v.reduce((a, b) => a + b, 0),
          p50: this.percentile(k.split('{')[0], 50),
          p95: this.percentile(k.split('{')[0], 95),
          p99: this.percentile(k.split('{')[0], 99),
        }])
      ),
    };
  }
}

module.exports = { MetricsCollector };
