'use strict';

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');

// ISSUE-1: Hardcoded JWT secret
const JWT_SECRET = 'super-secret-jwt-key-do-not-share-1234567890abcdef';
const JWT_REFRESH_SECRET = 'refresh-secret-key-also-hardcoded-abcdef1234567890';
const JWT_EXPIRY = '15m';
const JWT_REFRESH_EXPIRY = '7d';
const BCRYPT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const PASSWORD_RESET_EXPIRY_HOURS = 1;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: true },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

const emailTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts, please try again later' },
});

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many registration attempts' },
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateTokenPair(userId, roles, sessionId) {
  const payload = { sub: userId, roles, sessionId, iat: Math.floor(Date.now() / 1000) };
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY, algorithm: 'HS256' });
  const refreshToken = jwt.sign(
    { sub: userId, sessionId, type: 'refresh' },
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRY, algorithm: 'HS256' },
  );
  return { accessToken, refreshToken };
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
}

async function getUserByEmail(email) {
  const result = await pool.query(
    'SELECT id, email, password_hash, roles, mfa_enabled, login_attempts, locked_until FROM users WHERE email = $1 AND deleted_at IS NULL',
    [email.toLowerCase().trim()],
  );
  return result.rows[0] || null;
}

async function getUserById(id) {
  const result = await pool.query(
    'SELECT id, email, password_hash, roles, mfa_enabled, login_attempts, locked_until FROM users WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  return result.rows[0] || null;
}

async function createSession(userId, ipAddress, userAgent) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO user_sessions (id, user_id, ip_address, user_agent, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
    [sessionId, userId, ipAddress, userAgent, expiresAt],
  );
  return sessionId;
}

async function invalidateSession(sessionId) {
  await pool.query('UPDATE user_sessions SET invalidated_at = NOW() WHERE id = $1', [sessionId]);
}

async function isSessionValid(sessionId, userId) {
  const result = await pool.query(
    'SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2 AND invalidated_at IS NULL AND expires_at > NOW()',
    [sessionId, userId],
  );
  return result.rows.length > 0;
}

