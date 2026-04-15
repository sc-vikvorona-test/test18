'use strict';

/**
 * E-Commerce Platform Tests
 * Unit and integration tests covering all core modules
 */

const assert = require('assert');
const {
  InventoryManager, PricingEngine, OrderProcessor,
  ShippingService, CustomerAccountManager, AnalyticsEngine,
  ProductCatalog, PaymentGateway
} = require('./ecommerce-app');
const {
  SearchEngine, RecommendationEngine, ReviewSystem,
  NotificationService, PromotionManager, CartService
} = require('./ecommerce-utils');

// ============================================================
// TEST HELPERS
// ============================================================

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertTruthy(val, msg) {
  assert.ok(val, msg || `Expected truthy, got ${val}`);
}

function assertFalsy(val, msg) {
  assert.ok(!val, msg || `Expected falsy, got ${val}`);
}

function assertNull(val, msg) {
  assert.strictEqual(val, null, msg || `Expected null, got ${val}`);
}

function assertApprox(actual, expected, delta, msg) {
  assert.ok(
    Math.abs(actual - expected) <= delta,
    msg || `Expected ${expected} ± ${delta}, got ${actual}`
  );
}

// ============================================================
// INVENTORY MANAGER TESTS
// ============================================================

async function testInventoryManager() {
  console.log('\nInventoryManager');

  await test('addProduct increases stock', () => {
    const inv = new InventoryManager();
    inv.addProduct('p1', 100, 'WH1');
    assertEqual(inv.getAvailableStock('p1', 'WH1'), 100);
  });

  await test('addProduct is cumulative', () => {
    const inv = new InventoryManager();
    inv.addProduct('p1', 50, 'WH1');
    inv.addProduct('p1', 30, 'WH1');
    assertEqual(inv.getAvailableStock('p1', 'WH1'), 80);
  });

  await test('reserveStock reduces available', () => {
    const inv = new InventoryManager();
    inv.addProduct('p1', 100, 'WH1');
    const result = inv.reserveStock('p1', 10, 'WH1', 'order1');
    assertTruthy(result.success);
    assertEqual(inv.getAvailableStock('p1', 'WH1'), 90);
  });

  await test('reserveStock fails when insufficient', () => {
    const inv = new InventoryManager();
    inv.addProduct('p1', 5, 'WH1');
    const result = inv.reserveStock('p1', 10, 'WH1', 'order1');
    assertFalsy(result.success);
    assertEqual(result.available, 5);
  });

  await test('commitReservation reduces total stock', () => {
    const inv = new InventoryManager();
    inv.addProduct('p1', 100, 'WH1');
    const { reservationId } = inv.reserveStock('p1', 10, 'WH1', 'order1');
    inv.commitReservation(reservationId);
    assertEqual(inv.getAvailableStock('p1', 'WH1'), 90);
  });

  await test('releaseReservation restores available', () => {
    const inv = new InventoryManager();
    inv.addProduct('p1', 100, 'WH1');
    const { reservationId } = inv.reserveStock('p1', 10, 'WH1', 'order1');
    inv.releaseReservation(reservationId);
    assertEqual(inv.getAvailableStock('p1', 'WH1'), 100);
  });

  await test('expireStaleReservations releases old reservations', () => {
    const inv = new InventoryManager();
    inv.addProduct('p1', 100, 'WH1');
    const { reservationId } = inv.reserveStock('p1', 20, 'WH1', 'order1');
    // Manually expire the reservation
    const res = inv.reservations.get(reservationId);
    res.expiresAt = Date.now() - 1000;
    inv.expireStaleReservations();
    assertEqual(inv.getAvailableStock('p1', 'WH1'), 100);
  });

  await test('transferStock moves units between warehouses', () => {
    const inv = new InventoryManager();
    inv.addProduct('p1', 100, 'WH1');
    inv.addProduct('p1', 50, 'WH2');
    const result = inv.transferStock('p1', 30, 'WH1', 'WH2');
    assertTruthy(result.success);
    assertEqual(inv.getAvailableStock('p1', 'WH1'), 70);
    assertEqual(inv.getAvailableStock('p1', 'WH2'), 80);
  });

  await test('transferStock fails with insufficient source stock', () => {
    const inv = new InventoryManager();
    inv.addProduct('p1', 10, 'WH1');
    const result = inv.transferStock('p1', 50, 'WH1', 'WH2');
    assertFalsy(result.success);
    assertEqual(result.reason, 'insufficient_stock');
  });

  await test('getStockReport returns all entries', () => {
    const inv = new InventoryManager();
    inv.addProduct('p1', 100, 'WH1');
    inv.addProduct('p2', 50, 'WH1');
    const report = inv.getStockReport();
    assertEqual(report.length, 2);
  });
}

