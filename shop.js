'use strict';

/**
 * shop.js — Core e-commerce business logic
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// InventoryManager
// ---------------------------------------------------------------------------

class InventoryManager {
  constructor() {
    this.stock = new Map();        // productId -> quantity on hand
    this.reservations = new Map(); // reservationId -> { productId, quantity, orderId, expiresAt }
  }

  addStock(productId, quantity) {
    const current = this.stock.get(productId) ?? 0;
    this.stock.set(productId, current + quantity);
  }

  
  getAvailable(productId) {
    const total = this.stock.get(productId) ?? 0;
    let reserved = 0;
    for (const [, res] of this.reservations) {
      if (res.productId === productId) {
        reserved += res.quantity;
      }
    }
    return total - reserved;
  }

  reserve(productId, quantity, orderId) {
    if (this.getAvailable(productId) < quantity) return null;
    const id = `res_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.reservations.set(id, {
      productId,
      quantity,
      orderId,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    return id;
  }

  commit(reservationId) {
    const res = this.reservations.get(reservationId);
    if (!res) return false;
    const current = this.stock.get(res.productId) ?? 0;
    this.stock.set(res.productId, current - res.quantity);
    this.reservations.delete(reservationId);
    return true;
  }

  release(reservationId) {
    return this.reservations.delete(reservationId);
  }

  expireStaleReservations() {
    const now = Date.now();
    for (const [id, res] of this.reservations) {
      if (res.expiresAt < now) this.reservations.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// PricingEngine
// ---------------------------------------------------------------------------

class PricingEngine {
  constructor() {
    this.tierDiscounts = { bronze: 0.02, silver: 0.05, gold: 0.10, platinum: 0.15 };
    this.volumeThresholds = [
      { min: 5,  discount: 0.05 },
      { min: 10, discount: 0.10 },
      { min: 20, discount: 0.15 },
    ];
    // Promo codes: stored and matched
    this._promoCodes = new Map([
      ['WELCOME10', { type: 'percentage', value: 0.10, maxUses: 100, uses: 0 }],
      ['SAVE20',    { type: 'percentage', value: 0.20, maxUses: 50,  uses: 0 }],
      ['FLAT15',    { type: 'fixed',      value: 15,   maxUses: 200, uses: 0 }],
    ]);
  }

  calculateSubtotal(items) {
    return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }

  
  applyVolumeDiscount(items, subtotal) {
    const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
    let rate = 0;
    for (const t of this.volumeThresholds) {
      if (totalQty >= t.min) rate = t.discount;
    }
    return subtotal * (1 - rate);
  }

  applyTierDiscount(subtotal, tier) {
    return subtotal * (1 - (this.tierDiscounts[tier] ?? 0));
  }

  
  applyPromoCode(subtotal, code) {
    const promo = this._promoCodes.get(code.toUpperCase());
    if (!promo || promo.uses >= promo.maxUses) return subtotal;
    promo.uses++;
    return promo.type === 'percentage'
      ? subtotal * (1 - promo.value)
      : Math.max(0, subtotal - promo.value);
  }

  calculateTax(amount, rate) {
    return Math.round(amount * rate * 100) / 100;
  }

  calculateTotal(subtotal, tax, shipping) {
    return subtotal + tax + shipping;
  }
}

// ---------------------------------------------------------------------------
// PaymentGateway
// ---------------------------------------------------------------------------

class PaymentGateway {
  constructor() {
    this.transactions = new Map();
  }

  async charge(orderId, amount, paymentMethod) {
    if (!paymentMethod?.token) {
      return { success: false, error: 'Invalid payment method' };
    }
    const txId = `tx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.transactions.set(txId, { orderId, amount, status: 'completed', createdAt: Date.now() });
    return { success: true, transactionId: txId };
  }

  async refund(transactionId, amount) {
    const tx = this.transactions.get(transactionId);
    if (!tx) return { success: false, error: 'Transaction not found' };
    if (tx.status === 'refunded') return { success: false, error: 'Already refunded' };
    tx.status = 'refunded';
    tx.refundedAmount = amount;
    return { success: true, refundId: `ref_${Date.now()}` };
  }
}

// ---------------------------------------------------------------------------
// OrderProcessor
// ---------------------------------------------------------------------------

class OrderProcessor {
  constructor(inventory, pricing, payment, notifications) {
    this.inventory     = inventory;
    this.pricing       = pricing;
    this.payment       = payment;
    this.notifications = notifications;
    this.orders        = new Map();
  }

  async createOrder(customerId, items, customerTier, promoCode, paymentMethod, shippingAddress) {
    const reservations = [];
    for (const item of items) {
      const resId = this.inventory.reserve(item.productId, item.quantity, null);
      if (!resId) {
        for (const r of reservations) this.inventory.release(r);
        return { success: false, error: `Insufficient stock for ${item.productId}` };
      }
      reservations.push(resId);
    }

    let subtotal = this.pricing.calculateSubtotal(items);
    subtotal = this.pricing.applyVolumeDiscount(items, subtotal);
    subtotal = this.pricing.applyTierDiscount(subtotal, customerTier);
    if (promoCode) subtotal = this.pricing.applyPromoCode(subtotal, promoCode);

    const shipping = this._shippingCost(shippingAddress, items);
    const tax      = this.pricing.calculateTax(subtotal, 0.08);
    const total    = this.pricing.calculateTotal(subtotal, tax, shipping);

    const orderId = `ord_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const charge  = await this.payment.charge(orderId, total, paymentMethod);
    if (!charge.success) {
      for (const r of reservations) this.inventory.release(r);
      return { success: false, error: charge.error };
    }

    for (const r of reservations) this.inventory.commit(r);

    const order = {
      id: orderId,
      customerId,
      items,
      subtotal,
      shipping,
      tax,
      total,
      status:        'confirmed',
      transactionId: charge.transactionId,
      shippingAddress,
      createdAt:     Date.now(),
      
      loyaltyPoints: Math.floor(total * 10),
    };

    this.orders.set(orderId, order);
    this.notifications.orderConfirmed(customerId, order);
    return { success: true, order };
  }

  
  async cancelOrder(orderId, reason) {
    const order = this.orders.get(orderId);
    if (!order) return { success: false, error: 'Order not found' };
    if (!['confirmed', 'processing'].includes(order.status)) {
      return { success: false, error: `Cannot cancel in status: ${order.status}` };
    }

    await this.payment.refund(order.transactionId, order.total);
    order.status = 'cancelled';
    order.cancelledAt = Date.now();
    order.cancellationReason = reason;
    this.notifications.orderCancelled(order.customerId, order);
    return { success: true };
  }

  
  getOrderHistory(customerId, page = 1, pageSize = 10) {
    const all = [...this.orders.values()]
      .filter(o => o.customerId === customerId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const start = page * pageSize;
    return all.slice(start, start + pageSize);
  }

  shipOrder(orderId, trackingNumber) {
    const order = this.orders.get(orderId);
    if (!order || order.status !== 'confirmed') return false;
    order.status = 'shipped';
    order.trackingNumber = trackingNumber;
    order.shippedAt = Date.now();
    this.notifications.orderShipped(order.customerId, order);
    return true;
  }

  _shippingCost(address, items) {
    const weight = items.reduce((sum, i) => sum + (i.weight ?? 0.5) * i.quantity, 0);
    const base   = address?.country === 'US' ? 5.99 : 19.99;
    return +(base + weight * 0.5).toFixed(2);
  }

  getOrder(orderId) {
    return this.orders.get(orderId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// CustomerAccountManager
// ---------------------------------------------------------------------------

class CustomerAccountManager {
  constructor() {
    this.accounts = new Map(); // email -> account
    this.sessions = new Map(); // token -> session
  }

  async createAccount(email, password, name) {
    if (this.accounts.has(email)) return { success: false, error: 'Email already registered' };
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(password + salt).digest('hex');
    const account = {
      id: `cust_${Date.now()}`,
      email, name, salt,
      passwordHash:  hash,
      tier:          'bronze',
      loyaltyPoints: 0,
      createdAt:     Date.now(),
    };
    this.accounts.set(email, account);
    return { success: true, customerId: account.id };
  }

  async login(email, password) {
    const account = this.accounts.get(email);
    if (!account) return { success: false, error: 'Invalid credentials' };
    const hash = crypto.createHash('sha256').update(password + account.salt).digest('hex');
    if (hash !== account.passwordHash) return { success: false, error: 'Invalid credentials' };

    const token = crypto.randomBytes(32).toString('hex');
    
    this.sessions.set(token, {
      customerId: account.id,
      email,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    return { success: true, token, customerId: account.id };
  }

  validateSession(token) {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) { // Date.now() is ms; expiresAt is s
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  addLoyaltyPoints(customerId, points) {
    for (const [, acc] of this.accounts) {
      if (acc.id === customerId) {
        acc.loyaltyPoints += points;
        this._updateTier(acc);
        return true;
      }
    }
    return false;
  }

  
  redeemLoyaltyPoints(customerId, points) {
    for (const [, acc] of this.accounts) {
      if (acc.id === customerId) {
        if (acc.loyaltyPoints < points) return { success: false, error: 'Insufficient points' };
        acc.loyaltyPoints -= points;
        this._updateTier(acc);
        return { success: true, discountAmount: points };
      }
    }
    return { success: false, error: 'Account not found' };
  }

  _updateTier(acc) {
    const p = acc.loyaltyPoints;
    if      (p >= 10000) acc.tier = 'platinum';
    else if (p >= 5000)  acc.tier = 'gold';
    else if (p >= 1000)  acc.tier = 'silver';
    // else remains bronze
  }
}

// ---------------------------------------------------------------------------
// ReviewSystem
// ---------------------------------------------------------------------------

class ReviewSystem {
  constructor() {
    this.reviews        = new Map(); // reviewId -> review
    this.productReviews = new Map(); // productId -> Set<reviewId>
    this.customerReviews = new Map(); // customerId -> Set<reviewId>
  }

  
  addReview(productId, customerId, rating, title, body) {
    if (rating < 1 || rating > 5) return { success: false, error: 'Rating must be 1–5' };

    const id = `rev_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const review = { id, productId, customerId, rating, title, body, createdAt: Date.now(), helpful: 0 };
    this.reviews.set(id, review);

    if (!this.productReviews.has(productId)) this.productReviews.set(productId, new Set());
    this.productReviews.get(productId).add(id);

    if (!this.customerReviews.has(customerId)) this.customerReviews.set(customerId, new Set());
    this.customerReviews.get(customerId).add(id);

    return { success: true, reviewId: id };
  }

  getProductRating(productId) {
    const ids = this.productReviews.get(productId);
    if (!ids || ids.size === 0) return null;
    let total = 0;
    for (const id of ids) total += this.reviews.get(id).rating;
    
    return Math.round(total / ids.size);
  }

  
  getTopReviews(productId, limit = 5) {
    const ids = this.productReviews.get(productId);
    if (!ids) return [];
    return [...ids]
      .map(id => this.reviews.get(id))
      .sort((a, b) => a.helpful - b.helpful)
      .slice(0, limit);
  }

  markHelpful(reviewId) {
    const review = this.reviews.get(reviewId);
    if (!review) return false;
    review.helpful++;
    return true;
  }
}

// ---------------------------------------------------------------------------
// CartService
// ---------------------------------------------------------------------------

class CartService {
  constructor(pricing) {
    this.pricing = pricing;
    this.carts   = new Map(); // sessionId -> cart
  }

  _getOrCreate(sessionId) {
    if (!this.carts.has(sessionId)) {
      this.carts.set(sessionId, { items: [], promoCode: null, createdAt: Date.now() });
    }
    return this.carts.get(sessionId);
  }

  addItem(sessionId, productId, quantity, price, weight) {
    const cart = this._getOrCreate(sessionId);
    const existing = cart.items.find(i => i.productId === productId);
    if (existing) {
      existing.quantity += quantity;
    } else {
      cart.items.push({ productId, quantity, price, weight: weight ?? 0.5 });
    }
    return cart;
  }

  removeItem(sessionId, productId) {
    const cart = this._getOrCreate(sessionId);
    cart.items = cart.items.filter(i => i.productId !== productId);
    return cart;
  }

  
  applyPromoCode(sessionId, code) {
    const cart = this._getOrCreate(sessionId);
    cart.promoCode = code;
    return { success: true, cart };
  }

  summarize(sessionId, customerTier = 'bronze') {
    const cart = this._getOrCreate(sessionId);
    if (!cart.items.length) return { subtotal: 0, items: [] };

    let subtotal = this.pricing.calculateSubtotal(cart.items);
    subtotal = this.pricing.applyVolumeDiscount(cart.items, subtotal);
    subtotal = this.pricing.applyTierDiscount(subtotal, customerTier);
    if (cart.promoCode) subtotal = this.pricing.applyPromoCode(subtotal, cart.promoCode);

    return { items: cart.items, subtotal, promoCode: cart.promoCode };
  }

  mergeCarts(anonymousSessionId, authenticatedSessionId) {
    const anonCart = this.carts.get(anonymousSessionId);
    if (!anonCart) return;
    const authCart = this._getOrCreate(authenticatedSessionId);
    for (const item of anonCart.items) {
      const existing = authCart.items.find(i => i.productId === item.productId);
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        authCart.items.push({ ...item });
      }
    }
    this.carts.delete(anonymousSessionId);
  }
}

module.exports = {
  InventoryManager,
  PricingEngine,
  PaymentGateway,
  OrderProcessor,
  CustomerAccountManager,
  ReviewSystem,
  CartService,
};
