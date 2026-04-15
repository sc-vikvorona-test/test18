'use strict';

/**
 * E-Commerce Platform - Core Business Logic
 * Handles orders, inventory, pricing, shipping, customers, and analytics
 */

const EventEmitter = require('events');
const crypto = require('crypto');

// ============================================================
// INVENTORY MANAGEMENT
// ============================================================

class InventoryManager {
  constructor() {
    this.stock = new Map();
    this.reservations = new Map();
    this.lowStockThreshold = 10;
    this.restockQueue = [];
  }

  addProduct(productId, quantity, warehouseId) {
    const key = `${productId}:${warehouseId}`;
    const current = this.stock.get(key) || { quantity: 0, reserved: 0 };
    current.quantity += quantity;
    this.stock.set(key, current);
    this.checkRestockQueue(productId);
  }

  getAvailableStock(productId, warehouseId) {
    const key = `${productId}:${warehouseId}`;
    const entry = this.stock.get(key);
    if (!entry) return 0;
    return entry.quantity - entry.reserved;
  }

  reserveStock(productId, quantity, warehouseId, orderId) {
    const available = this.getAvailableStock(productId, warehouseId);
    if (available < quantity) {
      return { success: false, reason: 'insufficient_stock', available };
    }

    const key = `${productId}:${warehouseId}`;
    const entry = this.stock.get(key);
    entry.reserved += quantity;

    const reservationId = `res_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    this.reservations.set(reservationId, {
      productId,
      quantity,
      warehouseId,
      orderId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 15 * 60 * 1000 // 15 min
    });

    return { success: true, reservationId };
  }

  commitReservation(reservationId) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return false;

    const key = `${reservation.productId}:${reservation.warehouseId}`;
    const entry = this.stock.get(key);
    if (!entry) return false;

    entry.quantity -= reservation.quantity;
    entry.reserved -= reservation.quantity;
    this.reservations.delete(reservationId);

    if (entry.quantity <= this.lowStockThreshold) {
      this.triggerRestockAlert(reservation.productId, entry.quantity);
    }

    return true;
  }

  releaseReservation(reservationId) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return false;

    const key = `${reservation.productId}:${reservation.warehouseId}`;
    const entry = this.stock.get(key);
    if (entry) {
      entry.reserved -= reservation.quantity;
    }

    this.reservations.delete(reservationId);
    return true;
  }

  expireStaleReservations() {
    const now = Date.now();
    for (const [id, reservation] of this.reservations) {
      if (reservation.expiresAt < now) {
        this.releaseReservation(id);
      }
    }
  }

  triggerRestockAlert(productId, currentStock) {
    this.restockQueue.push({ productId, currentStock, alertedAt: Date.now() });
  }

  checkRestockQueue(productId) {
    this.restockQueue = this.restockQueue.filter(item => item.productId !== productId);
  }

  transferStock(productId, quantity, fromWarehouse, toWarehouse) {
    const available = this.getAvailableStock(productId, fromWarehouse);
    if (available < quantity) {
      return { success: false, reason: 'insufficient_stock' };
    }

    const fromKey = `${productId}:${fromWarehouse}`;
    const toKey = `${productId}:${toWarehouse}`;

    const fromEntry = this.stock.get(fromKey);
    fromEntry.quantity -= quantity;

    const toEntry = this.stock.get(toKey) || { quantity: 0, reserved: 0 };
    toEntry.quantity += quantity;
    this.stock.set(toKey, toEntry);

    return { success: true };
  }

  getStockReport() {
    const report = [];
    for (const [key, entry] of this.stock) {
      const [productId, warehouseId] = key.split(':');
      report.push({
        productId,
        warehouseId,
        total: entry.quantity,
        reserved: entry.reserved,
        available: entry.quantity - entry.reserved
      });
    }
    return report;
  }
}

// ============================================================
// PRICING ENGINE
// ============================================================

class PricingEngine {
  constructor() {
    this.basePrices = new Map();
    this.priceRules = [];
    this.customerTiers = { STANDARD: 0, SILVER: 0.05, GOLD: 0.10, PLATINUM: 0.15 };
    this.volumeDiscounts = [
      { minQty: 10, discount: 0.05 },
      { minQty: 50, discount: 0.10 },
      { minQty: 100, discount: 0.15 },
      { minQty: 500, discount: 0.20 },
    ];
  }

  setBasePrice(productId, price, currency = 'USD') {
    this.basePrices.set(`${productId}:${currency}`, price);
  }

  getBasePrice(productId, currency = 'USD') {
    return this.basePrices.get(`${productId}:${currency}`) || null;
  }

  addPriceRule(rule) {
    this.priceRules.push({
      ...rule,
      id: `rule_${Date.now()}`,
      active: true,
      createdAt: Date.now()
    });
    // Sort by priority
    this.priceRules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  calculatePrice(productId, quantity, customer, currency = 'USD', promoCode = null) {
    const basePrice = this.getBasePrice(productId, currency);
    if (basePrice === null) return null;

    let price = basePrice;
    const appliedDiscounts = [];

    // Apply customer tier discount
    const tierDiscount = this.customerTiers[customer.tier] || 0;
    if (tierDiscount > 0) {
      appliedDiscounts.push({ type: 'tier', rate: tierDiscount });
      price = price * (1 - tierDiscount);
    }

    // Apply volume discount
    const volumeDiscount = this.getVolumeDiscount(quantity);
    if (volumeDiscount > 0) {
      appliedDiscounts.push({ type: 'volume', rate: volumeDiscount });
      price = price * (1 - volumeDiscount);
    }

    // Apply active price rules
    for (const rule of this.priceRules) {
      if (!rule.active) continue;
      if (!this.ruleApplies(rule, productId, customer, quantity)) continue;

      if (rule.type === 'percentage') {
        price = price * (1 - rule.value);
        appliedDiscounts.push({ type: 'rule', ruleId: rule.id, rate: rule.value });
      } else if (rule.type === 'fixed') {
        price = price - rule.value;
        appliedDiscounts.push({ type: 'rule', ruleId: rule.id, amount: rule.value });
      }
    }

    // Apply promo code
    if (promoCode) {
      const promoDiscount = this.applyPromoCode(promoCode, price, customer);
      if (promoDiscount) {
        price -= promoDiscount.amount;
        appliedDiscounts.push({ type: 'promo', code: promoCode, amount: promoDiscount.amount });
      }
    }

    price = Math.max(0, price);

    return {
      unitPrice: price,
      totalPrice: price * quantity,
      basePrice,
      appliedDiscounts,
      currency,
      quantity
    };
  }

  getVolumeDiscount(quantity) {
    let discount = 0;
    for (const tier of this.volumeDiscounts) {
      if (quantity >= tier.minQty) {
        discount = tier.discount;
      }
    }
    return discount;
  }

  ruleApplies(rule, productId, customer, quantity) {
    if (rule.productIds && !rule.productIds.includes(productId)) return false;
    if (rule.customerTiers && !rule.customerTiers.includes(customer.tier)) return false;
    if (rule.minQuantity && quantity < rule.minQuantity) return false;
    if (rule.validFrom && Date.now() < rule.validFrom) return false;
    if (rule.validUntil && Date.now() > rule.validUntil) return false;
    return true;
  }

  applyPromoCode(code, price, customer) {
    // Simplified promo lookup
    const promoCodes = {
      'WELCOME10': { type: 'percentage', value: 0.10 },
      'SAVE20': { type: 'percentage', value: 0.20 },
      'FLAT50': { type: 'fixed', value: 50 },
    };

    const promo = promoCodes[code.toUpperCase()];
    if (!promo) return null;

    if (promo.type === 'percentage') {
      return { amount: price * promo.value };
    } else {
      return { amount: Math.min(promo.value, price) };
    }
  }

  updateBulkPrices(updates, currency = 'USD') {
    let updated = 0;
    for (const { productId, price } of updates) {
      if (price >= 0) {
        this.setBasePrice(productId, price, currency);
        updated++;
      }
    }
    return updated;
  }
}

// ============================================================
// ORDER PROCESSOR
// ============================================================

class OrderProcessor extends EventEmitter {
  constructor(inventory, pricing, shippingService, paymentGateway) {
    super();
    this.inventory = inventory;
    this.pricing = pricing;
    this.shipping = shippingService;
    this.payment = paymentGateway;
    this.orders = new Map();
    this.ordersByCustomer = new Map();
    this.statuses = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'];
  }

  async createOrder(customerId, items, shippingAddress, paymentMethod, promoCode = null) {
    const orderId = `ord_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const customer = { id: customerId, tier: 'STANDARD' }; // Simplified

    // Validate and price each item
    const pricedItems = [];
    const reservations = [];

    for (const item of items) {
      const pricing = this.pricing.calculatePrice(
        item.productId, item.quantity, customer, 'USD', promoCode
      );

      if (!pricing) {
        await this.releaseAllReservations(reservations);
        return { success: false, error: `Product ${item.productId} not found` };
      }

      // Reserve stock
      const reservation = this.inventory.reserveStock(
        item.productId, item.quantity, item.warehouseId || 'default', orderId
      );

      if (!reservation.success) {
        await this.releaseAllReservations(reservations);
        return {
          success: false,
          error: `Insufficient stock for ${item.productId}`,
          available: reservation.available
        };
      }

      reservations.push(reservation.reservationId);
      pricedItems.push({ ...item, ...pricing, reservationId: reservation.reservationId });
    }

    // Calculate shipping
    const subtotal = pricedItems.reduce((sum, item) => sum + item.totalPrice, 0);
    const shippingCost = await this.shipping.calculateCost(shippingAddress, pricedItems, subtotal);
    const tax = this.calculateTax(subtotal, shippingAddress);
    const total = subtotal + shippingCost + tax;

    const order = {
      id: orderId,
      customerId,
      items: pricedItems,
      subtotal,
      shippingCost,
      tax,
      total,
      currency: 'USD',
      shippingAddress,
      paymentMethod,
      promoCode,
      status: 'PENDING',
      reservations,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: [{ status: 'PENDING', timestamp: Date.now() }]
    };

    this.orders.set(orderId, order);

    const customerOrders = this.ordersByCustomer.get(customerId) || [];
    customerOrders.push(orderId);
    this.ordersByCustomer.set(customerId, customerOrders);

    this.emit('order:created', order);

    return { success: true, orderId, order };
  }

