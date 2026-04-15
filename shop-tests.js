'use strict';

const assert = require('assert');
const {
  InventoryManager,
  PricingEngine,
  PaymentGateway,
  OrderProcessor,
  CustomerAccountManager,
  ReviewSystem,
  CartService,
} = require('./shop');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotifications() {
  return {
    orderConfirmed: () => {},
    orderCancelled: () => {},
    orderShipped:   () => {},
  };
}

// ---------------------------------------------------------------------------
// InventoryManager tests
// ---------------------------------------------------------------------------

describe('InventoryManager', () => {
  it('tracks stock and reservations', () => {
    const inv = new InventoryManager();
    inv.addStock('p1', 10);
    assert.strictEqual(inv.getAvailable('p1'), 10);

    const r1 = inv.reserve('p1', 3, 'ord1');
    assert.ok(r1);
    assert.strictEqual(inv.getAvailable('p1'), 7);
  });

  it('commits reservation and reduces stock', () => {
    const inv = new InventoryManager();
    inv.addStock('p1', 10);
    const r = inv.reserve('p1', 4, 'ord1');
    inv.commit(r);
    assert.strictEqual(inv.stock.get('p1'), 6);
    assert.strictEqual(inv.getAvailable('p1'), 6);
  });

  it('releases reservation without reducing stock', () => {
    const inv = new InventoryManager();
    inv.addStock('p1', 10);
    const r = inv.reserve('p1', 4, 'ord1');
    inv.release(r);
    assert.strictEqual(inv.getAvailable('p1'), 10);
  });

  it('does not reserve more than available', () => {
    const inv = new InventoryManager();
    inv.addStock('p1', 2);
    const r = inv.reserve('p1', 5, 'ord1');
    assert.strictEqual(r, null);
  });

  it('expires stale reservations', () => {
    const inv = new InventoryManager();
    inv.addStock('p1', 10);
    const r = inv.reserve('p1', 5, 'ord1');
    // Manually expire it
    inv.reservations.get(r).expiresAt = Date.now() - 1;
    inv.expireStaleReservations();
    assert.strictEqual(inv.getAvailable('p1'), 10);
  });
});

// ---------------------------------------------------------------------------
// PricingEngine tests
// ---------------------------------------------------------------------------

describe('PricingEngine', () => {
  it('calculates subtotal', () => {
    const pricing = new PricingEngine();
    const items = [{ price: 10, quantity: 3 }, { price: 5, quantity: 2 }];
    assert.strictEqual(pricing.calculateSubtotal(items), 40);
  });

  it('applies volume discount at threshold', () => {
    const pricing = new PricingEngine();
    const items = [{ price: 10, quantity: 5, productId: 'p1' }];
    const subtotal = pricing.calculateSubtotal(items);
    const discounted = pricing.applyVolumeDiscount(items, subtotal);
    assert.strictEqual(discounted, 47.5); // 5% off
  });

  it('applies tier discount', () => {
    const pricing = new PricingEngine();
    assert.strictEqual(pricing.applyTierDiscount(100, 'gold'), 90);
  });

  it('applies promo code percentage discount', () => {
    const pricing = new PricingEngine();
    const result = pricing.applyPromoCode(100, 'WELCOME10');
    assert.strictEqual(result, 90);
  });

  it('applies promo code fixed discount', () => {
    const pricing = new PricingEngine();
    const result = pricing.applyPromoCode(100, 'FLAT15');
    assert.strictEqual(result, 85);
  });

  it('rejects exhausted promo codes', () => {
    const pricing = new PricingEngine();
    const code = pricing._promoCodes.get('WELCOME10');
    code.uses = code.maxUses;
    assert.strictEqual(pricing.applyPromoCode(100, 'WELCOME10'), 100);
  });

  it('calculates tax correctly', () => {
    const pricing = new PricingEngine();
    assert.strictEqual(pricing.calculateTax(100, 0.08), 8);
  });
});

// ---------------------------------------------------------------------------
// PaymentGateway tests
// ---------------------------------------------------------------------------

