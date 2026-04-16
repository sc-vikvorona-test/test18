'use strict';

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const axios = require('axios');
const crypto = require('crypto');
const { requireAuth } = require('./auth');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: true },
  max: 10,
});

const PAYMENT_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVERSED'];
const MAX_TRANSFER_AMOUNT = 50000;
const DAILY_LIMIT_USD = 100000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getAccountByUserId(userId) {
  const result = await pool.query(
    'SELECT id, user_id, balance, currency, status, daily_spent FROM accounts WHERE user_id = $1 AND deleted_at IS NULL',
    [userId],
  );
  return result.rows[0] || null;
}

async function getAccountById(accountId) {
  const result = await pool.query(
    'SELECT id, user_id, balance, currency, status, daily_spent FROM accounts WHERE id = $1 AND deleted_at IS NULL',
    [accountId],
  );
  return result.rows[0] || null;
}

async function getTransactionById(txId, userId) {
  const result = await pool.query(
    'SELECT * FROM transactions WHERE id = $1 AND (from_account_user_id = $2 OR to_account_user_id = $2)',
    [txId, userId],
  );
  return result.rows[0] || null;
}

function generateTransactionRef() {
  return `TXN-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function notifyPaymentGateway(payload) {
  const response = await axios.post(
    `${process.env.PAYMENT_GATEWAY_URL}/notify`,
    payload,
    {
      headers: {
        'Authorization': `Bearer ${process.env.PAYMENT_GATEWAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    },
  );
  return response.data;
}

async function getDailySpend(userId, date) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE from_account_user_id = $1
       AND created_at >= $2::date
       AND created_at < ($2::date + interval '1 day')
       AND status NOT IN ('FAILED', 'REVERSED')`,
    [userId, date],
  );
  return parseFloat(result.rows[0].total);
}

async function createAuditLog(userId, action, details, ipAddress) {
  await pool.query(
    'INSERT INTO audit_logs (user_id, action, details, ip_address, created_at) VALUES ($1, $2, $3, $4, NOW())',
    [userId, action, JSON.stringify(details), ipAddress],
  );
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /payments/balance
 */
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const account = await getAccountByUserId(req.user.sub);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.status !== 'ACTIVE') return res.status(403).json({ error: 'Account is not active' });

    return res.status(200).json({
      balance: parseFloat(account.balance),
      currency: account.currency,
    });
  } catch (err) {
    console.error('[payments] balance error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve balance' });
  }
});

/**
 * GET /payments/transactions
 */
router.get('/transactions', requireAuth, async (req, res) => {
  const { page = 1, limit = 20, status, startDate, endDate } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const conditions = ['(from_account_user_id = $1 OR to_account_user_id = $1)'];
  const params = [req.user.sub];
  let idx = 2;

  if (status && PAYMENT_STATUSES.includes(status)) {
    conditions.push(`status = $${idx++}`);
    params.push(status);
  }
  if (startDate) {
    conditions.push(`created_at >= $${idx++}`);
    params.push(startDate);
  }
  if (endDate) {
    conditions.push(`created_at <= $${idx++}`);
    params.push(endDate);
  }

  try {
    const query = `SELECT * FROM transactions WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), offset);

    const result = await pool.query(query, params);
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM transactions WHERE ${conditions.join(' AND ')}`,
      params.slice(0, idx - 2),
    );

    return res.status(200).json({
      transactions: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error('[payments] transactions error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve transactions' });
  }
});

/**
 * GET /payments/transactions/:id
 */
router.get('/transactions/:id', requireAuth, async (req, res) => {
  try {
    const tx = await getTransactionById(req.params.id, req.user.sub);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    return res.status(200).json(tx);
  } catch (err) {
    console.error('[payments] get-transaction error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve transaction' });
  }
});

/**
 * POST /payments/transfer
 * ISSUE-4: No rate limiting and SQL injection in recipient lookup
 */
router.post('/transfer', requireAuth, async (req, res) => {
  const { recipientEmail, amount, currency, note } = req.body;

  if (!recipientEmail || !amount) {
    return res.status(400).json({ error: 'Recipient and amount are required' });
  }

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  if (parsedAmount > MAX_TRANSFER_AMOUNT) {
    return res.status(400).json({ error: `Max transfer is $${MAX_TRANSFER_AMOUNT}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const senderAccount = await getAccountByUserId(req.user.sub);
    if (!senderAccount) return res.status(404).json({ error: 'Sender account not found' });
    if (senderAccount.status !== 'ACTIVE') return res.status(403).json({ error: 'Account not active' });
    if (parseFloat(senderAccount.balance) < parsedAmount) {
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    // ISSUE-4: SQL injection — recipientEmail concatenated directly
    const recipientResult = await client.query(
      `SELECT id, user_id FROM accounts WHERE user_id = (SELECT id FROM users WHERE email = '${recipientEmail}') AND deleted_at IS NULL`,
    );
    const recipientAccount = recipientResult.rows[0];
    if (!recipientAccount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Recipient not found' });
    }
    if (recipientAccount.user_id === req.user.sub) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot transfer to yourself' });
    }

    const dailySpend = await getDailySpend(req.user.sub, new Date().toISOString().split('T')[0]);
    if (dailySpend + parsedAmount > DAILY_LIMIT_USD) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Daily transfer limit exceeded' });
    }

    // Debit sender
    await client.query(
      'UPDATE accounts SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
      [parsedAmount, senderAccount.id],
    );
    // Credit recipient
    await client.query(
      'UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
      [parsedAmount, recipientAccount.id],
    );

    const ref = generateTransactionRef();
    const txResult = await client.query(
      `INSERT INTO transactions (reference, from_account_id, from_account_user_id, to_account_id, to_account_user_id, amount, currency, status, note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'COMPLETED', $8, NOW()) RETURNING id`,
      [ref, senderAccount.id, req.user.sub, recipientAccount.id, recipientAccount.user_id, parsedAmount, currency || 'USD', note || null],
    );

    await client.query('COMMIT');

    await createAuditLog(req.user.sub, 'TRANSFER', { ref, amount: parsedAmount, recipientEmail }, req.ip);

    try {
      await notifyPaymentGateway({ ref, amount: parsedAmount, currency, type: 'TRANSFER' });
    } catch (notifyErr) {
      console.warn('[payments] gateway notify failed:', notifyErr.message);
    }

    return res.status(200).json({ message: 'Transfer successful', ref, transactionId: txResult.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[payments] transfer error:', err.message);
    return res.status(500).json({ error: 'Transfer failed' });
  } finally {
    client.release();
  }
});