  async confirmOrder(orderId, paymentToken) {
    const order = this.orders.get(orderId);
    if (!order) return { success: false, error: 'Order not found' };
    if (order.status !== 'PENDING') return { success: false, error: 'Order not in pending state' };

    const paymentResult = await this.payment.charge({
      token: paymentToken,
      amount: order.total,
      currency: order.currency,
      orderId
    });

    if (!paymentResult.success) {
      await this.releaseAllReservations(order.reservations);
      this.updateOrderStatus(orderId, 'CANCELLED', { reason: 'payment_failed' });
      return { success: false, error: 'Payment failed', details: paymentResult.error };
    }

    // Commit all reservations
    for (const reservationId of order.reservations) {
      this.inventory.commitReservation(reservationId);
    }

    order.paymentId = paymentResult.transactionId;
    order.reservations = []; // Cleared after commit
    this.updateOrderStatus(orderId, 'CONFIRMED', { paymentId: paymentResult.transactionId });
    this.emit('order:confirmed', order);

    return { success: true, order };
  }

  async cancelOrder(orderId, reason, initiatedBy = 'customer') {
    const order = this.orders.get(orderId);
    if (!order) return { success: false, error: 'Order not found' };

    const cancellableStatuses = ['PENDING', 'CONFIRMED', 'PROCESSING'];
    if (!cancellableStatuses.includes(order.status)) {
      return { success: false, error: `Cannot cancel order in ${order.status} status` };
    }

    // Release any remaining reservations
    await this.releaseAllReservations(order.reservations);
    order.reservations = [];

    // Process refund if payment was taken
    if (order.paymentId && order.status !== 'PENDING') {
      const refund = await this.payment.refund(order.paymentId, order.total);
      if (!refund.success) {
        // Log but don't block cancellation
        this.emit('refund:failed', { orderId, paymentId: order.paymentId, error: refund.error });
      } else {
        order.refundId = refund.refundId;
      }
    }

    this.updateOrderStatus(orderId, 'CANCELLED', { reason, initiatedBy });
    this.emit('order:cancelled', order);

    return { success: true, order };
  }

