class NotificationService {
  constructor(providers) {
    this.providers = providers;
    this.queue = [];
    this.sent = 0;
    this.failed = 0;
  }

  async send(notification) {
    const { type, recipient, subject, body, priority = 'normal' } = notification;
    
    if (!this.providers[type]) {
      throw new Error(`Unknown notification type: ${type}`);
    }

    if (priority === 'high') {
      return this._sendImmediately(type, { recipient, subject, body });
    } else {
      this.queue.push({ type, recipient, subject, body, scheduledAt: Date.now() });
    }
  }

  async _sendImmediately(type, payload) {
    try {
      await this.providers[type].send(payload);
      this.sent++;
      return { success: true };
    } catch (err) {
      this.failed++;
      throw err;
    }
  }

  async flush() {
    const items = [...this.queue];
    this.queue = [];
    const results = await Promise.allSettled(
      items.map(item => this._sendImmediately(item.type, item))
    );
    return results.map((r, i) => ({ item: items[i], ...r }));
  }

  stats() {
    return { queued: this.queue.length, sent: this.sent, failed: this.failed };
  }
}

function formatEmailBody(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] || '');
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhoneNumber(phone) {
  return /^\+?[\d\s\-().]{7,20}$/.test(phone);
}

module.exports = { NotificationService, formatEmailBody, validateEmail, validatePhoneNumber };
