'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { Pool } = require('pg');
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

// ─── Products / Catalog ───────────────────────────────────────────────────────

router.get('/products', async (req, res) => {
  const { category, sort = 'created_at', order = 'DESC', page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const conditions = ['active = TRUE'];
  const params = [];
  let idx = 1;

  if (category) {
    conditions.push(`category = $${idx++}`);
    params.push(category);
  }

  const allowedSort = ['created_at', 'name', 'price'];
  const allowedOrder = ['ASC', 'DESC'];
  const safeSort = allowedSort.includes(sort) ? sort : 'created_at';
  const safeOrder = allowedOrder.includes(order.toUpperCase()) ? order.toUpperCase() : 'DESC';

  try {
    const result = await pool.query(
      `SELECT id, name, description, price, category, image_url FROM products WHERE ${conditions.join(' AND ')} ORDER BY ${safeSort} ${safeOrder} LIMIT $${idx++} OFFSET $${idx}`,
      [...params, parseInt(limit), offset],
    );
    return res.status(200).json({ products: result.rows });
  } catch (err) {
    console.error('[api] products error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve products' });
  }
});

router.get('/products/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, description, price, category, image_url, stock FROM products WHERE id = $1 AND active = TRUE',
      [req.params.id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[api] get-product error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve product' });
  }
});

// ─── Orders ───────────────────────────────────────────────────────────────────

router.get('/orders', requireAuth, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const result = await pool.query(
      `SELECT o.id, o.status, o.total, o.created_at,
              json_agg(json_build_object('product_id', oi.product_id, 'qty', oi.qty, 'price', oi.unit_price)) AS items
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.sub, parseInt(limit), offset],
    );
    return res.status(200).json({ orders: result.rows });
  } catch (err) {
    console.error('[api] orders error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve orders' });
  }
});

// ISSUE-8: IDOR — order ID is not checked against the requesting user
router.get('/orders/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.status, o.total, o.shipping_address, o.created_at,
              json_agg(json_build_object('product_id', oi.product_id, 'name', p.name, 'qty', oi.qty, 'price', oi.unit_price)) AS items
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN products p ON p.id = oi.product_id
       WHERE o.id = $1
       GROUP BY o.id`,
      [req.params.id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[api] get-order error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve order' });
  }
});

router.post('/orders', requireAuth, async (req, res) => {
  const { items, shippingAddress } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Items required' });
  }
  if (!shippingAddress) return res.status(400).json({ error: 'Shipping address required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let total = 0;
    const resolvedItems = [];

    for (const item of items) {
      const product = await client.query(
        'SELECT id, price, stock FROM products WHERE id = $1 AND active = TRUE',
        [item.productId],
      );
      if (product.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Product ${item.productId} not found` });
      }
      const p = product.rows[0];
      if (p.stock < item.qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Insufficient stock for product ${item.productId}` });
      }
      total += parseFloat(p.price) * item.qty;
      resolvedItems.push({ productId: item.productId, qty: item.qty, price: parseFloat(p.price) });
    }

    const orderResult = await client.query(
      `INSERT INTO orders (user_id, status, total, shipping_address, created_at) VALUES ($1, 'PENDING', $2, $3, NOW()) RETURNING id`,
      [req.user.sub, total, shippingAddress],
    );
    const orderId = orderResult.rows[0].id;

    for (const item of resolvedItems) {
      await client.query(
        'INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES ($1, $2, $3, $4)',
        [orderId, item.productId, item.qty, item.price],
      );
      await client.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2',
        [item.qty, item.productId],
      );
    }

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Order placed', orderId, total });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[api] create-order error:', err.message);
    return res.status(500).json({ error: 'Failed to create order' });
  } finally {
    client.release();
  }
});

router.post('/orders/:id/cancel', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE orders SET status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'PENDING' RETURNING id`,
      [req.params.id, req.user.sub],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found or cannot be cancelled' });
    return res.status(200).json({ message: 'Order cancelled' });
  } catch (err) {
    console.error('[api] cancel-order error:', err.message);
    return res.status(500).json({ error: 'Failed to cancel order' });
  }
});

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * GET /api/search
 * ISSUE-9: Reflected XSS — unsanitized query parameter echoed into HTML response
 */
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query parameter q is required' });

  try {
    const result = await pool.query(
      'SELECT id, name, description, price FROM products WHERE active = TRUE AND name ILIKE $1 LIMIT 20',
      [`%${q}%`],
    );

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`
      <html>
        <body>
          <h2>Search results for: ${q}</h2>
          <ul>
            ${result.rows.map((p) => `<li>${p.name} — $${p.price}</li>`).join('')}
          </ul>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[api] search error:', err.message);
    return res.status(500).json({ error: 'Search failed' });
  }
});

// ─── Webhooks / External Fetch ─────────────────────────────────────────────────

/**
 * POST /api/webhook-proxy
 * ISSUE-10: SSRF — user-supplied URL fetched without allowlist validation
 */
router.post('/webhook-proxy', requireAuth, async (req, res) => {
  const { url, payload } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const response = await axios.post(url, payload, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
    });
    return res.status(200).json({ status: response.status, data: response.data });
  } catch (err) {
    console.error('[api] webhook-proxy error:', err.message);
    return res.status(500).json({ error: 'Proxy request failed' });
  }
});

// ─── Profile ──────────────────────────────────────────────────────────────────

router.get('/profile', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, first_name, last_name, created_at FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.user.sub],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[api] profile error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve profile' });
  }
});

router.patch('/profile', requireAuth, async (req, res) => {
  const { firstName, lastName, email } = req.body;
  const updates = [];
  const params = [];
  let idx = 1;

  if (firstName) { updates.push(`first_name = $${idx++}`); params.push(firstName); }
  if (lastName) { updates.push(`last_name = $${idx++}`); params.push(lastName); }
  if (email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email' });
    updates.push(`email = $${idx++}`);
    params.push(email.toLowerCase().trim());
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields' });
  updates.push('updated_at = NOW()');
  params.push(req.user.sub);

  try {
    await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, params);
    return res.status(200).json({ message: 'Profile updated' });
  } catch (err) {
    console.error('[api] patch-profile error:', err.message);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ─── Notifications ────────────────────────────────────────────────────────────

router.get('/notifications', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, body, read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.sub],
    );
    return res.status(200).json({ notifications: result.rows });
  } catch (err) {
    console.error('[api] notifications error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve notifications' });
  }
});

router.post('/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE notifications SET read = TRUE, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.sub],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
    return res.status(200).json({ message: 'Marked as read' });
  } catch (err) {
    console.error('[api] read-notification error:', err.message);
    return res.status(500).json({ error: 'Failed to update notification' });
  }
});

module.exports = router;