// ============================================================
// PRICING ENGINE TESTS
// ============================================================

async function testPricingEngine() {
  console.log('\nPricingEngine');

  await test('calculatePrice returns base price for standard customer', () => {
    const engine = new PricingEngine();
    engine.setBasePrice('p1', 100);
    const result = engine.calculatePrice('p1', 1, { tier: 'STANDARD' });
    assertEqual(result.unitPrice, 100);
    assertEqual(result.totalPrice, 100);
  });

  await test('GOLD tier gets 10% discount', () => {
    const engine = new PricingEngine();
    engine.setBasePrice('p1', 100);
    const result = engine.calculatePrice('p1', 1, { tier: 'GOLD' });
    assertEqual(result.unitPrice, 90);
  });

  await test('PLATINUM tier gets 15% discount', () => {
    const engine = new PricingEngine();
    engine.setBasePrice('p1', 100);
    const result = engine.calculatePrice('p1', 1, { tier: 'PLATINUM' });
    assertEqual(result.unitPrice, 85);
  });

  await test('volume discount applies at 10 units', () => {
    const engine = new PricingEngine();
    engine.setBasePrice('p1', 100);
    const result = engine.calculatePrice('p1', 10, { tier: 'STANDARD' });
    assertEqual(result.unitPrice, 95);
  });

  await test('volume discount applies at 100 units', () => {
    const engine = new PricingEngine();
    engine.setBasePrice('p1', 100);
    const result = engine.calculatePrice('p1', 100, { tier: 'STANDARD' });
    assertEqual(result.unitPrice, 85);
  });

  await test('totalPrice accounts for quantity', () => {
    const engine = new PricingEngine();
    engine.setBasePrice('p1', 50);
    const result = engine.calculatePrice('p1', 5, { tier: 'STANDARD' });
    assertEqual(result.totalPrice, 250);
  });

  await test('promo code SAVE20 gives 20% discount', () => {
    const engine = new PricingEngine();
    engine.setBasePrice('p1', 100);
    const result = engine.calculatePrice('p1', 1, { tier: 'STANDARD' }, 'USD', 'SAVE20');
    assertEqual(result.unitPrice, 80);
  });

  await test('returns null for unknown product', () => {
    const engine = new PricingEngine();
    const result = engine.calculatePrice('unknown', 1, { tier: 'STANDARD' });
    assertNull(result);
  });

  await test('price never goes below 0', () => {
    const engine = new PricingEngine();
    engine.setBasePrice('p1', 10);
    const result = engine.calculatePrice('p1', 1, { tier: 'STANDARD' }, 'USD', 'FLAT50');
    assertEqual(result.unitPrice, 0);
  });

  await test('percentage price rule is applied', () => {
    const engine = new PricingEngine();
    engine.setBasePrice('p1', 100);
    engine.addPriceRule({ type: 'percentage', value: 0.10, priority: 1 });
    const result = engine.calculatePrice('p1', 1, { tier: 'STANDARD' });
    assertEqual(result.unitPrice, 90);
  });

  await test('fixed price rule is applied', () => {
    const engine = new PricingEngine();
    engine.setBasePrice('p1', 100);
    engine.addPriceRule({ type: 'fixed', value: 15, priority: 1 });
    const result = engine.calculatePrice('p1', 1, { tier: 'STANDARD' });
    assertEqual(result.unitPrice, 85);
  });
}

