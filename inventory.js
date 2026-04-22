// Completely rewritten with event sourcing pattern
const EventEmitter = require('events');

class InventoryEvent {
  constructor(type, payload) {
    this.id = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.type = type;
    this.payload = payload;
    this.timestamp = new Date().toISOString();
  }
}

class InventoryProjection {
  constructor() {
    this.state = new Map(); // sku -> { quantity, price, version }
  }

  apply(event) {
    switch (event.type) {
      case 'ITEM_ADDED': {
        const { sku, quantity, price } = event.payload;
        const current = this.state.get(sku) || { quantity: 0, price: 0, version: 0 };
        this.state.set(sku, { quantity: current.quantity + quantity, price, version: current.version + 1 });
        break;
      }
      case 'ITEM_REMOVED': {
        const { sku, quantity } = event.payload;
        const current = this.state.get(sku);
        if (!current) throw new Error(`SKU not found: ${sku}`);
        if (current.quantity < quantity) throw new Error('Insufficient stock');
        this.state.set(sku, { ...current, quantity: current.quantity - quantity, version: current.version + 1 });
        break;
      }
      case 'PRICE_UPDATED': {
        const { sku, price } = event.payload;
        const current = this.state.get(sku);
        if (!current) throw new Error(`SKU not found: ${sku}`);
        this.state.set(sku, { ...current, price, version: current.version + 1 });
        break;
      }
    }
  }

  getStock(sku) {
    return this.state.get(sku) || null;
  }

  snapshot() {
    return Object.fromEntries(this.state);
  }
}

class EventSourcedInventory extends EventEmitter {
  constructor(eventStore) {
    super();
    this.eventStore = eventStore;
    this.projection = new InventoryProjection();
    this._rebuildProjection();
  }

  _rebuildProjection() {
    const events = this.eventStore.getAll();
    for (const event of events) {
      this.projection.apply(event);
    }
  }

  addItem(sku, quantity, price) {
    const event = new InventoryEvent('ITEM_ADDED', { sku, quantity, price });
    this.eventStore.append(event);
    this.projection.apply(event);
    this.emit('change', event);
    return this.projection.getStock(sku);
  }

  removeItem(sku, quantity) {
    const stock = this.projection.getStock(sku);
    if (!stock || stock.quantity < quantity) throw new Error('Insufficient stock');
    const event = new InventoryEvent('ITEM_REMOVED', { sku, quantity });
    this.eventStore.append(event);
    this.projection.apply(event);
    this.emit('change', event);
    return this.projection.getStock(sku);
  }

  updatePrice(sku, price) {
    const event = new InventoryEvent('PRICE_UPDATED', { sku, price });
    this.eventStore.append(event);
    this.projection.apply(event);
    this.emit('change', event);
    return this.projection.getStock(sku);
  }

  getStock(sku) {
    return this.projection.getStock(sku);
  }

  getHistory(sku) {
    return this.eventStore.getAll().filter(e => e.payload.sku === sku);
  }
}

class InMemoryEventStore {
  constructor() {
    this.events = [];
  }

  append(event) {
    this.events.push(event);
  }

  getAll() {
    return [...this.events];
  }

  getSince(timestamp) {
    return this.events.filter(e => new Date(e.timestamp) > new Date(timestamp));
  }
}

module.exports = { EventSourcedInventory, InMemoryEventStore, InventoryProjection };
