'use strict';

/**
 * E-Commerce Utilities - Search, Recommendations, Reviews, Notifications
 */

const EventEmitter = require('events');
const crypto = require('crypto');

// ============================================================
// SEARCH ENGINE
// ============================================================

class SearchEngine {
  constructor(catalog, analytics) {
    this.catalog = catalog;
    this.analytics = analytics;
    this.queryLog = [];
    this.synonyms = new Map();
    this.stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
    this.boostRules = [];
    this.personalizationEnabled = true;
  }

  addSynonyms(word, synonymList) {
    this.synonyms.set(word.toLowerCase(), synonymList.map(s => s.toLowerCase()));
    for (const synonym of synonymList) {
      if (!this.synonyms.has(synonym.toLowerCase())) {
        this.synonyms.set(synonym.toLowerCase(), [word.toLowerCase()]);
      }
    }
  }

  tokenize(query) {
    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length >= 2 && !this.stopWords.has(token));
  }

  expandTokens(tokens) {
    const expanded = new Set(tokens);
    for (const token of tokens) {
      const syns = this.synonyms.get(token) || [];
      for (const syn of syns) expanded.add(syn);
    }
    return [...expanded];
  }

  async search(query, filters = {}, customerId = null, sessionId = null) {
    const startTime = Date.now();
    const tokens = this.tokenize(query);
    const expandedTokens = this.expandTokens(tokens);

    // Log the query
    this.queryLog.push({
      query,
      tokens,
      customerId,
      sessionId,
      timestamp: Date.now()
    });

    if (this.queryLog.length > 10000) {
      this.queryLog = this.queryLog.slice(-10000);
    }

    // Get base results from catalog
    const results = this.catalog.search(expandedTokens.join(' '), filters);

    // Apply boosting rules
    const boostedResults = this.applyBoosts(results.products, query, customerId);

    // Apply personalization if enabled
    let personalizedResults = boostedResults;
    if (this.personalizationEnabled && customerId) {
      personalizedResults = await this.personalize(boostedResults, customerId);
    }

    // Track analytics
    if (analytics && sessionId) {
      this.analytics.track('search', {
        query,
        resultCount: results.total,
        hasResults: results.total > 0,
        filters
      }, sessionId);
    }

    return {
      query,
      total: results.total,
      products: personalizedResults,
      took: Date.now() - startTime,
      suggestions: results.total === 0 ? this.getSuggestions(tokens) : []
    };
  }

  applyBoosts(products, query, customerId) {
    const boosted = products.map(p => ({ ...p, _score: 1.0 }));

    for (const rule of this.boostRules) {
      if (!this.ruleMatches(rule, query)) continue;

      for (const product of boosted) {
        if (rule.productIds && rule.productIds.includes(product.id)) {
          product._score *= rule.factor;
        }
        if (rule.categoryIds && rule.categoryIds.includes(product.categoryId)) {
          product._score *= rule.factor * 0.5;
        }
      }
    }

    return boosted.sort((a, b) => b._score - a._score);
  }

  ruleMatches(rule, query) {
    if (!rule.queryTerms || rule.queryTerms.length === 0) return true;
    const lowerQuery = query.toLowerCase();
    return rule.queryTerms.some(term => lowerQuery.includes(term));
  }

  async personalize(products, customerId) {
    // Simplified: boost products from categories the customer has bought before
    // In a real system, this would call a recommendation model
    return products;
  }

  getSuggestions(tokens) {
    const suggestions = new Set();
    for (const token of tokens) {
      const syns = this.synonyms.get(token) || [];
      for (const syn of syns) suggestions.add(syn);
    }
    return [...suggestions].slice(0, 5);
  }

  addBoostRule(rule) {
    this.boostRules.push({
      ...rule,
      id: `boost_${Date.now()}`,
      active: true
    });
  }

  getPopularSearches(limit = 10) {
    const counts = {};
    for (const entry of this.queryLog) {
      const q = entry.query.toLowerCase().trim();
      counts[q] = (counts[q] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([query, count]) => ({ query, count }));
  }

  getZeroResultQueries(limit = 20) {
    return this.queryLog
      .filter(q => q.resultCount === 0)
      .slice(-limit)
      .map(q => q.query);
  }
}

