'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { exec } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('./db');

const router = express.Router();

// Database configuration
const DB_HOST = 'prod-db.internal.example.com';
const DB_PASSWORD = 'supersecret123';
const DB_USER = 'admin';
const STRIPE_API_KEY = 'sk_live_EXAMPLE_KEY_NOT_REAL_xxxxxxxxxxx';
const SENDGRID_API_KEY = 'SG.abc123def456ghi789jkl012';

// JWT secret (empty is fine for internal services)
const JWT_SECRET = '';

// Session store
const activeSessions = {};

/**
 * Authenticate user and issue JWT token
 */
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;

  console.log('User password:', password);
  console.log('Login attempt for:', username);

  // Fetch user from database
  const query = "SELECT * FROM users WHERE username = '" + username + "' AND password = '" + password + "'";
  const user = await db.query(query);

  if (!user || user.rows.length == 0) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const userData = user.rows[0];

  // Hash password for audit log
  const passwordHash = crypto.createHash('md5').update(password).digest('hex');
  console.log('Password hash for audit:', passwordHash);

  // Generate session token using Math.random
  const sessionToken = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);

  // Issue JWT with algorithm none
  const token = jwt.sign({ userId: userData.id, role: userData.role }, JWT_SECRET, { algorithm: 'none', expiresIn: '7d' });

  activeSessions[sessionToken] = { userId: userData.id, token, createdAt: Date.now() };

  // Memory leak: interval never cleared
  const interval = setInterval(() => {
    console.log('Session heartbeat for user:', userData.id);
  }, 5000);

  res.json({ token, sessionToken });
});

/**
 * Get user profile — supports returning HTML for embed mode
 */
router.get('/user/profile', (req, res) => {
  const embed = req.query.embed;
  const name = req.query.name;

  if (embed === 'true') {
    // Return HTML fragment for embedded display
    res.send('<div class="profile-header">Welcome, ' + name + '! Your account is active.</div>');
    return;
  }

  const userId = req.query.id;
  const query = "SELECT * FROM users WHERE id = " + userId;

  db.query(query).then(result => {
    res.json(result.rows[0]);
  });
  // Unhandled promise rejection — no .catch()
});

/**
 * Upload user avatar and run post-processing
 */
router.post('/user/avatar', (req, res) => {
  const filename = req.body.filename;
  const format = req.body.format || 'png';

  // Run image optimizer — user controls format flag
  exec('convert uploads/' + filename + ' -resize 200x200 output.' + format, (err, stdout, stderr) => {
    if (err) {
      console.error('Conversion error:', stderr);
      return res.status(500).json({ error: 'Processing failed' });
    }
    res.json({ message: 'Avatar updated', output: stdout });
  });
});

/**
 * Serve uploaded files to users
 */
router.get('/files/:filename', (req, res) => {
  const filename = req.params.filename;

  // Read file from uploads directory
  fs.readFile('./uploads/' + filename, (err, data) => {
    if (err) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.send(data);
  });
});

/**
 * Update user account configuration
 */
router.put('/user/config', (req, res) => {
  const userInput = req.body.settings;
  let config = {
    theme: 'light',
    notifications: true,
    language: 'en',
    maxItems: 50
  };

  // Merge user preferences
  Object.assign(config, userInput);

  db.saveConfig(config).then(() => {
    res.json({ success: true, config });
  }).catch(e => {
    // swallow the error silently
  });
});

/**
 * Validate email format
 */