  updateOrderStatus(orderId, status, metadata = {}) {
    const order = this.orders.get(orderId);
    if (!order) return false;

    order.status = status;
    order.updatedAt = Date.now();
    order.history.push({ status, timestamp: Date.now(), ...metadata });

    return true;
  }

  async releaseAllReservations(reservations) {
    for (const reservationId of reservations) {
      this.inventory.releaseReservation(reservationId);
    }
  }

  calculateTax(subtotal, address) {
    const taxRates = { US: { CA: 0.0975, NY: 0.08, TX: 0.0825, FL: 0.07 } };
    const countryRates = taxRates[address.country] || {};
    const rate = countryRates[address.state] || 0.0;
    return Math.round(subtotal * rate * 100) / 100;
  }

  getOrder(orderId) {
    return this.orders.get(orderId) || null;
  }

  getCustomerOrders(customerId, { status, limit = 20, offset = 0 } = {}) {
    const orderIds = this.ordersByCustomer.get(customerId) || [];
    let orders = orderIds.map(id => this.orders.get(id)).filter(Boolean);

    if (status) {
      orders = orders.filter(o => o.status === status);
    }

    orders.sort((a, b) => b.createdAt - a.createdAt);
    return {
      total: orders.length,
      orders: orders.slice(offset, offset + limit)
    };
  }