// ============================================================
// SHIPPING SERVICE TESTS
// ============================================================

async function testShippingService() {
  console.log('\nShippingService');

  await test('calculateCost returns 0 for orders over threshold', async () => {
    const svc = new ShippingService();
    const cost = await svc.calculateCost({ country: 'US' }, [], 150);
    assertEqual(cost, 0);
  });

  await test('calculateCost adds base rate for US domestic', async () => {
    const svc = new ShippingService();
    const cost = await svc.calculateCost({ country: 'US' }, [], 50);
    assertEqual(cost, 5.99);
  });

  await test('calculateCost adds international surcharge', async () => {
    const svc = new ShippingService();
    const cost = await svc.calculateCost({ country: 'CA' }, [], 50);
    assertEqual(cost, 20.99); // 5.99 + 15
  });

  await test('createShipment returns shipment with tracking', async () => {
    const svc = new ShippingService();
    svc.registerCarrier('UPS', { name: 'UPS', active: true });
    const shipment = await svc.createShipment(
      'ord1', 'UPS', [], { city: 'NY' }, { city: 'LA', country: 'US' }
    );
    assertTruthy(shipment.id);
    assertTruthy(shipment.trackingNumber);
    assertEqual(shipment.status, 'LABEL_CREATED');
  });

  await test('createShipment throws for inactive carrier', async () => {
    const svc = new ShippingService();
    svc.registerCarrier('UPS', { name: 'UPS', active: false });
    try {
      await svc.createShipment('ord1', 'UPS', [], {}, {});
      assert.fail('Should have thrown');
    } catch (err) {
      assertTruthy(err.message.includes('not available'));
    }
  });

  await test('updateShipmentStatus adds to event history', async () => {
    const svc = new ShippingService();
    svc.registerCarrier('FEDEX', { name: 'FedEx', active: true });
    const shipment = await svc.createShipment('ord1', 'FEDEX', [], {}, { country: 'US' });
    svc.updateShipmentStatus(shipment.id, 'IN_TRANSIT', 'Chicago, IL');
    const updated = svc.getShipment(shipment.id);
    assertEqual(updated.events.length, 2);
    assertEqual(updated.status, 'IN_TRANSIT');
  });

  await test('estimateDelivery skips weekends', () => {
    const svc = new ShippingService();
    const delivery = svc.estimateDelivery({ country: 'US' }, 'OVERNIGHT');
    const deliveryDate = new Date(delivery);
    const dow = deliveryDate.getDay();
    assertTruthy(dow !== 0 && dow !== 6, `Delivery should not be on weekend, got ${dow}`);
  });
}

// ============================================================
// CUSTOMER ACCOUNT MANAGER TESTS
// ============================================================

