'use strict';

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const crypto = require('crypto');
const { requireAuth } = require('./auth');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: true },
  max: 5,
});

const NOTIFICATION_TYPES = ['TRANSACTION', 'SECURITY', 'MARKETING', 'SYSTEM'];
const PUSH_PROVIDER_URL = process.env.PUSH_PROVIDER_URL;
const PUSH_PROVIDER_KEY = process.env.PUSH_PROVIDER_KEY;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getPreferences(userId) {
  const result = await pool.query(
    `SELECT email_transactions, email_security, email_marketing, push_transactions, push_security, push_marketing
     FROM notification_preferences WHERE user_id = $1`,
    [userId],
  );
  if (result.rows.length === 0) {
    // Return defaults
    return {
      email_transactions: true,
      email_security: true,
      email_marketing: false,
      push_transactions: true,
      push_security: true,
      push_marketing: false,
    };
  }
  return result.rows[0];
}

async function getPushTokens(userId) {
  const result = await pool.query(
    'SELECT id, token, platform, active FROM push_tokens WHERE user_id = $1 AND active = TRUE',
    [userId],
  );
  return result.rows;
}

async function sendPushNotification(token, title, body, data = {}) {
  const axios = require('axios');
  await axios.post(
    `${PUSH_PROVIDER_URL}/send`,
    { token, notification: { title, body }, data },
    { headers: { Authorization: `Bearer ${PUSH_PROVIDER_KEY}` }, timeout: 5000 },
  );
}

async function createNotification(userId, type, title, body, metadata = null) {
  const result = await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, metadata, read, created_at)
     VALUES ($1, $2, $3, $4, $5, FALSE, NOW()) RETURNING id`,
    [userId, type, title, body, metadata ? JSON.stringify(metadata) : null],
  );
  return result.rows[0].id;
}

async function broadcastNotification(userIds, type, title, body, metadata = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const userId of userIds) {
      await client.query(
        `INSERT INTO notifications (user_id, type, title, body, metadata, read, created_at)
         VALUES ($1, $2, $3, $4, $5, FALSE, NOW())`,
        [userId, type, title, body, metadata ? JSON.stringify(metadata) : null],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /notifications
 */
router.get('/', requireAuth, async (req, res) => {
  const { page = 1, limit = 20, unreadOnly } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const conditions = ['user_id = $1'];
  const params = [req.user.sub];
  let idx = 2;

  if (unreadOnly === 'true') {
    conditions.push(`read = FALSE`);
  }

  try {
    const result = await pool.query(
      `SELECT id, type, title, body, read, created_at FROM notifications
       WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...params, parseInt(limit), offset],
    );
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM notifications WHERE ${conditions.join(' AND ')}`,
      params,
    );

    return res.status(200).json({
      notifications: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error('[notifications] list error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve notifications' });
  }
});

/**
 * GET /notifications/unread-count
 */
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = FALSE',
      [req.user.sub],
    );
    return res.status(200).json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('[notifications] unread-count error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve count' });
  }
});

/**
 * POST /notifications/:id/read
 */
router.post('/:id/read', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE notifications SET read = TRUE, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.sub],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
    return res.status(200).json({ message: 'Marked as read' });
  } catch (err) {
    console.error('[notifications] read error:', err.message);
    return res.status(500).json({ error: 'Failed to mark as read' });
  }
});

/**
 * POST /notifications/read-all
 */
router.post('/read-all', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read = TRUE, updated_at = NOW() WHERE user_id = $1 AND read = FALSE',
      [req.user.sub],
    );
    return res.status(200).json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error('[notifications] read-all error:', err.message);
    return res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

/**
 * DELETE /notifications/:id
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.sub],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
    return res.status(200).json({ message: 'Notification deleted' });
  } catch (err) {
    console.error('[notifications] delete error:', err.message);
    return res.status(500).json({ error: 'Failed to delete notification' });
  }
});

/**
 * DELETE /notifications
 */
router.delete('/', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM notifications WHERE user_id = $1', [req.user.sub]);
    return res.status(200).json({ message: 'All notifications deleted' });
  } catch (err) {
    console.error('[notifications] delete-all error:', err.message);
    return res.status(500).json({ error: 'Failed to delete notifications' });
  }
});

// ─── Preferences ──────────────────────────────────────────────────────────────

/**
 * GET /notifications/preferences
 */
router.get('/preferences', requireAuth, async (req, res) => {
  try {
    const prefs = await getPreferences(req.user.sub);
    return res.status(200).json(prefs);
  } catch (err) {
    console.error('[notifications] prefs error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve preferences' });
  }
});

/**
 * PATCH /notifications/preferences
 */
router.patch('/preferences', requireAuth, async (req, res) => {
  const allowed = ['email_transactions', 'email_security', 'email_marketing', 'push_transactions', 'push_security', 'push_marketing'];
  const updates = [];
  const params = [];
  let idx = 1;

  for (const key of allowed) {
    if (typeof req.body[key] === 'boolean') {
      updates.push(`${key} = $${idx++}`);
      params.push(req.body[key]);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid preference fields' });

  try {
    await pool.query(
      `INSERT INTO notification_preferences (user_id, ${allowed.join(', ')}, created_at, updated_at)
       VALUES ($${idx++}, ${allowed.map((_, i) => `$${idx + i}`).join(', ')}, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET ${updates.join(', ')}, updated_at = NOW()`,
      [req.user.sub, ...params],
    );
    return res.status(200).json({ message: 'Preferences updated' });
  } catch (err) {
    console.error('[notifications] update-prefs error:', err.message);
    return res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// ─── Push tokens ──────────────────────────────────────────────────────────────

/**
 * POST /notifications/push-token
 */
router.post('/push-token', requireAuth, async (req, res) => {
  const { token, platform } = req.body;
  if (!token || !platform) return res.status(400).json({ error: 'Token and platform required' });

  const allowedPlatforms = ['ios', 'android', 'web'];
  if (!allowedPlatforms.includes(platform)) return res.status(400).json({ error: 'Invalid platform' });

  try {
    await pool.query(
      `INSERT INTO push_tokens (user_id, token, platform, active, created_at)
       VALUES ($1, $2, $3, TRUE, NOW())
       ON CONFLICT (token) DO UPDATE SET user_id = $1, active = TRUE, updated_at = NOW()`,
      [req.user.sub, token, platform],
    );
    return res.status(200).json({ message: 'Push token registered' });
  } catch (err) {
    console.error('[notifications] push-token error:', err.message);
    return res.status(500).json({ error: 'Failed to register push token' });
  }
});

/**
 * DELETE /notifications/push-token
 */
router.delete('/push-token', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  try {
    await pool.query(
      'UPDATE push_tokens SET active = FALSE, updated_at = NOW() WHERE token = $1 AND user_id = $2',
      [token, req.user.sub],
    );
    return res.status(200).json({ message: 'Push token removed' });
  } catch (err) {
    console.error('[notifications] remove-push-token error:', err.message);
    return res.status(500).json({ error: 'Failed to remove push token' });
  }
});

module.exports = { router, createNotification, broadcastNotification };