  getOrderStats(fromTimestamp, toTimestamp) {
    const orders = [...this.orders.values()].filter(
      o => o.createdAt >= fromTimestamp && o.createdAt <= toTimestamp
    );

    const stats = {
      total: orders.length,
      byStatus: {},
      revenue: { total: 0, byDay: {} },
      averageOrderValue: 0
    };

    for (const order of orders) {
      stats.byStatus[order.status] = (stats.byStatus[order.status] || 0) + 1;
      if (['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(order.status)) {
        stats.revenue.total += order.total;
        const day = new Date(order.createdAt).toISOString().slice(0, 10);
        stats.revenue.byDay[day] = (stats.revenue.byDay[day] || 0) + order.total;
      }
    }

    const paidOrders = orders.filter(o =>
      ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(o.status)
    );

    if (paidOrders.length > 0) {
      stats.averageOrderValue = stats.revenue.total / paidOrders.length;
    }

    return stats;
  }
}

// ============================================================
// SHIPPING SERVICE
// ============================================================

class ShippingService {
  constructor() {
    this.carriers = new Map();
    this.shipments = new Map();
    this.rateCache = new Map();
    this.rateCacheTtl = 5 * 60 * 1000; // 5 minutes
  }

  registerCarrier(carrierId, config) {
    this.carriers.set(carrierId, {
      ...config,
      active: true,
      lastHealthCheck: null
    });
  }

  async calculateCost(destination, items, subtotal) {
    const totalWeight = items.reduce((sum, item) => sum + (item.weight || 0.5) * item.quantity, 0);
    const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

    // Free shipping threshold
    if (subtotal >= 100) return 0;

    // Base rate calculation
    let baseCost = 5.99;
    if (totalWeight > 5) baseCost += (totalWeight - 5) * 0.5;
    if (itemCount > 10) baseCost += (itemCount - 10) * 0.25;

    // Destination surcharge
    const internationalCountries = ['CA', 'GB', 'AU', 'DE', 'FR', 'JP'];
    if (destination.country !== 'US') {
      if (internationalCountries.includes(destination.country)) {
        baseCost += 15;
      } else {
        baseCost += 35;
      }
    }

    return Math.round(baseCost * 100) / 100;
  }