async function testCustomerAccountManager() {
  console.log('\nCustomerAccountManager');

  await test('createCustomer succeeds with valid data', async () => {
    const mgr = new CustomerAccountManager();
    const result = await mgr.createCustomer({
      email: 'test@example.com',
      password: 'secure_password',
      firstName: 'John',
      lastName: 'Doe'
    });
    assertTruthy(result.success);
    assertTruthy(result.customerId);
  });

  await test('createCustomer rejects duplicate email', async () => {
    const mgr = new CustomerAccountManager();
    await mgr.createCustomer({ email: 'dup@test.com', password: 'pass', firstName: 'A', lastName: 'B' });
    const result = await mgr.createCustomer({ email: 'DUP@TEST.COM', password: 'pass2', firstName: 'C', lastName: 'D' });
    assertFalsy(result.success);
  });

  await test('authenticate succeeds with correct password', async () => {
    const mgr = new CustomerAccountManager();
    await mgr.createCustomer({ email: 'auth@test.com', password: 'mypassword', firstName: 'A', lastName: 'B' });
    const result = await mgr.authenticate('auth@test.com', 'mypassword');
    assertTruthy(result.success);
  });

  await test('authenticate fails with wrong password', async () => {
    const mgr = new CustomerAccountManager();
    await mgr.createCustomer({ email: 'auth2@test.com', password: 'correct', firstName: 'A', lastName: 'B' });
    const result = await mgr.authenticate('auth2@test.com', 'wrong');
    assertFalsy(result.success);
  });

  await test('authenticate fails for unknown email', async () => {
    const mgr = new CustomerAccountManager();
    const result = await mgr.authenticate('nobody@test.com', 'pass');
    assertFalsy(result.success);
  });

  await test('sanitizeCustomer strips password fields', async () => {
    const mgr = new CustomerAccountManager();
    const { customerId } = await mgr.createCustomer({ email: 'safe@test.com', password: 'p', firstName: 'A', lastName: 'B' });
    const customer = mgr.getCustomer(customerId);
    assertFalsy('passwordHash' in customer);
    assertFalsy('salt' in customer);
  });

  await test('addAddress sets first as default', async () => {
    const mgr = new CustomerAccountManager();
    const { customerId } = await mgr.createCustomer({ email: 'addr@test.com', password: 'p', firstName: 'A', lastName: 'B' });
    const { address } = mgr.addAddress(customerId, { street: '123 Main St', city: 'NY', country: 'US' });
    assertTruthy(address.isDefault);
  });

  await test('tier upgrades after reaching threshold', async () => {
    const mgr = new CustomerAccountManager();
    const { customerId } = await mgr.createCustomer({ email: 'tier@test.com', password: 'p', firstName: 'A', lastName: 'B' });
    let upgradeEmitted = false;
    mgr.on('customer:tier_upgraded', () => { upgradeEmitted = true; });
    mgr.recordPurchase(customerId, 1200);
    assertTruthy(upgradeEmitted, 'Tier upgrade event should be emitted');
    const customer = mgr.getCustomer(customerId);
    assertEqual(customer.tier, 'SILVER');
  });

  await test('loyalty points awarded on purchase', async () => {
    const mgr = new CustomerAccountManager();
    const { customerId } = await mgr.createCustomer({ email: 'pts@test.com', password: 'p', firstName: 'A', lastName: 'B' });
    mgr.recordPurchase(customerId, 150.75);
    assertEqual(mgr.getLoyaltyPoints(customerId), 150);
  });

  await test('redeemPoints fails if insufficient', async () => {
    const mgr = new CustomerAccountManager();
    const { customerId } = await mgr.createCustomer({ email: 'red@test.com', password: 'p', firstName: 'A', lastName: 'B' });
    const result = mgr.redeemPoints(customerId, 100);
    assertFalsy(result.success);
  });

  await test('updateCustomer rejects unknown fields', async () => {
    const mgr = new CustomerAccountManager();
    const { customerId } = await mgr.createCustomer({ email: 'upd@test.com', password: 'p', firstName: 'Old', lastName: 'B' });
    mgr.updateCustomer(customerId, { firstName: 'New', role: 'admin' }); // role should be ignored
    const customer = mgr.getCustomer(customerId);
    assertEqual(customer.firstName, 'New');
    assertFalsy('role' in customer);
  });
}

// ============================================================
// REVIEW SYSTEM TESTS
// ============================================================