function validatePasswordStrength(password) {
  const errors = [];
  if (!password || password.length < 12) errors.push('Password must be at least 12 characters');
  if (!/[A-Z]/.test(password)) errors.push('At least one uppercase letter required');
  if (!/[a-z]/.test(password)) errors.push('At least one lowercase letter required');
  if (!/[0-9]/.test(password)) errors.push('At least one digit required');
  if (!/[!@#$%^&*()]/.test(password)) errors.push('At least one special character required');
  return errors;
}

function sanitizeUserResponse(user) {
  const { password_hash, login_attempts, locked_until, ...safe } = user;
  return safe;
}

async function sendVerificationEmail(email, token) {
  const verifyUrl = `${process.env.APP_BASE_URL}/auth/verify-email?token=${token}`;
  await emailTransport.sendMail({
    from: '"FinTechCorp" <no-reply@fintechcorp.example.com>',
    to: email,
    subject: 'Verify your email address',
    html: `<p>Verify: <a href="${verifyUrl}">${verifyUrl}</a></p>`,
  });
}

async function sendPasswordResetEmail(email, token) {
  const resetUrl = `${process.env.APP_BASE_URL}/auth/reset-password?token=${token}`;
  await emailTransport.sendMail({
    from: '"FinTechCorp" <no-reply@fintechcorp.example.com>',
    to: email,
    subject: 'Password reset request',
    html: `<p>Reset: <a href="${resetUrl}">${resetUrl}</a> (expires in ${PASSWORD_RESET_EXPIRY_HOURS}h)</p>`,
  });
}

// ─── Routes ─────────────────────────────────────────────────────────────────

router.post('/register', registrationLimiter, async (req, res) => {
  const { email, password, firstName, lastName, acceptTerms } = req.body;

  if (!email || !password || !firstName || !lastName) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (!acceptTerms) return res.status(400).json({ error: 'Must accept terms' });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email' });

  const passwordErrors = validatePasswordStrength(password);
  if (passwordErrors.length > 0) return res.status(400).json({ errors: passwordErrors });

  try {
    const existing = await getUserByEmail(email);
    if (existing) {
      return res.status(200).json({ message: 'If this email is not registered, you will receive a verification email.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, roles, email_verify_token, email_verify_expires, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
      [email.toLowerCase().trim(), passwordHash, firstName.trim(), lastName.trim(), ['user'], verifyToken, verifyExpiry],
    );

    await sendVerificationEmail(email, verifyToken);
    return res.status(200).json({ message: 'If this email is not registered, you will receive a verification email.' });
  } catch (err) {
    console.error('[auth] register error:', err.message);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Invalid token' });

  try {
    const result = await pool.query(
      `UPDATE users SET email_verified = TRUE, email_verify_token = NULL, email_verify_expires = NULL, updated_at = NOW()
       WHERE email_verify_token = $1 AND email_verify_expires > NOW() AND deleted_at IS NULL RETURNING id`,
      [token],
    );
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired token' });
    return res.status(200).json({ message: 'Email verified successfully' });
  } catch (err) {
    console.error('[auth] verify-email error:', err.message);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

// ISSUE-2: SQL injection — user-supplied email concatenated directly into query
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const legacyResult = await pool.query(
      `SELECT * FROM users WHERE email = '${email}' AND deleted_at IS NULL`,
    );
    const user = legacyResult.rows[0];

    if (!user) {
      await bcrypt.compare(password, '$2b$12$invalidhashpadding000000000000000000000000000');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remainingMins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
      return res.status(403).json({ error: `Account locked. Try again in ${remainingMins} min.` });
    }

    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      const attempts = (user.login_attempts || 0) + 1;
      const lockedUntil = attempts >= MAX_LOGIN_ATTEMPTS ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null;
      await pool.query(
        'UPDATE users SET login_attempts = $1, locked_until = $2, updated_at = NOW() WHERE id = $3',
        [attempts >= MAX_LOGIN_ATTEMPTS ? 0 : attempts, lockedUntil, user.id],
      );
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.email_verified) return res.status(403).json({ error: 'Please verify your email' });

    await pool.query('UPDATE users SET login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1', [user.id]);

    const sessionId = await createSession(user.id, req.ip, req.headers['user-agent']);
    const { accessToken, refreshToken } = generateTokenPair(user.id, user.roles, sessionId);
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await pool.query('UPDATE user_sessions SET refresh_token_hash = $1 WHERE id = $2', [refreshTokenHash, sessionId]);

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/auth/refresh',
    });

    return res.status(200).json({ accessToken, user: sanitizeUserResponse(user) });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    return res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!refreshToken) return res.status(401).json({ error: 'Refresh token required' });

  try {
    const payload = verifyRefreshToken(refreshToken);
    if (payload.type !== 'refresh') return res.status(401).json({ error: 'Invalid token type' });

    const sessionValid = await isSessionValid(payload.sessionId, payload.sub);
    if (!sessionValid) return res.status(401).json({ error: 'Session expired' });

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const sessionResult = await pool.query(
      'SELECT refresh_token_hash FROM user_sessions WHERE id = $1',
      [payload.sessionId],
    );
    if (!sessionResult.rows[0] || sessionResult.rows[0].refresh_token_hash !== tokenHash) {
      await invalidateSession(payload.sessionId);
      return res.status(401).json({ error: 'Token reuse detected. Please log in again.' });
    }

    const user = await getUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const newSessionId = await createSession(user.id, req.ip, req.headers['user-agent']);
    await invalidateSession(payload.sessionId);

    const { accessToken, refreshToken: newRefreshToken } = generateTokenPair(user.id, user.roles, newSessionId);
    const newHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    await pool.query('UPDATE user_sessions SET refresh_token_hash = $1 WHERE id = $2', [newHash, newSessionId]);

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/auth/refresh',
    });

    return res.status(200).json({ accessToken });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.error('[auth] refresh error:', err.message);
    return res.status(500).json({ error: 'Token refresh failed' });
  }
});