  async createShipment(orderId, carrierId, items, fromAddress, toAddress, options = {}) {
    const carrier = this.carriers.get(carrierId);
    if (!carrier || !carrier.active) {
      throw new Error(`Carrier ${carrierId} not available`);
    }

    const shipmentId = `ship_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const trackingNumber = this.generateTrackingNumber(carrierId);

    const shipment = {
      id: shipmentId,
      orderId,
      carrierId,
      trackingNumber,
      items,
      fromAddress,
      toAddress,
      status: 'LABEL_CREATED',
      options,
      events: [{ status: 'LABEL_CREATED', timestamp: Date.now(), location: fromAddress.city }],
      estimatedDelivery: this.estimateDelivery(toAddress, options.service || 'STANDARD'),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.shipments.set(shipmentId, shipment);
    return shipment;
  }

  generateTrackingNumber(carrierId) {
    const prefix = { UPS: '1Z', FEDEX: '7489', USPS: '9400' }[carrierId] || 'TRK';
    return prefix + Date.now().toString() + crypto.randomBytes(3).toString('hex').toUpperCase();
  }

  estimateDelivery(destination, service) {
    const now = new Date();
    const businessDays = {
      OVERNIGHT: 1,
      TWO_DAY: 2,
      STANDARD: destination.country === 'US' ? 5 : 14,
      ECONOMY: destination.country === 'US' ? 10 : 21
    };

    const days = businessDays[service] || 7;
    const delivery = new Date(now);
    let added = 0;
    while (added < days) {
      delivery.setDate(delivery.getDate() + 1);
      const dow = delivery.getDay();
      if (dow !== 0 && dow !== 6) added++; // Skip weekends
    }

    return delivery.toISOString().slice(0, 10);
  }

  updateShipmentStatus(shipmentId, status, location, description = '') {
    const shipment = this.shipments.get(shipmentId);
    if (!shipment) return false;

    shipment.status = status;
    shipment.updatedAt = Date.now();
    shipment.events.push({ status, timestamp: Date.now(), location, description });

    return true;
  }

  getShipment(shipmentId) {
    return this.shipments.get(shipmentId) || null;
  }

  getShipmentsByOrder(orderId) {
    const result = [];
    for (const shipment of this.shipments.values()) {
      if (shipment.orderId === orderId) {
        result.push(shipment);
      }
    }
    return result;
  }

  async getCarrierRates(destination, weight, service) {
    const cacheKey = `${destination.country}:${destination.state}:${weight}:${service}`;
    const cached = this.rateCache.get(cacheKey);

    if (cached && Date.now() - cached.fetchedAt < this.rateCacheTtl) {
      return cached.rates;
    }

    // Simulate fetching rates from carriers
    const rates = [];
    for (const [carrierId, carrier] of this.carriers) {
      if (!carrier.active) continue;
      rates.push({
        carrierId,
        service,
        price: 5 + Math.random() * 20,
        estimatedDays: Math.ceil(Math.random() * 10)
      });
    }

    this.rateCache.set(cacheKey, { rates, fetchedAt: Date.now() });
    return rates;
  }
}

// ============================================================
// CUSTOMER ACCOUNT MANAGER
// ============================================================

class CustomerAccountManager extends EventEmitter {
  constructor() {
    super();
    this.customers = new Map();
    this.emailIndex = new Map();
    this.addressBook = new Map();
    this.loyaltyPoints = new Map();
    this.tierThresholds = {
      SILVER: 1000,
      GOLD: 5000,
      PLATINUM: 15000
    };
  }

  async createCustomer(data) {
    if (this.emailIndex.has(data.email.toLowerCase())) {
      return { success: false, error: 'Email already registered' };
    }

    const customerId = `cust_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto
      .createHash('sha256')
      .update(data.password + salt)
      .digest('hex');

    const customer = {
      id: customerId,
      email: data.email.toLowerCase(),
      firstName: data.firstName,
      lastName: data.lastName,
      passwordHash,
      salt,
      phone: data.phone || null,
      tier: 'STANDARD',
      totalSpend: 0,
      orderCount: 0,
      emailVerified: false,
      marketingConsent: data.marketingConsent || false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastLoginAt: null,
      preferences: {}
    };

    this.customers.set(customerId, customer);
    this.emailIndex.set(data.email.toLowerCase(), customerId);
    this.loyaltyPoints.set(customerId, 0);

    this.emit('customer:created', { id: customerId, email: customer.email });

    return { success: true, customerId, customer: this.sanitizeCustomer(customer) };
  }

  async authenticate(email, password) {
    const customerId = this.emailIndex.get(email.toLowerCase());
    if (!customerId) {
      // Constant-time comparison to prevent timing attacks
      crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
      return { success: false, error: 'Invalid credentials' };
    }

    const customer = this.customers.get(customerId);
    const inputHash = crypto
      .createHash('sha256')
      .update(password + customer.salt)
      .digest('hex');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(inputHash),
      Buffer.from(customer.passwordHash)
    );

    if (!isValid) {
      return { success: false, error: 'Invalid credentials' };
    }

    customer.lastLoginAt = Date.now();
    this.emit('customer:login', { customerId, timestamp: customer.lastLoginAt });

    return { success: true, customer: this.sanitizeCustomer(customer) };
  }

  updateCustomer(customerId, updates) {
    const customer = this.customers.get(customerId);
    if (!customer) return { success: false, error: 'Customer not found' };

    const allowedFields = ['firstName', 'lastName', 'phone', 'marketingConsent', 'preferences'];
    const filteredUpdates = {};
    for (const field of allowedFields) {
      if (field in updates) filteredUpdates[field] = updates[field];
    }

    // Handle email change
    if (updates.email && updates.email.toLowerCase() !== customer.email) {
      if (this.emailIndex.has(updates.email.toLowerCase())) {
        return { success: false, error: 'Email already in use' };
      }
      this.emailIndex.delete(customer.email);
      customer.email = updates.email.toLowerCase();
      this.emailIndex.set(customer.email, customerId);
      customer.emailVerified = false;
    }

    Object.assign(customer, filteredUpdates);
    customer.updatedAt = Date.now();

    return { success: true, customer: this.sanitizeCustomer(customer) };
  }