async function testReviewSystem() {
  console.log('\nReviewSystem');

  await test('submitReview succeeds with valid data', async () => {
    const reviews = new ReviewSystem();
    const result = await reviews.submitReview('cust1', 'prod1', { rating: 4, title: 'Good', body: 'Nice product' });
    assertTruthy(result.success);
    assertTruthy(result.reviewId);
  });

  await test('submitReview rejects invalid rating', async () => {
    const reviews = new ReviewSystem();
    const result = await reviews.submitReview('cust1', 'prod1', { rating: 6 });
    assertFalsy(result.success);
  });

  await test('submitReview prevents duplicate review', async () => {
    const reviews = new ReviewSystem();
    await reviews.submitReview('cust1', 'prod1', { rating: 4 });
    const result = await reviews.submitReview('cust1', 'prod1', { rating: 5 });
    assertFalsy(result.success);
    assertTruthy(result.error.includes('already reviewed'));
  });

  await test('getProductReviews returns only approved reviews', async () => {
    const reviews = new ReviewSystem();
    const { reviewId } = await reviews.submitReview('cust1', 'prod1', { rating: 5 });
    reviews.approveReview(reviewId, 'mod1');
    await reviews.submitReview('cust2', 'prod1', { rating: 3 }); // pending

    const result = reviews.getProductReviews('prod1');
    assertEqual(result.total, 1);
    assertEqual(result.reviews[0].status, 'APPROVED');
  });

  await test('getProductStats computes average correctly', async () => {
    const reviews = new ReviewSystem();
    for (const [cust, rating] of [['c1', 4], ['c2', 5], ['c3', 3]]) {
      const { reviewId } = await reviews.submitReview(cust, 'prod1', { rating });
      reviews.approveReview(reviewId, 'mod1');
    }
    const stats = reviews.getProductStats('prod1');
    assertEqual(stats.count, 3);
    assertApprox(stats.average, 4.0, 0.1);
  });

  await test('voteHelpful increments count', async () => {
    const reviews = new ReviewSystem();
    const { reviewId } = await reviews.submitReview('cust1', 'prod1', { rating: 4 });
    reviews.approveReview(reviewId, 'mod1');
    reviews.voteHelpful(reviewId, 'voter1', true);
    const result = reviews.getProductReviews('prod1');
    assertEqual(result.reviews[0].helpfulCount, 1);
  });

  await test('rejectReview sets correct status', async () => {
    const reviews = new ReviewSystem();
    const { reviewId } = await reviews.submitReview('cust1', 'prod1', { rating: 1 });
    reviews.rejectReview(reviewId, 'mod1', 'Spam');
    const queue = reviews.getPendingModerationQueue();
    assertEqual(queue.length, 0);
  });
}

// ============================================================
// PROMOTION MANAGER TESTS
// ============================================================

async function testPromotionManager() {
  console.log('\nPromotionManager');

  await test('validateCoupon returns valid for good coupon', () => {
    const promo = new PromotionManager();
    const promoId = promo.createPromotion({
      name: '10% off',
      type: 'percentage',
      value: 10
    });
    promo.createCoupon('TEST10', promoId);
    const result = promo.validateCoupon('TEST10', 'cust1', 100, []);
    assertTruthy(result.valid);
    assertEqual(result.discount, 10);
  });

  await test('validateCoupon rejects invalid code', () => {
    const promo = new PromotionManager();
    const result = promo.validateCoupon('FAKECODE', 'cust1', 100, []);
    assertFalsy(result.valid);
    assertEqual(result.reason, 'invalid_code');
  });

  await test('validateCoupon respects min cart value', () => {
    const promo = new PromotionManager();
    const promoId = promo.createPromotion({
      name: 'min50',
      type: 'percentage',
      value: 15,
      conditions: { minCartValue: 50 }
    });
    promo.createCoupon('MIN50', promoId);
    const result = promo.validateCoupon('MIN50', 'cust1', 30, []);
    assertFalsy(result.valid);
    assertEqual(result.reason, 'min_cart_value_not_met');
  });

  await test('validateCoupon enforces per-customer usage limit', () => {
    const promo = new PromotionManager();
    const promoId = promo.createPromotion({ name: 'once', type: 'fixed_amount', value: 5 });
    promo.createCoupon('ONCE', promoId, { maxUsesPerCustomer: 1 });
    promo.validateCoupon('ONCE', 'cust1', 100, []);
    promo.recordUsage('ONCE', 'cust1', 'ord1');
    const second = promo.validateCoupon('ONCE', 'cust1', 100, []);
    assertFalsy(second.valid);
    assertEqual(second.reason, 'per_customer_limit_reached');
  });

  await test('validateCoupon rejects expired promotion', () => {
    const promo = new PromotionManager();
    const promoId = promo.createPromotion({
      name: 'expired',
      type: 'percentage',
      value: 10,
      endAt: Date.now() - 1000
    });
    promo.createCoupon('EXPIRED', promoId);
    const result = promo.validateCoupon('EXPIRED', 'cust1', 100, []);
    assertFalsy(result.valid);
    assertEqual(result.reason, 'expired');
  });

  await test('calculateDiscount fixed_amount respects cart cap', () => {
    const promo = new PromotionManager();
    const discount = promo.calculateDiscount({ type: 'fixed_amount', value: 200 }, 50);
    assertEqual(discount, 50); // Cannot discount more than cart value
  });

  await test('getPromotionStats returns usage counts', () => {
    const promo = new PromotionManager();
    const promoId = promo.createPromotion({ name: 'stats-test', type: 'percentage', value: 5 });
    promo.createCoupon('STATS', promoId);
    promo.recordUsage('STATS', 'cust1', 'ord1');
    promo.recordUsage('STATS', 'cust2', 'ord2');
    const stats = promo.getPromotionStats(promoId);
    assertEqual(stats.totalUsages, 2);
    assertEqual(stats.uniqueCustomers, 2);
  });
}

