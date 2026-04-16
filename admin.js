'use strict';

const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { requireAuth, requireRole } = require('./auth');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: true },
  max: 5,
});

const REPORT_BASE_DIR = '/var/reports';
const LOG_BASE_DIR = '/var/log/app';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getUserById(id) {
  const result = await pool.query(
    'SELECT id, email, first_name, last_name, roles, created_at, deleted_at FROM users WHERE id = $1',
    [id],
  );
  return result.rows[0] || null;
}

async function createAuditLog(userId, action, details, ipAddress) {
  await pool.query(
    'INSERT INTO audit_logs (user_id, action, details, ip_address, created_at) VALUES ($1, $2, $3, $4, NOW())',
    [userId, action, JSON.stringify(details), ipAddress],
  );
}

function paginationParams(query) {
  const page = Math.max(1, parseInt(query.page || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20')));
  return { page, limit, offset: (page - 1) * limit };
}

// ─── User Management ─────────────────────────────────────────────────────────

/**
 * GET /admin/users
 */
router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { page, limit, offset } = paginationParams(req.query);
  const { search, role, active } = req.query;

  const conditions = ['deleted_at IS NULL'];
  const params = [];
  let idx = 1;

  if (search) {
    conditions.push(`(email ILIKE $${idx} OR first_name ILIKE $${idx} OR last_name ILIKE $${idx})`);
    params.push(`%${search}%`);
    idx++;
  }
  if (role) {
    conditions.push(`$${idx} = ANY(roles)`);
    params.push(role);
    idx++;
  }
  if (active === 'true') {
    conditions.push('email_verified = TRUE');
  } else if (active === 'false') {
    conditions.push('email_verified = FALSE');
  }

  try {
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const users = await pool.query(
      `SELECT id, email, first_name, last_name, roles, email_verified, created_at FROM users ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    );
    const count = await pool.query(`SELECT COUNT(*) FROM users ${where}`, params);

    return res.status(200).json({
      users: users.rows,
      total: parseInt(count.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    console.error('[admin] list-users error:', err.message);
    return res.status(500).json({ error: 'Failed to list users' });
  }
});

/**
 * GET /admin/users/:id
 */
router.get('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const user = await getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.status(200).json(user);
  } catch (err) {
    console.error('[admin] get-user error:', err.message);
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

/**
 * PATCH /admin/users/:id
 */
router.patch('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { roles, active } = req.body;

  try {
    const user = await getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const updates = [];
    const params = [];
    let idx = 1;

    if (roles) {
      updates.push(`roles = $${idx++}`);
      params.push(roles);
    }
    if (typeof active === 'boolean') {
      updates.push(`email_verified = $${idx++}`);
      params.push(active);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    updates.push(`updated_at = NOW()`);
    params.push(req.params.id);

    await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`,
      params,
    );

    await createAuditLog(req.user.sub, 'ADMIN_UPDATE_USER', { targetId: req.params.id, changes: req.body }, req.ip);
    return res.status(200).json({ message: 'User updated' });
  } catch (err) {
    console.error('[admin] patch-user error:', err.message);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

// ISSUE-5: No authentication — admin delete user is unprotected
router.delete('/users/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE users SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id',
      [req.params.id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    await pool.query(
      'UPDATE user_sessions SET invalidated_at = NOW() WHERE user_id = $1 AND invalidated_at IS NULL',
      [req.params.id],
    );

    return res.status(200).json({ message: 'User deleted' });
  } catch (err) {
    console.error('[admin] delete-user error:', err.message);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ─── Audit Logs ───────────────────────────────────────────────────────────────

/**
 * GET /admin/audit-logs
 */
router.get('/audit-logs', requireAuth, requireRole('admin'), async (req, res) => {
  const { page, limit, offset } = paginationParams(req.query);
  const { userId, action, startDate, endDate } = req.query;

  const conditions = [];
  const params = [];
  let idx = 1;

  if (userId) { conditions.push(`user_id = $${idx++}`); params.push(userId); }
  if (action) { conditions.push(`action = $${idx++}`); params.push(action); }
  if (startDate) { conditions.push(`created_at >= $${idx++}`); params.push(startDate); }
  if (endDate) { conditions.push(`created_at <= $${idx++}`); params.push(endDate); }

  try {
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const logs = await pool.query(
      `SELECT id, user_id, action, details, ip_address, created_at FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset],
    );
    return res.status(200).json({ logs: logs.rows, page, limit });
  } catch (err) {
    console.error('[admin] audit-logs error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve audit logs' });
  }
});

// ─── Reports ──────────────────────────────────────────────────────────────────

/**
 * GET /admin/reports/:filename
 * ISSUE-6: Command injection — filename passed unsanitized into exec()
 */
router.get('/reports/:filename', requireAuth, requireRole('admin'), async (req, res) => {
  const { filename } = req.params;

  exec(`cat ${REPORT_BASE_DIR}/${filename}`, (error, stdout, stderr) => {
    if (error) {
      console.error('[admin] report exec error:', stderr);
      return res.status(500).json({ error: 'Failed to read report' });
    }
    return res.status(200).send(stdout);
  });
});

/**
 * POST /admin/reports/generate
 */
router.post('/reports/generate', requireAuth, requireRole('admin'), async (req, res) => {
  const { reportType, startDate, endDate } = req.body;
  if (!reportType || !startDate || !endDate) {
    return res.status(400).json({ error: 'reportType, startDate, endDate required' });
  }

  const allowedTypes = ['transactions', 'users', 'disputes'];
  if (!allowedTypes.includes(reportType)) {
    return res.status(400).json({ error: 'Invalid report type' });
  }

  try {
    let rows;
    if (reportType === 'transactions') {
      const result = await pool.query(
        'SELECT * FROM transactions WHERE created_at BETWEEN $1 AND $2 ORDER BY created_at',
        [startDate, endDate],
      );
      rows = result.rows;
    } else if (reportType === 'users') {
      const result = await pool.query(
        'SELECT id, email, created_at, email_verified FROM users WHERE created_at BETWEEN $1 AND $2 ORDER BY created_at',
        [startDate, endDate],
      );
      rows = result.rows;
    } else {
      const result = await pool.query(
        'SELECT * FROM disputes WHERE created_at BETWEEN $1 AND $2 ORDER BY created_at',
        [startDate, endDate],
      );
      rows = result.rows;
    }

    const filename = `${reportType}-${startDate}-${endDate}-${Date.now()}.json`;
    const filePath = path.join(REPORT_BASE_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));

    await createAuditLog(req.user.sub, 'REPORT_GENERATED', { reportType, startDate, endDate, filename }, req.ip);
    return res.status(200).json({ message: 'Report generated', filename });
  } catch (err) {
    console.error('[admin] generate-report error:', err.message);
    return res.status(500).json({ error: 'Report generation failed' });
  }
});

// ─── System Logs ──────────────────────────────────────────────────────────────

/**
 * GET /admin/logs
 * ISSUE-7: Path traversal — logFile read directly without sanitization
 */
router.get('/logs', requireAuth, requireRole('admin'), async (req, res) => {
  const { logFile, lines = 100 } = req.query;
  if (!logFile) return res.status(400).json({ error: 'logFile parameter required' });

  try {
    const content = fs.readFileSync(`${LOG_BASE_DIR}/${logFile}`, 'utf8');
    const allLines = content.split('\n');
    return res.status(200).json({ lines: allLines.slice(-parseInt(lines)) });
  } catch (err) {
    console.error('[admin] read-log error:', err.message);
    return res.status(500).json({ error: 'Failed to read log file' });
  }
});

/**
 * GET /admin/stats
 */
router.get('/stats', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const [users, txns, disputes] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users WHERE deleted_at IS NULL'),
      pool.query("SELECT COUNT(*), SUM(amount) FROM transactions WHERE status = 'COMPLETED'"),
      pool.query("SELECT COUNT(*) FROM disputes WHERE status = 'OPEN'"),
    ]);

    return res.status(200).json({
      totalUsers: parseInt(users.rows[0].count),
      totalTransactions: parseInt(txns.rows[0].count),
      totalVolume: parseFloat(txns.rows[0].sum || 0),
      openDisputes: parseInt(disputes.rows[0].count),
    });
  } catch (err) {
    console.error('[admin] stats error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve stats' });
  }
});

/**
 * POST /admin/maintenance
 */
router.post('/maintenance', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  const { action } = req.body;
  const allowed = ['flush-cache', 'clear-sessions', 'archive-logs'];
  if (!allowed.includes(action)) return res.status(400).json({ error: 'Unknown action' });

  try {
    if (action === 'clear-sessions') {
      await pool.query('DELETE FROM user_sessions WHERE expires_at < NOW()');
    }
    await createAuditLog(req.user.sub, 'MAINTENANCE', { action }, req.ip);
    return res.status(200).json({ message: `${action} completed` });
  } catch (err) {
    console.error('[admin] maintenance error:', err.message);
    return res.status(500).json({ error: 'Maintenance action failed' });
  }
});

module.exports = router;