  addAddress(customerId, address) {
    const customer = this.customers.get(customerId);
    if (!customer) return { success: false, error: 'Customer not found' };

    const addressId = `addr_${Date.now()}`;
    const addresses = this.addressBook.get(customerId) || [];

    const newAddress = {
      id: addressId,
      ...address,
      isDefault: addresses.length === 0 // First address is default
    };

    addresses.push(newAddress);
    this.addressBook.set(customerId, addresses);

    return { success: true, addressId, address: newAddress };
  }

  getAddresses(customerId) {
    return this.addressBook.get(customerId) || [];
  }

  setDefaultAddress(customerId, addressId) {
    const addresses = this.addressBook.get(customerId);
    if (!addresses) return false;

    let found = false;
    addresses.forEach(addr => {
      addr.isDefault = addr.id === addressId;
      if (addr.isDefault) found = true;
    });

    return found;
  }

  recordPurchase(customerId, amount) {
    const customer = this.customers.get(customerId);
    if (!customer) return;

    customer.totalSpend += amount;
    customer.orderCount++;
    customer.updatedAt = Date.now();

    // Award loyalty points (1 point per dollar)
    const points = Math.floor(amount);
    const currentPoints = this.loyaltyPoints.get(customerId) || 0;
    this.loyaltyPoints.set(customerId, currentPoints + points);

    // Update tier
    const newTier = this.calculateTier(customer.totalSpend);
    if (newTier !== customer.tier) {
      const oldTier = customer.tier;
      customer.tier = newTier;
      this.emit('customer:tier_upgraded', { customerId, oldTier, newTier });
    }
  }

  calculateTier(totalSpend) {
    if (totalSpend >= this.tierThresholds.PLATINUM) return 'PLATINUM';
    if (totalSpend >= this.tierThresholds.GOLD) return 'GOLD';
    if (totalSpend >= this.tierThresholds.SILVER) return 'SILVER';
    return 'STANDARD';
  }

  getLoyaltyPoints(customerId) {
    return this.loyaltyPoints.get(customerId) || 0;
  }

  redeemPoints(customerId, points) {
    const current = this.loyaltyPoints.get(customerId) || 0;
    if (current < points) return { success: false, available: current };
    this.loyaltyPoints.set(customerId, current - points);
    return { success: true, redeemed: points, remaining: current - points };
  }

  sanitizeCustomer(customer) {
    const { passwordHash, salt, ...safe } = customer;
    return safe;
  }

  getCustomer(customerId) {
    const customer = this.customers.get(customerId);
    if (!customer) return null;
    return this.sanitizeCustomer(customer);
  }

  searchCustomers({ query, tier, minSpend, maxSpend, limit = 20, offset = 0 }) {
    let results = [...this.customers.values()];

    if (query) {
      const q = query.toLowerCase();
      results = results.filter(c =>
        c.email.includes(q) ||
        c.firstName.toLowerCase().includes(q) ||
        c.lastName.toLowerCase().includes(q)
      );
    }

    if (tier) results = results.filter(c => c.tier === tier);
    if (minSpend !== undefined) results = results.filter(c => c.totalSpend >= minSpend);
    if (maxSpend !== undefined) results = results.filter(c => c.totalSpend <= maxSpend);

    return {
      total: results.length,
      customers: results
        .slice(offset, offset + limit)
        .map(c => this.sanitizeCustomer(c))
    };
  }
}

// ============================================================
// ANALYTICS ENGINE
// ============================================================

class AnalyticsEngine {
  constructor() {
    this.events = [];
    this.sessionData = new Map();
    this.funnels = new Map();
    this.cohorts = new Map();
    this.maxEventsInMemory = 100000;
  }

  track(eventName, properties = {}, sessionId = null, timestamp = Date.now()) {
    const event = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      name: eventName,
      properties,
      sessionId,
      timestamp
    };

    this.events.push(event);

    // Trim if over limit
    if (this.events.length > this.maxEventsInMemory) {
      this.events = this.events.slice(-this.maxEventsInMemory);
    }

    // Update session
    if (sessionId) {
      this.updateSession(sessionId, event);
    }

