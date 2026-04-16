'use strict';

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
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

const AVATAR_UPLOAD_DIR = process.env.AVATAR_DIR || '/var/uploads/avatars';
const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Multer config — validates type and size
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATAR_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${req.user.sub}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_AVATAR_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getUserProfile(userId) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.roles, u.created_at,
            p.bio, p.location, p.website, p.avatar_url
     FROM users u
     LEFT JOIN user_profiles p ON p.user_id = u.id
     WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId],
  );
  return result.rows[0] || null;
}

async function ensureProfileExists(userId) {
  await pool.query(
    'INSERT INTO user_profiles (user_id, created_at) VALUES ($1, NOW()) ON CONFLICT (user_id) DO NOTHING',
    [userId],
  );
}

function validateWebsiteUrl(url) {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /users/me
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const profile = await getUserProfile(req.user.sub);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    return res.status(200).json(profile);
  } catch (err) {
    console.error('[users] me error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve profile' });
  }
});

/**
 * PATCH /users/me
 */
router.patch('/me', requireAuth, async (req, res) => {
  const { firstName, lastName, bio, location, website } = req.body;

  if (website && !validateWebsiteUrl(website)) {
    return res.status(400).json({ error: 'Invalid website URL' });
  }
  if (bio && bio.length > 500) {
    return res.status(400).json({ error: 'Bio must be 500 characters or less' });
  }

  try {
    await ensureProfileExists(req.user.sub);

    const userUpdates = [];
    const userParams = [];
    let idx = 1;

    if (firstName !== undefined) { userUpdates.push(`first_name = $${idx++}`); userParams.push(firstName.trim()); }
    if (lastName !== undefined) { userUpdates.push(`last_name = $${idx++}`); userParams.push(lastName.trim()); }

    if (userUpdates.length > 0) {
      userUpdates.push('updated_at = NOW()');
      userParams.push(req.user.sub);
      await pool.query(`UPDATE users SET ${userUpdates.join(', ')} WHERE id = $${idx}`, userParams);
    }

    const profileUpdates = [];
    const profileParams = [];
    let pidx = 1;

    if (bio !== undefined) { profileUpdates.push(`bio = $${pidx++}`); profileParams.push(bio); }
    if (location !== undefined) { profileUpdates.push(`location = $${pidx++}`); profileParams.push(location); }
    if (website !== undefined) { profileUpdates.push(`website = $${pidx++}`); profileParams.push(website); }

    if (profileUpdates.length > 0) {
      profileUpdates.push('updated_at = NOW()');
      profileParams.push(req.user.sub);
      await pool.query(`UPDATE user_profiles SET ${profileUpdates.join(', ')} WHERE user_id = $${pidx}`, profileParams);
    }

    return res.status(200).json({ message: 'Profile updated' });
  } catch (err) {
    console.error('[users] patch-me error:', err.message);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * POST /users/me/avatar
 */
router.post('/me/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const outputFilename = `${req.user.sub}-${Date.now()}-resized.webp`;
    const outputPath = path.join(AVATAR_UPLOAD_DIR, outputFilename);

    await sharp(req.file.path)
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: 85 })
      .toFile(outputPath);

    fs.unlinkSync(req.file.path); // remove original

    const avatarUrl = `/static/avatars/${outputFilename}`;
    await ensureProfileExists(req.user.sub);
    await pool.query(
      'UPDATE user_profiles SET avatar_url = $1, updated_at = NOW() WHERE user_id = $2',
      [avatarUrl, req.user.sub],
    );

    return res.status(200).json({ message: 'Avatar updated', avatarUrl });
  } catch (err) {
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch (_) { /* ignore */ }
    }
    console.error('[users] avatar error:', err.message);
    return res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

/**
 * DELETE /users/me
 */
router.delete('/me', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password confirmation required' });

  try {
    const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.sub]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });

    const bcrypt = require('bcrypt');
    const valid = await bcrypt.compare(password, userResult.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid password' });

    await pool.query('UPDATE users SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1', [req.user.sub]);
    await pool.query(
      'UPDATE user_sessions SET invalidated_at = NOW() WHERE user_id = $1 AND invalidated_at IS NULL',
      [req.user.sub],
    );
    return res.status(200).json({ message: 'Account deleted' });
  } catch (err) {
    console.error('[users] delete-me error:', err.message);
    return res.status(500).json({ error: 'Failed to delete account' });
  }
});

/**
 * GET /users/:id (public profile)
 */
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, p.bio, p.location, p.website, p.avatar_url, u.created_at
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [req.params.id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[users] get-public-profile error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve profile' });
  }
});

/**
 * GET /users/:id/activity
 */
router.get('/:id/activity', async (req, res) => {
  try {
    const user = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id],
    );
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const orders = await pool.query(
      `SELECT id, status, total, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [req.params.id],
    );
    return res.status(200).json({ recentOrders: orders.rows });
  } catch (err) {
    console.error('[users] activity error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve activity' });
  }
});

/**
 * GET /users
 * ISSUE-14: Insecure direct object reference — lists all users with private fields, no admin check
 */
router.get('/', async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, roles, email_verified, login_attempts, locked_until, created_at
       FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [parseInt(limit), offset],
    );
    return res.status(200).json({ users: result.rows });
  } catch (err) {
    console.error('[users] list error:', err.message);
    return res.status(500).json({ error: 'Failed to list users' });
  }
});

module.exports = router;