// ============================================================
// ANALYTICS ENGINE TESTS
// ============================================================

async function testAnalyticsEngine() {
  console.log('\nAnalyticsEngine');

  await test('track records event', () => {
    const analytics = new AnalyticsEngine();
    const id = analytics.track('page_view', { path: '/home' }, 'sess1');
    assertTruthy(id);
    assertEqual(analytics.events.length, 1);
  });

  await test('track updates session', () => {
    const analytics = new AnalyticsEngine();
    analytics.track('page_view', {}, 'sess1');
    analytics.track('page_view', {}, 'sess1');
    const session = analytics.sessionData.get('sess1');
    assertEqual(session.pageViews, 2);
  });

  await test('getRevenueByDay groups correctly', () => {
    const analytics = new AnalyticsEngine();
    const today = new Date().toISOString().slice(0, 10);
    analytics.track('purchase_completed', { total: 100 }, 's1', Date.now());
    analytics.track('purchase_completed', { total: 200 }, 's2', Date.now());

    const revenue = analytics.getRevenueByDay(Date.now() - 60000, Date.now() + 60000);
    assertEqual(revenue.length, 1);
    assertEqual(revenue[0].date, today);
    assertEqual(revenue[0].revenue, 300);
    assertEqual(revenue[0].orders, 2);
  });

  await test('getConversionRate returns 0 with no sessions', () => {
    const analytics = new AnalyticsEngine();
    const rate = analytics.getConversionRate(0, Date.now());
    assertEqual(rate, 0);
  });

  await test('defineFunnel and analyzeFunnel computes steps', () => {
    const analytics = new AnalyticsEngine();
    analytics.defineFunnel('checkout', ['page_view', 'add_to_cart', 'purchase_completed']);

    const now = Date.now();
    analytics.track('page_view', {}, 's1', now);
    analytics.track('add_to_cart', {}, 's1', now + 1);
    analytics.track('purchase_completed', {}, 's1', now + 2);

    analytics.track('page_view', {}, 's2', now);
    analytics.track('add_to_cart', {}, 's2', now + 1);
    // s2 drops off before purchase

    const result = analytics.analyzeFunnel('checkout', now - 100, now + 100);
    assertEqual(result.steps[0].count, 2); // 2 started
    assertEqual(result.steps[1].count, 2); // 2 added to cart
    assertEqual(result.steps[2].count, 1); // 1 purchased
  });
}

// ============================================================
// PRODUCT CATALOG TESTS
// ============================================================