    return event.id;
  }

  updateSession(sessionId, event) {
    const session = this.sessionData.get(sessionId) || {
      id: sessionId,
      startedAt: event.timestamp,
      events: [],
      lastActivity: event.timestamp,
      pageViews: 0,
      conversions: 0
    };

    session.events.push(event.id);
    session.lastActivity = event.timestamp;

    if (event.name === 'page_view') session.pageViews++;
    if (event.name === 'purchase_completed') session.conversions++;

    this.sessionData.set(sessionId, session);
  }

  defineFunnel(funnelId, steps) {
    this.funnels.set(funnelId, { steps, createdAt: Date.now() });
  }

  analyzeFunnel(funnelId, fromTimestamp, toTimestamp, groupBy = null) {
    const funnel = this.funnels.get(funnelId);
    if (!funnel) return null;

    const relevantEvents = this.events.filter(
      e => e.timestamp >= fromTimestamp && e.timestamp <= toTimestamp
    );

    const stepCounts = funnel.steps.map(step => ({ step, count: 0, sessions: new Set() }));

    // Group events by session
    const eventsBySession = {};
    for (const event of relevantEvents) {
      if (!event.sessionId) continue;
      if (!eventsBySession[event.sessionId]) {
        eventsBySession[event.sessionId] = [];
      }
      eventsBySession[event.sessionId].push(event);
    }

    // Track which sessions completed each step
    for (const [sessionId, events] of Object.entries(eventsBySession)) {
      const eventNames = events.map(e => e.name);
      let lastIndex = -1;

      for (let i = 0; i < funnel.steps.length; i++) {
        const stepIdx = eventNames.indexOf(funnel.steps[i], lastIndex + 1);
        if (stepIdx === -1) break;
        stepCounts[i].count++;
        stepCounts[i].sessions.add(sessionId);
        lastIndex = stepIdx;
      }
    }

    return {
      funnelId,
      steps: stepCounts.map((s, i) => ({
        step: s.step,
        count: s.count,
        conversionRate: i === 0 ? 1 : (stepCounts[0].count > 0 ? s.count / stepCounts[0].count : 0),
        dropOffRate: i === 0 ? 0 : (stepCounts[i-1].count > 0 ? 1 - s.count / stepCounts[i-1].count : 0)
      })),
      period: { from: fromTimestamp, to: toTimestamp }
    };
  }

  getTopProducts(fromTimestamp, toTimestamp, limit = 10) {
    const purchaseEvents = this.events.filter(
      e => e.name === 'product_purchased' &&
           e.timestamp >= fromTimestamp &&
           e.timestamp <= toTimestamp
    );

    const productStats = {};
    for (const event of purchaseEvents) {
      const pid = event.properties.productId;
      if (!pid) continue;
      if (!productStats[pid]) {
        productStats[pid] = { productId: pid, quantity: 0, revenue: 0, orders: 0 };
      }
      productStats[pid].quantity += event.properties.quantity || 1;
      productStats[pid].revenue += event.properties.revenue || 0;
      productStats[pid].orders++;
    }

    return Object.values(productStats)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
  }

  getRevenueByDay(fromTimestamp, toTimestamp) {
    const purchaseEvents = this.events.filter(
      e => e.name === 'purchase_completed' &&
           e.timestamp >= fromTimestamp &&
           e.timestamp <= toTimestamp
    );

    const byDay = {};
    for (const event of purchaseEvents) {
      const day = new Date(event.timestamp).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = { date: day, revenue: 0, orders: 0 };
      byDay[day].revenue += event.properties.total || 0;
      byDay[day].orders++;
    }

    return Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
  }

  getConversionRate(fromTimestamp, toTimestamp) {
    const sessions = [...this.sessionData.values()].filter(
      s => s.startedAt >= fromTimestamp && s.startedAt <= toTimestamp
    );

    if (sessions.length === 0) return 0;
    const converted = sessions.filter(s => s.conversions > 0).length;
    return converted / sessions.length;
  }

  buildCohort(cohortId, cohortDate, userIds) {
    this.cohorts.set(cohortId, {
      date: cohortDate,
      users: new Set(userIds),
      size: userIds.length
    });
  }

  getCohortRetention(cohortId, periods) {
    const cohort = this.cohorts.get(cohortId);
    if (!cohort) return null;

    return {
      cohortId,
      size: cohort.size,
      retention: periods.map(period => ({
        period,
        retained: Math.floor(cohort.size * Math.exp(-0.3 * period)), // Simulated
        rate: Math.exp(-0.3 * period)
      }))
    };
  }
}

// ============================================================
// PRODUCT CATALOG
// ============================================================

class ProductCatalog {
  constructor() {
    this.products = new Map();
    this.categories = new Map();
    this.tags = new Map();
    this.searchIndex = new Map();
  }