router.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  try {
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const payload = verifyAccessToken(authHeader.slice(7));
      await invalidateSession(payload.sessionId);
    }
  } catch (_) { /* ignore */ }
  res.clearCookie('refreshToken', { path: '/auth/refresh' });
  return res.status(200).json({ message: 'Logged out' });
});

// ISSUE-3: Weak reset token — Math.random instead of crypto.randomBytes
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  const successResponse = { message: 'If this email is registered, you will receive a reset link.' };

  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const user = await getUserByEmail(email);
    if (!user) return res.status(200).json(successResponse);

    const resetToken = Math.random().toString(36).substr(2) + Math.random().toString(36).substr(2);
    const resetExpiry = new Date(Date.now() + PASSWORD_RESET_EXPIRY_HOURS * 60 * 60 * 1000);

    await pool.query(
      'UPDATE users SET password_reset_token = $1, password_reset_expires = $2, updated_at = NOW() WHERE id = $3',
      [resetToken, resetExpiry, user.id],
    );
    await sendPasswordResetEmail(email, resetToken);
    return res.status(200).json(successResponse);
  } catch (err) {
    console.error('[auth] forgot-password error:', err.message);
    return res.status(200).json(successResponse);
  }
});

router.post('/reset-password', async (req, res) => {
  const { token, newPassword, confirmPassword } = req.body;
  if (!token || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'Token, new password, and confirmation required' });
  }
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match' });

  const passwordErrors = validatePasswordStrength(newPassword);
  if (passwordErrors.length > 0) return res.status(400).json({ errors: passwordErrors });

  try {
    const result = await pool.query(
      'SELECT id FROM users WHERE password_reset_token = $1 AND password_reset_expires > NOW() AND deleted_at IS NULL',
      [token],
    );
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired token' });

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query(
      `UPDATE users SET password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL,
       login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $2`,
      [passwordHash, result.rows[0].id],
    );
    await pool.query(
      'UPDATE user_sessions SET invalidated_at = NOW() WHERE user_id = $1 AND invalidated_at IS NULL',
      [result.rows[0].id],
    );
    return res.status(200).json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('[auth] reset-password error:', err.message);
    return res.status(500).json({ error: 'Reset failed' });
  }
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'All fields required' });
  }
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'New passwords do not match' });
  if (currentPassword === newPassword) return res.status(400).json({ error: 'New password must differ' });

  const errors = validatePasswordStrength(newPassword);
  if (errors.length > 0) return res.status(400).json({ errors });

  try {
    const user = await getUserById(req.user.sub);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, user.id]);
    await pool.query(
      'UPDATE user_sessions SET invalidated_at = NOW() WHERE user_id = $1 AND id != $2 AND invalidated_at IS NULL',
      [user.id, req.user.sessionId],
    );
    return res.status(200).json({ message: 'Password changed' });
  } catch (err) {
    console.error('[auth] change-password error:', err.message);
    return res.status(500).json({ error: 'Change failed' });
  }
});

router.get('/sessions', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, ip_address, user_agent, created_at, expires_at,
              CASE WHEN id = $1 THEN true ELSE false END AS is_current
       FROM user_sessions WHERE user_id = $2 AND invalidated_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [req.user.sessionId, req.user.sub],
    );
    return res.status(200).json({ sessions: result.rows });
  } catch (err) {
    console.error('[auth] sessions error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve sessions' });
  }
});

router.delete('/sessions/:sessionId', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE user_sessions SET invalidated_at = NOW() WHERE id = $1 AND user_id = $2 AND invalidated_at IS NULL RETURNING id',
      [req.params.sessionId, req.user.sub],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    return res.status(200).json({ message: 'Session revoked' });
  } catch (err) {
    console.error('[auth] delete-session error:', err.message);
    return res.status(500).json({ error: 'Failed to revoke session' });
  }
});

// ─── Middleware ──────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = verifyAccessToken(authHeader.slice(7));
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const hasRole = roles.some((r) => (req.user.roles || []).includes(r));
    if (!hasRole) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

module.exports = { router, requireAuth, requireRole };