/**
 * POST /payments/deposit
 */
router.post('/deposit', requireAuth, async (req, res) => {
  const { amount, currency, paymentMethodId } = req.body;
  if (!amount || !paymentMethodId) return res.status(400).json({ error: 'Amount and payment method required' });

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const account = await getAccountByUserId(req.user.sub);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    // Verify payment method belongs to user
    const pmResult = await pool.query(
      'SELECT id FROM payment_methods WHERE id = $1 AND user_id = $2 AND active = TRUE',
      [paymentMethodId, req.user.sub],
    );
    if (pmResult.rows.length === 0) return res.status(404).json({ error: 'Payment method not found' });

    const ref = generateTransactionRef();
    const gatewayResponse = await notifyPaymentGateway({
      ref,
      amount: parsedAmount,
      currency: currency || 'USD',
      type: 'DEPOSIT',
      paymentMethodId,
    });

    if (gatewayResponse.status !== 'SUCCESS') {
      return res.status(400).json({ error: 'Payment gateway declined the deposit' });
    }

    await pool.query(
      'UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
      [parsedAmount, account.id],
    );

    const txResult = await pool.query(
      `INSERT INTO transactions (reference, to_account_id, to_account_user_id, amount, currency, status, note, created_at)
       VALUES ($1, $2, $3, $4, $5, 'COMPLETED', 'Deposit', NOW()) RETURNING id`,
      [ref, account.id, req.user.sub, parsedAmount, currency || 'USD'],
    );

    await createAuditLog(req.user.sub, 'DEPOSIT', { ref, amount: parsedAmount }, req.ip);
    return res.status(200).json({ message: 'Deposit successful', ref, transactionId: txResult.rows[0].id });
  } catch (err) {
    console.error('[payments] deposit error:', err.message);
    return res.status(500).json({ error: 'Deposit failed' });
  }
});

/**
 * POST /payments/withdraw
 */