  addProduct(product) {
    const id = product.id || `prod_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const catalogEntry = {
      id,
      name: product.name,
      description: product.description || '',
      categoryId: product.categoryId,
      tags: product.tags || [],
      attributes: product.attributes || {},
      images: product.images || [],
      weight: product.weight || 0,
      dimensions: product.dimensions || null,
      isActive: product.isActive !== false,
      isDigital: product.isDigital || false,
      sku: product.sku,
      barcode: product.barcode || null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.products.set(id, catalogEntry);
    this.indexProduct(catalogEntry);

    return id;
  }

  indexProduct(product) {
    const words = [
      ...product.name.toLowerCase().split(/\s+/),
      ...product.description.toLowerCase().split(/\s+/),
      ...product.tags.map(t => t.toLowerCase())
    ];

    for (const word of words) {
      if (word.length < 2) continue;
      const ids = this.searchIndex.get(word) || new Set();
      ids.add(product.id);
      this.searchIndex.set(word, ids);
    }
  }

  search(query, { categoryId, tags, isActive, limit = 20, offset = 0 } = {}) {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    let candidateIds = null;

    for (const word of queryWords) {
      const ids = this.searchIndex.get(word) || new Set();
      if (candidateIds === null) {
        candidateIds = new Set(ids);
      } else {
        // Intersection for AND search
        for (const id of candidateIds) {
          if (!ids.has(id)) candidateIds.delete(id);
        }
      }
    }

    let results = candidateIds
      ? [...candidateIds].map(id => this.products.get(id)).filter(Boolean)
      : [...this.products.values()];

    if (categoryId) results = results.filter(p => p.categoryId === categoryId);
    if (tags && tags.length > 0) {
      results = results.filter(p => tags.some(t => p.tags.includes(t)));
    }
    if (isActive !== undefined) results = results.filter(p => p.isActive === isActive);

    return {
      total: results.length,
      products: results.slice(offset, offset + limit)
    };
  }

  getProduct(productId) {
    return this.products.get(productId) || null;
  }

  updateProduct(productId, updates) {
    const product = this.products.get(productId);
    if (!product) return false;

    // Re-index if name/description/tags changed
    const needsReindex = 'name' in updates || 'description' in updates || 'tags' in updates;

    Object.assign(product, updates);
    product.updatedAt = Date.now();

    if (needsReindex) {
      this.indexProduct(product);
    }

    return true;
  }

  addCategory(categoryId, name, parentId = null) {
    this.categories.set(categoryId, { id: categoryId, name, parentId, createdAt: Date.now() });
  }

  getProductsByCategory(categoryId, includeSubcategories = false) {
    let categoryIds = [categoryId];

    if (includeSubcategories) {
      for (const [id, cat] of this.categories) {
        if (this.isDescendant(id, categoryId)) {
          categoryIds.push(id);
        }
      }
    }

    return [...this.products.values()].filter(
      p => categoryIds.includes(p.categoryId) && p.isActive
    );
  }

  isDescendant(categoryId, ancestorId) {
    const category = this.categories.get(categoryId);
    if (!category) return false;
    if (category.parentId === ancestorId) return true;
    if (category.parentId) return this.isDescendant(category.parentId, ancestorId);
    return false;
  }

  getRelatedProducts(productId, limit = 5) {
    const product = this.products.get(productId);
    if (!product) return [];

    const scores = new Map();

    for (const [id, other] of this.products) {
      if (id === productId || !other.isActive) continue;

      let score = 0;
      if (other.categoryId === product.categoryId) score += 3;
      for (const tag of product.tags) {
        if (other.tags.includes(tag)) score += 1;
      }

      if (score > 0) scores.set(id, score);
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => this.products.get(id));
  }
}

// ============================================================
// PAYMENT GATEWAY (Stub)
// ============================================================

class PaymentGateway {
  constructor() {
    this.transactions = new Map();
    this.refunds = new Map();
  }

  async charge({ token, amount, currency, orderId }) {
    // Simulate payment processing
    const transactionId = `txn_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const transaction = {
      id: transactionId,
      token,
      amount,
      currency,
      orderId,
      status: 'captured',
      createdAt: Date.now()
    };

    this.transactions.set(transactionId, transaction);

    return { success: true, transactionId };
  }

  async refund(transactionId, amount) {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) return { success: false, error: 'Transaction not found' };

    const refundId = `ref_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const refund = {
      id: refundId,
      transactionId,
      amount,
      status: 'refunded',
      createdAt: Date.now()
    };

    this.refunds.set(refundId, refund);
    return { success: true, refundId };
  }
}

// ============================================================
// MODULE EXPORTS
// ============================================================

module.exports = {
  InventoryManager,
  PricingEngine,
  OrderProcessor,
  ShippingService,
  CustomerAccountManager,
  AnalyticsEngine,
  ProductCatalog,
  PaymentGateway
};