async function testProductCatalog() {
  console.log('\nProductCatalog');

  await test('addProduct and getProduct round-trip', () => {
    const catalog = new ProductCatalog();
    const id = catalog.addProduct({ name: 'Widget', description: 'A widget', tags: ['sale'], isActive: true });
    const product = catalog.getProduct(id);
    assertTruthy(product);
    assertEqual(product.name, 'Widget');
  });

  await test('search finds product by name', () => {
    const catalog = new ProductCatalog();
    catalog.addProduct({ name: 'Blue Sneakers', description: 'Running shoes', tags: [], isActive: true });
    catalog.addProduct({ name: 'Red Hat', description: 'Baseball cap', tags: [], isActive: true });
    const result = catalog.search('sneakers');
    assertEqual(result.total, 1);
    assertEqual(result.products[0].name, 'Blue Sneakers');
  });

  await test('search respects category filter', () => {
    const catalog = new ProductCatalog();
    catalog.addProduct({ name: 'Shoe A', description: 'shoe', tags: [], categoryId: 'footwear', isActive: true });
    catalog.addProduct({ name: 'Hat A', description: 'hat', tags: [], categoryId: 'accessories', isActive: true });
    const result = catalog.search('a', { categoryId: 'footwear' });
    assertEqual(result.total, 1);
    assertEqual(result.products[0].name, 'Shoe A');
  });

  await test('updateProduct re-indexes updated fields', () => {
    const catalog = new ProductCatalog();
    const id = catalog.addProduct({ name: 'Old Name', description: 'desc', tags: [], isActive: true });
    catalog.updateProduct(id, { name: 'New Unique Term' });
    const result = catalog.search('unique');
    assertEqual(result.total, 1);
  });

  await test('getRelatedProducts returns items from same category', () => {
    const catalog = new ProductCatalog();
    const id1 = catalog.addProduct({ name: 'P1', description: '', tags: [], categoryId: 'cat1', isActive: true });
    catalog.addProduct({ name: 'P2', description: '', tags: [], categoryId: 'cat1', isActive: true });
    catalog.addProduct({ name: 'P3', description: '', tags: [], categoryId: 'cat2', isActive: true });
    const related = catalog.getRelatedProducts(id1);
    assertEqual(related.length, 1);
    assertEqual(related[0].categoryId, 'cat1');
  });

  await test('getProductsByCategory filters correctly', () => {
    const catalog = new ProductCatalog();
    catalog.addCategory('cat1', 'Category 1');
    catalog.addProduct({ name: 'A', description: '', tags: [], categoryId: 'cat1', isActive: true });
    catalog.addProduct({ name: 'B', description: '', tags: [], categoryId: 'cat2', isActive: true });
    const products = catalog.getProductsByCategory('cat1');
    assertEqual(products.length, 1);
    assertEqual(products[0].name, 'A');
  });
}

// ============================================================
// CART SERVICE TESTS
// ============================================================

async function testCartService() {
  console.log('\nCartService');

  function makeCart() {
    const catalog = new ProductCatalog();
    catalog.addProduct({ id: 'p1', name: 'Widget', description: '', tags: [], isActive: true });
    catalog.addProduct({ id: 'p2', name: 'Gadget', description: '', tags: [], isActive: false });
    const pricing = new PricingEngine();
    pricing.setBasePrice('p1', 25);
    const promotions = new PromotionManager();
    return new CartService(catalog, pricing, promotions);
  }

  await test('addItem creates cart if none exists', () => {
    const cart = makeCart();
    const result = cart.addItem('sess1', 'p1', 2);
    assertTruthy(result.success);
    assertEqual(result.cart.itemCount, 2);
  });

  await test('addItem rejects inactive product', () => {
    const cart = makeCart();
    const result = cart.addItem('sess1', 'p2', 1);
    assertFalsy(result.success);
  });

  await test('addItem accumulates quantity', () => {
    const cart = makeCart();
    cart.addItem('sess1', 'p1', 2);
    cart.addItem('sess1', 'p1', 3);
    const summary = cart.getOrCreateCart('sess1');
    assertEqual(summary.items[0].quantity, 5);
  });

  await test('updateItem to 0 removes item', () => {
    const cart = makeCart();
    cart.addItem('sess1', 'p1', 2);
    const result = cart.updateItem('sess1', 'p1', 0);
    assertTruthy(result.success);
    assertEqual(result.cart.itemCount, 0);
  });

  await test('removeItem removes specific item', () => {
    const cart = makeCart();
    cart.addItem('sess1', 'p1', 3);
    cart.removeItem('sess1', 'p1');
    const c = cart.getOrCreateCart('sess1');
    assertEqual(c.items.length, 0);
  });

  await test('clearCart empties items', () => {
    const cart = makeCart();
    cart.addItem('sess1', 'p1', 5);
    cart.clearCart('sess1');
    const c = cart.getOrCreateCart('sess1');
    assertEqual(c.items.length, 0);
  });

  await test('summarizeCart computes subtotal', () => {
    const cart = makeCart();
    cart.addItem('sess1', 'p1', 4);
    const c = cart.carts.get('sess1');
    const summary = cart.summarizeCart(c);
    assertEqual(summary.subtotal, 100); // 4 * 25
  });
}