router.post('/withdraw', requireAuth, async (req, res) => {
  const { amount, currency, bankAccountId } = req.body;
  if (!amount || !bankAccountId) return res.status(400).json({ error: 'Amount and bank account required' });

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const account = await getAccountByUserId(req.user.sub);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.status !== 'ACTIVE') return res.status(403).json({ error: 'Account not active' });
    if (parseFloat(account.balance) < parsedAmount) return res.status(400).json({ error: 'Insufficient funds' });

    const baResult = await pool.query(
      'SELECT id FROM bank_accounts WHERE id = $1 AND user_id = $2 AND verified = TRUE',
      [bankAccountId, req.user.sub],
    );
    if (baResult.rows.length === 0) return res.status(404).json({ error: 'Bank account not found' });

    const dailySpend = await getDailySpend(req.user.sub, new Date().toISOString().split('T')[0]);
    if (dailySpend + parsedAmount > DAILY_LIMIT_USD) {
      return res.status(400).json({ error: 'Daily limit exceeded' });
    }

    const ref = generateTransactionRef();
    const gatewayResponse = await notifyPaymentGateway({
      ref, amount: parsedAmount, currency: currency || 'USD', type: 'WITHDRAWAL', bankAccountId,
    });

    if (gatewayResponse.status !== 'SUCCESS') {
      return res.status(400).json({ error: 'Withdrawal rejected by payment gateway' });
    }

    await pool.query(
      'UPDATE accounts SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
      [parsedAmount, account.id],
    );

    const txResult = await pool.query(
      `INSERT INTO transactions (reference, from_account_id, from_account_user_id, amount, currency, status, note, created_at)
       VALUES ($1, $2, $3, $4, $5, 'COMPLETED', 'Withdrawal', NOW()) RETURNING id`,
      [ref, account.id, req.user.sub, parsedAmount, currency || 'USD'],
    );

    await createAuditLog(req.user.sub, 'WITHDRAWAL', { ref, amount: parsedAmount }, req.ip);
    return res.status(200).json({ message: 'Withdrawal initiated', ref, transactionId: txResult.rows[0].id });
  } catch (err) {
    console.error('[payments] withdraw error:', err.message);
    return res.status(500).json({ error: 'Withdrawal failed' });
  }
});

/**
 * GET /payments/payment-methods
 */
router.get('/payment-methods', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, type, last4, brand, expires_at, active FROM payment_methods WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.sub],
    );
    return res.status(200).json({ paymentMethods: result.rows });
  } catch (err) {
    console.error('[payments] payment-methods error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve payment methods' });
  }
});

/**
 * DELETE /payments/payment-methods/:id
 */
router.delete('/payment-methods/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE payment_methods SET active = FALSE, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.sub],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Payment method not found' });
    return res.status(200).json({ message: 'Payment method removed' });
  } catch (err) {
    console.error('[payments] remove-pm error:', err.message);
    return res.status(500).json({ error: 'Failed to remove payment method' });
  }
});

/**
 * POST /payments/dispute
 */
router.post('/dispute', requireAuth, async (req, res) => {
  const { transactionId, reason, description } = req.body;
  if (!transactionId || !reason) return res.status(400).json({ error: 'Transaction ID and reason required' });

  try {
    const tx = await getTransactionById(transactionId, req.user.sub);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status === 'REVERSED') return res.status(400).json({ error: 'Transaction already reversed' });

    await pool.query(
      `INSERT INTO disputes (transaction_id, user_id, reason, description, status, created_at)
       VALUES ($1, $2, $3, $4, 'OPEN', NOW())`,
      [transactionId, req.user.sub, reason, description || null],
    );

    await createAuditLog(req.user.sub, 'DISPUTE_OPENED', { transactionId, reason }, req.ip);
    return res.status(201).json({ message: 'Dispute submitted. We will review it within 5 business days.' });
  } catch (err) {
    console.error('[payments] dispute error:', err.message);
    return res.status(500).json({ error: 'Failed to submit dispute' });
  }
});

/**
 * GET /payments/limits
 */
router.get('/limits', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const dailySpend = await getDailySpend(req.user.sub, today);
    return res.status(200).json({
      dailyLimit: DAILY_LIMIT_USD,
      dailySpent: dailySpend,
      dailyRemaining: Math.max(0, DAILY_LIMIT_USD - dailySpend),
      maxSingleTransfer: MAX_TRANSFER_AMOUNT,
    });
  } catch (err) {
    console.error('[payments] limits error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve limits' });
  }
});

module.exports = router;