describe('PaymentGateway', () => {
  it('charges a valid payment method', async () => {
    const gw = new PaymentGateway();
    const result = await gw.charge('ord1', 99.99, { token: 'tok_visa' });
    assert.ok(result.success);
    assert.ok(result.transactionId.startsWith('tx_'));
  });

  it('rejects missing payment token', async () => {
    const gw = new PaymentGateway();
    const result = await gw.charge('ord1', 99.99, {});
    assert.strictEqual(result.success, false);
  });

  it('refunds a completed transaction', async () => {
    const gw = new PaymentGateway();
    const charge = await gw.charge('ord1', 50, { token: 'tok_visa' });
    const refund = await gw.refund(charge.transactionId, 50);
    assert.ok(refund.success);
  });

  it('rejects double refund', async () => {
    const gw = new PaymentGateway();
    const charge = await gw.charge('ord1', 50, { token: 'tok_visa' });
    await gw.refund(charge.transactionId, 50);
    const second = await gw.refund(charge.transactionId, 50);
    assert.strictEqual(second.success, false);
  });
});

// ---------------------------------------------------------------------------
// OrderProcessor tests
// ---------------------------------------------------------------------------

describe('OrderProcessor', () => {
  function makeProcessor() {
    const inv   = new InventoryManager();
    const prc   = new PricingEngine();
    const gw    = new PaymentGateway();
    const notif = makeNotifications();
    inv.addStock('p1', 20);
    inv.addStock('p2', 10);
    return { processor: new OrderProcessor(inv, prc, gw, notif), inv, prc, gw };
  }

  const items  = [{ productId: 'p1', quantity: 2, price: 25, weight: 1 }];
  const addr   = { country: 'US', city: 'NYC', zip: '10001' };
  const method = { token: 'tok_visa' };

  it('creates an order successfully', async () => {
    const { processor } = makeProcessor();
    const res = await processor.createOrder('cust1', items, 'bronze', null, method, addr);
    assert.ok(res.success);
    assert.ok(res.order.id.startsWith('ord_'));
    assert.strictEqual(res.order.status, 'confirmed');
  });

  it('fails when stock is insufficient', async () => {
    const { processor } = makeProcessor();
    const bigOrder = [{ productId: 'p1', quantity: 50, price: 25 }];
    const res = await processor.createOrder('cust1', bigOrder, 'bronze', null, method, addr);
    assert.strictEqual(res.success, false);
  });

  it('cancels an order and records reason', async () => {
    const { processor } = makeProcessor();
    const { order } = await processor.createOrder('cust1', items, 'bronze', null, method, addr);
    const cancel = await processor.cancelOrder(order.id, 'changed mind');
    assert.ok(cancel.success);
    assert.strictEqual(processor.getOrder(order.id).status, 'cancelled');
  });

  it('ships a confirmed order', async () => {
    const { processor } = makeProcessor();
    const { order } = await processor.createOrder('cust1', items, 'bronze', null, method, addr);
    const shipped = processor.shipOrder(order.id, 'TRACK123');
    assert.ok(shipped);
    assert.strictEqual(processor.getOrder(order.id).status, 'shipped');
  });

  it('returns page 1 of order history', async () => {
    const { processor } = makeProcessor();
    for (let i = 0; i < 12; i++) {
      await processor.createOrder(`cust1`, items, 'bronze', null, method, addr);
    }
    const page1 = processor.getOrderHistory('cust1', 1, 10);
    assert.strictEqual(page1.length, 10);
  });
});

// ---------------------------------------------------------------------------
// CustomerAccountManager tests
// ---------------------------------------------------------------------------

describe('CustomerAccountManager', () => {
  it('creates an account', async () => {
    const mgr = new CustomerAccountManager();
    const res = await mgr.createAccount('alice@example.com', 'hunter2', 'Alice');
    assert.ok(res.success);
  });

  it('rejects duplicate emails', async () => {
    const mgr = new CustomerAccountManager();
    await mgr.createAccount('alice@example.com', 'hunter2', 'Alice');
    const res = await mgr.createAccount('alice@example.com', 'other', 'Alice2');
    assert.strictEqual(res.success, false);
  });

  it('logs in with correct password', async () => {
    const mgr = new CustomerAccountManager();
    await mgr.createAccount('alice@example.com', 'hunter2', 'Alice');
    const res = await mgr.login('alice@example.com', 'hunter2');
    assert.ok(res.success);
    assert.ok(res.token);
  });

  it('rejects wrong password', async () => {
    const mgr = new CustomerAccountManager();
    await mgr.createAccount('alice@example.com', 'hunter2', 'Alice');
    const res = await mgr.login('alice@example.com', 'wrong');
    assert.strictEqual(res.success, false);
  });

  it('validates a live session', async () => {
    const mgr = new CustomerAccountManager();
    await mgr.createAccount('alice@example.com', 'hunter2', 'Alice');
    const { token } = await mgr.login('alice@example.com', 'hunter2');
    const session = mgr.validateSession(token);
    assert.ok(session);
    assert.strictEqual(session.email, 'alice@example.com');
  });

  it('adds loyalty points and updates tier', () => {
    const mgr = new CustomerAccountManager();
    mgr.accounts.set('alice@example.com', {
      id: 'cust1', tier: 'bronze', loyaltyPoints: 900,
    });
    mgr.addLoyaltyPoints('cust1', 200);
    const acc = mgr.accounts.get('alice@example.com');
    assert.strictEqual(acc.loyaltyPoints, 1100);
    assert.strictEqual(acc.tier, 'silver');
  });

  it('redeems loyalty points for a discount', () => {
    const mgr = new CustomerAccountManager();
    mgr.accounts.set('a@b.com', { id: 'cust1', tier: 'silver', loyaltyPoints: 500 });
    const res = mgr.redeemLoyaltyPoints('cust1', 200);
    assert.ok(res.success);
    // 200 points at 1 cent each = $2.00 discount
    assert.strictEqual(res.discountAmount, 2.00);
  });
});