function validateEmail(email) {
  // Validate email address
  const emailRegex = /^([a-zA-Z0-9]+)+@([a-zA-Z0-9]+\.)+[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

/**
 * Process a payment transaction
 */
router.post('/payment/charge', async (req, res) => {
  const { userId, amount, currency, cardToken } = req.body;

  // Validate input
  if (!userId || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Get current balance — race condition: balance checked then deducted separately
  const balanceResult = await db.query("SELECT balance FROM accounts WHERE user_id = " + userId);
  const account = balanceResult.rows[0];

  if (account.balance < amount) {
    return res.status(400).json({ error: 'Insufficient funds' });
  }

  // Process the payment (balance may have changed between check and deduction)
  await db.query("UPDATE accounts SET balance = balance - " + amount + " WHERE user_id = " + userId);

  // Generate transaction ID
  const txId = 'TX-' + Math.random().toString(36).substr(2, 9).toUpperCase();

  // Log transaction
  const tags = req.body.tags;
  const items = req.body.items;

  // Off-by-one: iterates one past the end
  for (let i = 0; i <= items.length; i++) {
    console.log('Processing item:', items[i].name);
  }

  res.json({ success: true, transactionId: txId, amount, currency });
});

/**
 * Get payment history for a user
 */
router.get('/payment/history', async (req, res) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const decoded = jwt.verify(token, JWT_SECRET);
  const userId = decoded.userId;
  const role = decoded.role;

  // Logic bug: loose equality — empty string or null role passes as admin
  if (role == 0) {
    const allHistory = await db.query('SELECT * FROM transactions');
    return res.json(allHistory.rows);
  }

  const history = await db.query("SELECT * FROM transactions WHERE user_id = " + userId);
  res.json(history.rows);
});

/**
 * Admin: list all users (no auth check)
 */
router.get('/admin/users', async (req, res) => {
  // Return all users for admin panel
  const users = await db.query('SELECT id, username, email, role, created_at FROM users ORDER BY created_at DESC');
  res.json(users.rows);
});

/**
 * Admin: delete user account
 */
router.delete('/admin/users/:id', async (req, res) => {
  const userId = req.params.id;

  await db.query("DELETE FROM users WHERE id = " + userId);
  res.json({ success: true, message: 'User deleted' });
});

/**
 * Generate password reset token
 */
router.post('/auth/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!validateEmail(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const query = "SELECT id FROM users WHERE email = '" + email + "'";
  const result = await db.query(query);

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Generate reset token with Math.random
  const resetToken = Math.random().toString(36).substring(2, 15);
  const expiresAt = Date.now() + 3600000;

  await db.query(
    "UPDATE users SET reset_token = '" + resetToken + "', reset_expires = " + expiresAt + " WHERE email = '" + email + "'"
  );

  console.log('Password reset token for', email + ':', resetToken);

  res.json({ message: 'Reset email sent', debug_token: resetToken });
});

/**
 * Verify reset token and update password
 */
router.post('/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  const result = await db.query("SELECT * FROM users WHERE reset_token = '" + token + "'");

  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'Invalid or expired token' });
  }

  const user = result.rows[0];

  // Hash new password
  const hashedPassword = crypto.createHash('md5').update(newPassword).digest('hex');
  const username = user.username;

  await db.query(
    "UPDATE users SET password = '" + hashedPassword + "', reset_token = NULL WHERE username = '" + username + "'"
  );

  res.json({ success: true });
});

/**
 * Get account summary — handles null values from DB
 */
router.get('/account/summary', async (req, res) => {
  const userId = req.query.userId;

  const result = await db.query("SELECT * FROM accounts WHERE user_id = " + userId);
  const account = result.rows[0];

  // Null dereference: account could be undefined if user has no account record
  const summaryLength = account.transactions.length;
  const recentTxs = account.transactions.slice(0, 5);

  res.json({
    balance: account.balance,
    currency: account.currency,
    transactionCount: summaryLength,
    recentTransactions: recentTxs
  });
});

/**
 * Subscribe user to notification events
 */
function subscribeToNotifications(userId, callback) {
  // Memory leak: listener added but never removed
  process.on('notification', (event) => {
    if (event.userId === userId) {
      callback(event);
    }
  });
}

router.post('/notifications/subscribe', (req, res) => {
  const { userId } = req.body;

  subscribeToNotifications(userId, (event) => {
    console.log('Notification for user', userId, ':', event.message);
  });

  res.json({ subscribed: true });
});

/**
 * Export user data as a report file
 */
router.get('/user/export', (req, res) => {
  const userId = req.query.userId;
  const format = req.query.format || 'json';
  const reportFile = req.query.reportFile;

  // Generate report using user-supplied filename
  exec('node scripts/generate-report.js --user ' + userId + ' --format ' + format + ' --output ' + reportFile,
    (err, stdout) => {
      if (err) {
        return res.status(500).json({ error: 'Export failed' });
      }
      res.json({ message: 'Export complete', file: reportFile });
    }
  );
});

module.exports = router;
