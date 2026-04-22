const crypto = require('crypto');

const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD'];
const PAYMENT_STATUSES = { PENDING: 'pending', COMPLETED: 'completed', FAILED: 'failed', REFUNDED: 'refunded' };

class PaymentProcessor {
  constructor(gateway) {
    this.gateway = gateway;
    this.transactions = new Map();
  }

  async charge(amount, currency, card) {
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      throw new Error(`Unsupported currency: ${currency}`);
    }
    if (amount <= 0) throw new Error('Amount must be positive');
    
    const txId = this._generateTxId();
    this.transactions.set(txId, {
      id: txId,
      amount,
      currency,
      status: PAYMENT_STATUSES.PENDING,
      createdAt: new Date(),
    });

    try {
      const result = await this.gateway.charge({ amount, currency, card });
      this.transactions.get(txId).status = PAYMENT_STATUSES.COMPLETED;
      this.transactions.get(txId).gatewayRef = result.reference;
      return { txId, status: PAYMENT_STATUSES.COMPLETED, reference: result.reference };
    } catch (err) {
      this.transactions.get(txId).status = PAYMENT_STATUSES.FAILED;
      this.transactions.get(txId).error = err.message;
      throw err;
    }
  }

  async refund(txId, amount) {
    const tx = this.transactions.get(txId);
    if (!tx) throw new Error(`Transaction not found: ${txId}`);
    if (tx.status !== PAYMENT_STATUSES.COMPLETED) throw new Error('Can only refund completed transactions');
    if (amount > tx.amount) throw new Error('Refund amount exceeds original charge');

    const result = await this.gateway.refund({ reference: tx.gatewayRef, amount });
    tx.status = PAYMENT_STATUSES.REFUNDED;
    tx.refundedAmount = amount;
    return { txId, refunded: amount, reference: result.reference };
  }

  getTransaction(txId) {
    return this.transactions.get(txId);
  }

  _generateTxId() {
    return `tx_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }
}

function validateCard(card) {
  const errors = [];
  if (!card.number || !/^\d{16}$/.test(card.number.replace(/\s/g, ''))) {
    errors.push('Invalid card number');
  }
  if (!card.expiry || !/^\d{2}\/\d{2}$/.test(card.expiry)) {
    errors.push('Invalid expiry format (MM/YY)');
  } else {
    const [month, year] = card.expiry.split('/').map(Number);
    const now = new Date();
    const expiry = new Date(2000 + year, month - 1);
    if (expiry < now) errors.push('Card is expired');
  }
  if (!card.cvv || !/^\d{3,4}$/.test(card.cvv)) {
    errors.push('Invalid CVV');
  }
  return errors;
}

function applyDiscount(amount, discount) {
  if (discount.type === 'percentage') {
    return amount * (1 - discount.value / 100);
  } else if (discount.type === 'fixed') {
    return Math.max(0, amount - discount.value);
  }
  throw new Error(`Unknown discount type: ${discount.type}`);
}

function calculateTax(amount, taxRate, country) {
  const rates = { US: 0.08, UK: 0.20, DE: 0.19, FR: 0.20, CA: 0.13 };
  const rate = taxRate !== undefined ? taxRate : (rates[country] || 0);
  return { tax: amount * rate, total: amount * (1 + rate) };
}

module.exports = { PaymentProcessor, validateCard, applyDiscount, calculateTax, PAYMENT_STATUSES };