// ============================================================
// INTEGRATION TEST: Full Order Flow
// ============================================================

async function testOrderFlow() {
  console.log('\nIntegration: Full Order Flow');

  await test('complete order lifecycle', async () => {
    const catalog = new ProductCatalog();
    catalog.addProduct({ id: 'prod1', name: 'Widget', description: '', tags: [], isActive: true, weight: 0.5 });

    const inv = new InventoryManager();
    inv.addProduct('prod1', 100, 'WH1');

    const pricing = new PricingEngine();
    pricing.setBasePrice('prod1', 49.99);

    const shipping = new ShippingService();
    const payment = new PaymentGateway();
    const orders = new OrderProcessor(inv, pricing, shipping, payment);

    // Create order
    const orderResult = await orders.createOrder(
      'cust1',
      [{ productId: 'prod1', quantity: 2, warehouseId: 'WH1' }],
      { country: 'US', state: 'CA', city: 'Los Angeles' },
      { type: 'card' }
    );

    assertTruthy(orderResult.success, 'Order creation should succeed');
    assertEqual(orderResult.order.status, 'PENDING');

    // Stock should be reserved
    assertEqual(inv.getAvailableStock('prod1', 'WH1'), 98);

    // Confirm order
    const confirmResult = await orders.confirmOrder(orderResult.orderId, 'tok_test');
    assertTruthy(confirmResult.success, 'Order confirmation should succeed');
    assertEqual(confirmResult.order.status, 'CONFIRMED');

    // Stock should be committed
    assertEqual(inv.getAvailableStock('prod1', 'WH1'), 98);
  });

  await test('order cancelled when stock insufficient', async () => {
    const inv = new InventoryManager();
    inv.addProduct('prod1', 3, 'WH1');

    const pricing = new PricingEngine();
    pricing.setBasePrice('prod1', 10);

    const shipping = new ShippingService();
    const payment = new PaymentGateway();
    const orders = new OrderProcessor(inv, pricing, shipping, payment);

    const result = await orders.createOrder(
      'cust1',
      [{ productId: 'prod1', quantity: 5, warehouseId: 'WH1' }],
      { country: 'US', state: 'CA' },
      {}
    );

    assertFalsy(result.success);
    assertTruthy(result.error.includes('Insufficient stock'));
  });

  await test('order cancellation releases stock', async () => {
    const inv = new InventoryManager();
    inv.addProduct('prod1', 50, 'WH1');

    const pricing = new PricingEngine();
    pricing.setBasePrice('prod1', 20);

    const shipping = new ShippingService();
    const payment = new PaymentGateway();
    const orders = new OrderProcessor(inv, pricing, shipping, payment);

    const { orderId } = await orders.createOrder(
      'cust1',
      [{ productId: 'prod1', quantity: 10, warehouseId: 'WH1' }],
      { country: 'US' },
      {}
    );

    assertEqual(inv.getAvailableStock('prod1', 'WH1'), 40); // Reserved

    await orders.cancelOrder(orderId, 'customer_request');
    assertEqual(inv.getAvailableStock('prod1', 'WH1'), 50); // Released
  });
}

// ============================================================
// RUN ALL TESTS
// ============================================================

async function main() {
  console.log('Running E-Commerce Platform Tests\n' + '='.repeat(40));

  await testInventoryManager();
  await testPricingEngine();
  await testShippingService();
  await testCustomerAccountManager();
  await testReviewSystem();
  await testPromotionManager();
  await testAnalyticsEngine();
  await testProductCatalog();
  await testCartService();
  await testOrderFlow();

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