// ---------------------------------------------------------------------------
// ReviewSystem tests
// ---------------------------------------------------------------------------

describe('ReviewSystem', () => {
  it('adds a review and retrieves rating', () => {
    const rs = new ReviewSystem();
    rs.addReview('p1', 'c1', 5, 'Great', 'Loved it');
    rs.addReview('p1', 'c2', 4, 'Good', 'Pretty good');
    rs.addReview('p1', 'c3', 4, 'Good', 'Solid product');
    const rating = rs.getProductRating('p1');
    assert.ok(rating > 4 && rating < 5, `Expected ~4.33, got ${rating}`);
  });

  it('returns top reviews sorted by helpfulness (most helpful first)', () => {
    const rs = new ReviewSystem();
    rs.addReview('p1', 'c1', 5, 'Best', 'Awesome');
    rs.addReview('p1', 'c2', 3, 'Meh', 'Average');
    const ids = [...rs.productReviews.get('p1')];
    rs.reviews.get(ids[0]).helpful = 10;
    rs.reviews.get(ids[1]).helpful = 1;
    const top = rs.getTopReviews('p1', 2);
    assert.strictEqual(top[0].helpful, 10);
  });

  it('prevents duplicate reviews from same customer', () => {
    const rs = new ReviewSystem();
    rs.addReview('p1', 'c1', 5, 'First', 'Great');
    const second = rs.addReview('p1', 'c1', 1, 'Second', 'Changed mind');
    assert.strictEqual(second.success, false);
  });
});

// ---------------------------------------------------------------------------
// CartService tests
// ---------------------------------------------------------------------------

describe('CartService', () => {
  it('adds and removes items', () => {
    const cs = new CartService(new PricingEngine());
    cs.addItem('sess1', 'p1', 2, 10);
    cs.addItem('sess1', 'p2', 1, 20);
    assert.strictEqual(cs._getOrCreate('sess1').items.length, 2);
    cs.removeItem('sess1', 'p1');
    assert.strictEqual(cs._getOrCreate('sess1').items.length, 1);
  });

  it('increments quantity for existing item', () => {
    const cs = new CartService(new PricingEngine());
    cs.addItem('sess1', 'p1', 2, 10);
    cs.addItem('sess1', 'p1', 3, 10);
    assert.strictEqual(cs._getOrCreate('sess1').items[0].quantity, 5);
  });

  it('only applies valid promo codes', () => {
    const cs = new CartService(new PricingEngine());
    cs.addItem('sess1', 'p1', 1, 100);
    const res = cs.applyPromoCode('sess1', 'FAKECODE');
    assert.strictEqual(res.success, false);
  });

  it('merges anonymous cart into authenticated cart', () => {
    const cs = new CartService(new PricingEngine());
    cs.addItem('anon', 'p1', 2, 10);
    cs.addItem('auth', 'p1', 1, 10);
    cs.mergeCarts('anon', 'auth');
    assert.strictEqual(cs._getOrCreate('auth').items[0].quantity, 3);
    assert.strictEqual(cs.carts.has('anon'), false);
  });
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let passed = 0, failed = 0;
const failures = [];

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

function it(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.then(() => {
        console.log(`  ✓ ${name}`);
        passed++;
      }).catch(err => {
        console.log(`  ✗ ${name}: ${err.message}`);
        failures.push({ name, err });
        failed++;
      });
    } else {
      console.log(`  ✓ ${name}`);
      passed++;
    }
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

process.on('exit', () => {
  console.log(`\n${passed} passed, ${failed} failed`);
});