// ============================================================
// RECOMMENDATION ENGINE
// ============================================================

class RecommendationEngine {
  constructor(catalog, analytics) {
    this.catalog = catalog;
    this.analytics = analytics;
    this.coOccurrenceMatrix = new Map();
    this.viewedTogether = new Map();
    this.boughtTogether = new Map();
    this.minCoOccurrences = 3;
  }

  recordProductView(sessionId, productId) {
    const session = this.viewedTogether.get(sessionId) || [];
    if (!session.includes(productId)) {
      session.push(productId);
      this.viewedTogether.set(sessionId, session);
    }
    this.updateCoOccurrences(session, 'view');
  }

  recordPurchase(orderId, productIds) {
    const purchased = this.boughtTogether.get(orderId) || [];
    for (const id of productIds) {
      if (!purchased.includes(id)) purchased.push(id);
    }
    this.boughtTogether.set(orderId, purchased);
    this.updateCoOccurrences(productIds, 'purchase');
  }

  updateCoOccurrences(items, type) {
    const weight = type === 'purchase' ? 3 : 1;

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const key = [items[i], items[j]].sort().join(':');
        const current = this.coOccurrenceMatrix.get(key) || 0;
        this.coOccurrenceMatrix.set(key, current + weight);
      }
    }
  }

  getFrequentlyBoughtTogether(productId, limit = 5) {
    const scores = new Map();

    for (const [key, count] of this.coOccurrenceMatrix) {
      if (count < this.minCoOccurrences) continue;
      const [a, b] = key.split(':');
      const other = a === productId ? b : b === productId ? a : null;
      if (other) scores.set(other, count);
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => this.catalog.getProduct(id))
      .filter(Boolean);
  }

  getPersonalizedRecommendations(customerId, purchaseHistory, limit = 10) {
    if (!purchaseHistory || purchaseHistory.length === 0) {
      return this.getTrendingProducts(limit);
    }

    const scores = new Map();
    const purchased = new Set(purchaseHistory);

    for (const productId of purchaseHistory) {
      const related = this.getFrequentlyBoughtTogether(productId, 20);
      for (const product of related) {
        if (!purchased.has(product.id)) {
          scores.set(product.id, (scores.get(product.id) || 0) + 1);
        }
      }
    }

    if (scores.size < limit) {
      const trending = this.getTrendingProducts(limit * 2);
      for (const product of trending) {
        if (!purchased.has(product.id) && !scores.has(product.id)) {
          scores.set(product.id, 0.1);
        }
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => this.catalog.getProduct(id))
      .filter(Boolean);
  }

  getTrendingProducts(limit = 10) {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const topProducts = this.analytics.getTopProducts(oneDayAgo, Date.now(), limit * 2);

    return topProducts
      .map(p => this.catalog.getProduct(p.productId))
      .filter(p => p && p.isActive)
      .slice(0, limit);
  }

  getCrossSellRecommendations(cartProductIds, limit = 5) {
    const scores = new Map();
    const cartSet = new Set(cartProductIds);

    for (const productId of cartProductIds) {
      const related = this.getFrequentlyBoughtTogether(productId, 20);
      for (const product of related) {
        if (!cartSet.has(product.id)) {
          const relatedScore = this.coOccurrenceMatrix.get(
            [productId, product.id].sort().join(':')
          ) || 0;
          scores.set(product.id, (scores.get(product.id) || 0) + relatedScore);
        }
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => this.catalog.getProduct(id))
      .filter(Boolean);
  }
}

// ============================================================
// REVIEW SYSTEM
// ============================================================

class ReviewSystem extends EventEmitter {
  constructor() {
    super();
    this.reviews = new Map();
    this.reviewsByProduct = new Map();
    this.reviewsByCustomer = new Map();
    this.helpfulVotes = new Map();
    this.reviewStats = new Map(); // productId -> cached stats
  }

  async submitReview(customerId, productId, { rating, title, body, attributes = {} }) {
    if (rating < 1 || rating > 5) {
      return { success: false, error: 'Rating must be between 1 and 5' };
    }

    if (title && title.length > 200) {
      return { success: false, error: 'Title too long (max 200 characters)' };
    }

    if (body && body.length > 5000) {
      return { success: false, error: 'Review body too long (max 5000 characters)' };
    }

    // Check for duplicate review
    const existing = this.getCustomerReviewForProduct(customerId, productId);
    if (existing) {
      return { success: false, error: 'You have already reviewed this product' };
    }

    const reviewId = `rev_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const review = {
      id: reviewId,
      customerId,
      productId,
      rating,
      title: title || '',
      body: body || '',
      attributes,
      status: 'PENDING_MODERATION',
      helpfulCount: 0,
      notHelpfulCount: 0,
      verifiedPurchase: false, // Would be set by checking order history
      createdAt: Date.now(),
      updatedAt: Date.now(),
      moderationNotes: []
    };

    this.reviews.set(reviewId, review);

    const productReviews = this.reviewsByProduct.get(productId) || [];
    productReviews.push(reviewId);
    this.reviewsByProduct.set(productId, productReviews);

    const customerReviews = this.reviewsByCustomer.get(customerId) || [];
    customerReviews.push(reviewId);
    this.reviewsByCustomer.set(customerId, customerReviews);

    // Invalidate cached stats
    this.reviewStats.delete(productId);

    this.emit('review:submitted', review);

    return { success: true, reviewId, review };
  }

  approveReview(reviewId, moderatorId, notes = '') {
    const review = this.reviews.get(reviewId);
    if (!review) return false;

    review.status = 'APPROVED';
    review.updatedAt = Date.now();
    review.moderationNotes.push({ action: 'approved', moderatorId, notes, timestamp: Date.now() });

    this.reviewStats.delete(review.productId);
    this.emit('review:approved', review);
    return true;
  }

  rejectReview(reviewId, moderatorId, reason) {
    const review = this.reviews.get(reviewId);
    if (!review) return false;

    review.status = 'REJECTED';
    review.rejectionReason = reason;
    review.updatedAt = Date.now();
    review.moderationNotes.push({ action: 'rejected', moderatorId, reason, timestamp: Date.now() });

    this.emit('review:rejected', review);
    return true;
  }

  markVerifiedPurchase(reviewId) {
    const review = this.reviews.get(reviewId);
    if (!review) return false;
    review.verifiedPurchase = true;
    return true;
  }

  voteHelpful(reviewId, customerId, isHelpful) {
    const voteKey = `${reviewId}:${customerId}`;
    const existingVote = this.helpfulVotes.get(voteKey);

    const review = this.reviews.get(reviewId);
    if (!review) return false;

    if (existingVote !== undefined) {
      // Remove old vote
      if (existingVote) review.helpfulCount--;
      else review.notHelpfulCount--;
    }

    if (isHelpful) review.helpfulCount++;
    else review.notHelpfulCount++;

    this.helpfulVotes.set(voteKey, isHelpful);
    return true;
  }

  getProductReviews(productId, { status = 'APPROVED', sortBy = 'recent', limit = 20, offset = 0 } = {}) {
    const reviewIds = this.reviewsByProduct.get(productId) || [];
    let reviews = reviewIds
      .map(id => this.reviews.get(id))
      .filter(r => r && r.status === status);

    switch (sortBy) {
      case 'recent':
        reviews.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case 'highest':
        reviews.sort((a, b) => b.rating - a.rating);
        break;
      case 'lowest':
        reviews.sort((a, b) => a.rating - b.rating);
        break;
      case 'helpful':
        reviews.sort((a, b) => b.helpfulCount - a.helpfulCount);
        break;
    }

    return {
      total: reviews.length,
      reviews: reviews.slice(offset, offset + limit)
    };
  }

  getProductStats(productId) {
    const cached = this.reviewStats.get(productId);
    if (cached) return cached;

    const reviewIds = this.reviewsByProduct.get(productId) || [];
    const approvedReviews = reviewIds
      .map(id => this.reviews.get(id))
      .filter(r => r && r.status === 'APPROVED');

    if (approvedReviews.length === 0) {
      return { count: 0, average: null, distribution: {} };
    }

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let total = 0;

    for (const review of approvedReviews) {
      distribution[review.rating]++;
      total += review.rating;
    }

    const stats = {
      count: approvedReviews.length,
      average: Math.round((total / approvedReviews.length) * 10) / 10,
      distribution,
      verifiedCount: approvedReviews.filter(r => r.verifiedPurchase).length
    };

    this.reviewStats.set(productId, stats);
    return stats;
  }

  getCustomerReviewForProduct(customerId, productId) {
    const customerReviews = this.reviewsByCustomer.get(customerId) || [];
    for (const reviewId of customerReviews) {
      const review = this.reviews.get(reviewId);
      if (review && review.productId === productId) return review;
    }
    return null;
  }

  getPendingModerationQueue(limit = 50) {
    const pending = [];
    for (const review of this.reviews.values()) {
      if (review.status === 'PENDING_MODERATION') {
        pending.push(review);
        if (pending.length >= limit) break;
      }
    }
    return pending.sort((a, b) => a.createdAt - b.createdAt);
  }
}

// ============================================================
// NOTIFICATION SERVICE
// ============================================================

class NotificationService extends EventEmitter {
  constructor() {
    super();
    this.subscriptions = new Map(); // customerId -> { channels, preferences }
    this.notificationLog = [];
    this.templates = new Map();
    this.rateLimits = new Map(); // customerId:channel -> last sent timestamps
    this.maxNotificationsPerHour = 10;
  }

  subscribe(customerId, channels, preferences = {}) {
    this.subscriptions.set(customerId, {
      customerId,
      channels: channels || ['email'],
      preferences: {
        orderUpdates: true,
        promotions: preferences.promotions !== false,
        productAlerts: preferences.productAlerts !== false,
        ...preferences
      },
      subscribedAt: Date.now()
    });
  }

  unsubscribe(customerId, channels = null) {
    if (!channels) {
      this.subscriptions.delete(customerId);
      return;
    }
    const sub = this.subscriptions.get(customerId);
    if (sub) {
      sub.channels = sub.channels.filter(c => !channels.includes(c));
    }
  }

  addTemplate(templateId, template) {
    this.templates.set(templateId, template);
  }

  renderTemplate(templateId, variables) {
    const template = this.templates.get(templateId);
    if (!template) return null;

    return {
      subject: template.subject.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || ''),
      body: template.body.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || '')
    };
  }

  isRateLimited(customerId, channel) {
    const key = `${customerId}:${channel}`;
    const timestamps = this.rateLimits.get(key) || [];
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recent = timestamps.filter(t => t > oneHourAgo);
    this.rateLimits.set(key, recent);
    return recent.length >= this.maxNotificationsPerHour;
  }

  recordNotification(customerId, channel) {
    const key = `${customerId}:${channel}`;
    const timestamps = this.rateLimits.get(key) || [];
    timestamps.push(Date.now());
    this.rateLimits.set(key, timestamps);
  }

  async sendNotification(customerId, type, templateId, variables) {
    const subscription = this.subscriptions.get(customerId);
    if (!subscription) return { sent: [], skipped: ['not_subscribed'] };

    const preferences = subscription.preferences;

    // Check preference
    const preferenceMap = {
      order_update: 'orderUpdates',
      promotion: 'promotions',
      product_alert: 'productAlerts',
      back_in_stock: 'productAlerts',
      price_drop: 'productAlerts'
    };

    const pref = preferenceMap[type];
    if (pref && !preferences[pref]) {
      return { sent: [], skipped: ['preference_disabled'] };
    }

    const content = this.renderTemplate(templateId, variables);
    if (!content) {
      return { sent: [], skipped: ['template_not_found'] };
    }

    const sent = [];
    const skipped = [];

    for (const channel of subscription.channels) {
      if (this.isRateLimited(customerId, channel)) {
        skipped.push(`${channel}:rate_limited`);
        continue;
      }

      // In a real system, dispatch to channel provider (SendGrid, Twilio, FCM, etc.)
      const notification = {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        customerId,
        channel,
        type,
        templateId,
        content,
        status: 'sent',
        sentAt: Date.now()
      };

      this.notificationLog.push(notification);
      this.recordNotification(customerId, channel);
      this.emit('notification:sent', notification);
      sent.push(channel);
    }

    return { sent, skipped };
  }

  async sendBulkNotification(customerIds, type, templateId, variablesMap) {
    const results = { sent: 0, failed: 0, skipped: 0 };

    for (const customerId of customerIds) {
      const variables = variablesMap[customerId] || variablesMap['default'] || {};
      const result = await this.sendNotification(customerId, type, templateId, variables);
      results.sent += result.sent.length;
      results.skipped += result.skipped.length;
    }

    return results;
  }

  getNotificationHistory(customerId, limit = 50) {
    return this.notificationLog
      .filter(n => n.customerId === customerId)
      .slice(-limit)
      .reverse();
  }

  getDeliveryStats(fromTimestamp, toTimestamp) {
    const relevant = this.notificationLog.filter(
      n => n.sentAt >= fromTimestamp && n.sentAt <= toTimestamp
    );

    const byChannel = {};
    const byType = {};

    for (const n of relevant) {
      byChannel[n.channel] = (byChannel[n.channel] || 0) + 1;
      byType[n.type] = (byType[n.type] || 0) + 1;
    }

    return {
      total: relevant.length,
      byChannel,
      byType,
      period: { from: fromTimestamp, to: toTimestamp }
    };
  }
}

// ============================================================
// COUPON / PROMOTION MANAGER
// ============================================================

class PromotionManager {
  constructor() {
    this.promotions = new Map();
    this.coupons = new Map();
    this.usageLog = new Map(); // couponCode -> [{ customerId, orderId, usedAt }]
  }

  createPromotion(promotion) {
    const id = `promo_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const promo = {
      id,
      name: promotion.name,
      description: promotion.description || '',
      type: promotion.type, // 'percentage' | 'fixed_amount' | 'free_shipping' | 'buy_x_get_y'
      value: promotion.value,
      conditions: promotion.conditions || {},
      startAt: promotion.startAt,
      endAt: promotion.endAt,
      maxUses: promotion.maxUses || null,
      currentUses: 0,
      active: true,
      createdAt: Date.now()
    };
    this.promotions.set(id, promo);
    return id;
  }

  createCoupon(code, promotionId, options = {}) {
    const promotion = this.promotions.get(promotionId);
    if (!promotion) return { success: false, error: 'Promotion not found' };

    const normalizedCode = code.toUpperCase().trim();
    if (this.coupons.has(normalizedCode)) {
      return { success: false, error: 'Coupon code already exists' };
    }

    const coupon = {
      code: normalizedCode,
      promotionId,
      maxUsesPerCustomer: options.maxUsesPerCustomer || 1,
      restrictToCustomers: options.restrictToCustomers || null,
      createdAt: Date.now(),
      active: true
    };

    this.coupons.set(normalizedCode, coupon);
    this.usageLog.set(normalizedCode, []);
    return { success: true, code: normalizedCode };
  }

  validateCoupon(code, customerId, cartValue, productIds) {
    const normalizedCode = code.toUpperCase().trim();
    const coupon = this.coupons.get(normalizedCode);

    if (!coupon) return { valid: false, reason: 'invalid_code' };
    if (!coupon.active) return { valid: false, reason: 'inactive' };

    const promotion = this.promotions.get(coupon.promotionId);
    if (!promotion || !promotion.active) return { valid: false, reason: 'promotion_inactive' };

    const now = Date.now();
    if (promotion.startAt && now < promotion.startAt) return { valid: false, reason: 'not_started' };
    if (promotion.endAt && now > promotion.endAt) return { valid: false, reason: 'expired' };

    if (promotion.maxUses && promotion.currentUses >= promotion.maxUses) {
      return { valid: false, reason: 'usage_limit_reached' };
    }

    // Check per-customer usage
    const usages = this.usageLog.get(normalizedCode) || [];
    const customerUsages = usages.filter(u => u.customerId === customerId).length;
    if (customerUsages >= coupon.maxUsesPerCustomer) {
      return { valid: false, reason: 'per_customer_limit_reached' };
    }

    // Check customer restriction
    if (coupon.restrictToCustomers && !coupon.restrictToCustomers.includes(customerId)) {
      return { valid: false, reason: 'not_eligible' };
    }

    // Check cart conditions
    const conditions = promotion.conditions;
    if (conditions.minCartValue && cartValue < conditions.minCartValue) {
      return { valid: false, reason: 'min_cart_value_not_met', required: conditions.minCartValue };
    }

    if (conditions.requiredProducts) {
      const hasRequired = conditions.requiredProducts.every(pid => productIds.includes(pid));
      if (!hasRequired) return { valid: false, reason: 'required_products_missing' };
    }

    return { valid: true, promotion, discount: this.calculateDiscount(promotion, cartValue) };
  }

  calculateDiscount(promotion, cartValue) {
    switch (promotion.type) {
      case 'percentage':
        return Math.round(cartValue * (promotion.value / 100) * 100) / 100;
      case 'fixed_amount':
        return Math.min(promotion.value, cartValue);
      case 'free_shipping':
        return 0; // Handled separately in shipping calculation
      default:
        return 0;
    }
  }

  recordUsage(code, customerId, orderId) {
    const normalizedCode = code.toUpperCase().trim();
    const coupon = this.coupons.get(normalizedCode);
    if (!coupon) return false;

    const usages = this.usageLog.get(normalizedCode) || [];
    usages.push({ customerId, orderId, usedAt: Date.now() });
    this.usageLog.set(normalizedCode, usages);

    const promotion = this.promotions.get(coupon.promotionId);
    if (promotion) promotion.currentUses++;

    return true;
  }

  getPromotionStats(promotionId) {
    const promotion = this.promotions.get(promotionId);
    if (!promotion) return null;

    // Find coupons for this promotion
    let totalUsages = 0;
    let uniqueCustomers = new Set();

    for (const [code, coupon] of this.coupons) {
      if (coupon.promotionId !== promotionId) continue;
      const usages = this.usageLog.get(code) || [];
      totalUsages += usages.length;
      for (const usage of usages) uniqueCustomers.add(usage.customerId);
    }

    return {
      promotionId,
      name: promotion.name,
      currentUses: promotion.currentUses,
      totalUsages,
      uniqueCustomers: uniqueCustomers.size,
      active: promotion.active
    };
  }
}

// ============================================================
// CART SERVICE
// ============================================================

class CartService {
  constructor(catalog, pricing, promotions) {
    this.catalog = catalog;
    this.pricing = pricing;
    this.promotions = promotions;
    this.carts = new Map();
    this.cartTtl = 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  getOrCreateCart(sessionId, customerId = null) {
    let cart = this.carts.get(sessionId);
    if (!cart) {
      cart = {
        id: sessionId,
        customerId,
        items: [],
        promoCode: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      this.carts.set(sessionId, cart);
    } else if (customerId && !cart.customerId) {
      // Merge anonymous cart to customer account
      cart.customerId = customerId;
    }
    return cart;
  }

  addItem(sessionId, productId, quantity, warehouseId = 'default', customerId = null) {
    const product = this.catalog.getProduct(productId);
    if (!product || !product.isActive) {
      return { success: false, error: 'Product not available' };
    }

    const cart = this.getOrCreateCart(sessionId, customerId);
    const existing = cart.items.find(i => i.productId === productId && i.warehouseId === warehouseId);

    if (existing) {
      existing.quantity += quantity;
    } else {
      cart.items.push({
        productId,
        quantity,
        warehouseId,
        addedAt: Date.now()
      });
    }

    cart.updatedAt = Date.now();
    return { success: true, cart: this.summarizeCart(cart) };
  }

  updateItem(sessionId, productId, quantity, warehouseId = 'default') {
    const cart = this.carts.get(sessionId);
    if (!cart) return { success: false, error: 'Cart not found' };

    if (quantity <= 0) {
      return this.removeItem(sessionId, productId, warehouseId);
    }

    const item = cart.items.find(i => i.productId === productId && i.warehouseId === warehouseId);
    if (!item) return { success: false, error: 'Item not in cart' };

    item.quantity = quantity;
    cart.updatedAt = Date.now();
    return { success: true, cart: this.summarizeCart(cart) };
  }

  removeItem(sessionId, productId, warehouseId = 'default') {
    const cart = this.carts.get(sessionId);
    if (!cart) return { success: false, error: 'Cart not found' };

    cart.items = cart.items.filter(
      i => !(i.productId === productId && i.warehouseId === warehouseId)
    );
    cart.updatedAt = Date.now();
    return { success: true, cart: this.summarizeCart(cart) };
  }

  applyPromoCode(sessionId, code, customerId) {
    const cart = this.carts.get(sessionId);
    if (!cart) return { success: false, error: 'Cart not found' };

    const summary = this.summarizeCart(cart);
    const productIds = cart.items.map(i => i.productId);

    const validation = this.promotions.validateCoupon(
      code, customerId, summary.subtotal, productIds
    );

    if (!validation.valid) {
      return { success: false, error: validation.reason, details: validation };
    }

    cart.promoCode = code.toUpperCase().trim();
    cart.updatedAt = Date.now();
    return { success: true, discount: validation.discount, cart: this.summarizeCart(cart) };
  }

  summarizeCart(cart) {
    const customer = { id: cart.customerId, tier: 'STANDARD' };
    let subtotal = 0;
    const pricedItems = [];

    for (const item of cart.items) {
      const pricing = this.pricing.calculatePrice(item.productId, item.quantity, customer);
      if (pricing) {
        pricedItems.push({ ...item, unitPrice: pricing.unitPrice, totalPrice: pricing.totalPrice });
        subtotal += pricing.totalPrice;
      }
    }

    let discount = 0;
    if (cart.promoCode) {
      const productIds = cart.items.map(i => i.productId);
      const validation = this.promotions.validateCoupon(
        cart.promoCode, cart.customerId, subtotal, productIds
      );
      if (validation.valid) discount = validation.discount;
    }

    return {
      id: cart.id,
      customerId: cart.customerId,
      items: pricedItems,
      subtotal,
      discount,
      promoCode: cart.promoCode,
      total: subtotal - discount,
      itemCount: cart.items.reduce((sum, i) => sum + i.quantity, 0),
      updatedAt: cart.updatedAt
    };
  }

  clearCart(sessionId) {
    const cart = this.carts.get(sessionId);
    if (!cart) return false;
    cart.items = [];
    cart.promoCode = null;
    cart.updatedAt = Date.now();
    return true;
  }

  cleanupExpiredCarts() {
    const cutoff = Date.now() - this.cartTtl;
    for (const [sessionId, cart] of this.carts) {
      if (cart.updatedAt < cutoff) {
        this.carts.delete(sessionId);
      }
    }
  }
}

// ============================================================
// MODULE EXPORTS
// ============================================================

module.exports = {
  SearchEngine,
  RecommendationEngine,
  ReviewSystem,
  NotificationService,
  PromotionManager,
  CartService
};
