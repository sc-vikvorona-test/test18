'use strict';

// Shared middleware: request validation, logging, rate limiting, CSRF, etc.

const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: true },
  max: 5,
});

// ─── Request ID ────────────────────────────────────────────────────────────────

function requestId(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
}

// ─── Request logger ────────────────────────────────────────────────────────────

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    console[level](`[http] ${req.method} ${req.path} ${res.statusCode} ${ms}ms rid=${req.id}`);
  });
  next();
}

// ─── Body size guard ───────────────────────────────────────────────────────────

function bodySizeGuard(maxBytes) {
  return (req, res, next) => {
    const contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > maxBytes) {
      return res.status(413).json({ error: 'Request body too large' });
    }
    next();
  };
}

// ─── Content-type guard ────────────────────────────────────────────────────────

function requireJson(req, res, next) {
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
  }
  next();
}

// ─── CSRF token ────────────────────────────────────────────────────────────────

const csrfTokens = new Map(); // token → { userId, expiresAt }

function generateCsrfToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokens.set(token, { userId, expiresAt: Date.now() + 60 * 60 * 1000 });
  // Prune expired tokens periodically
  if (csrfTokens.size > 10000) {
    const now = Date.now();
    for (const [k, v] of csrfTokens) {
      if (v.expiresAt < now) csrfTokens.delete(k);
    }
  }
  return token;
}

function verifyCsrfToken(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const token = req.headers['x-csrf-token'] || req.body?._csrf;
  if (!token) return res.status(403).json({ error: 'CSRF token missing' });

  const entry = csrfTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(403).json({ error: 'CSRF token invalid or expired' });
  }

  if (req.user && entry.userId !== req.user.sub) {
    return res.status(403).json({ error: 'CSRF token user mismatch' });
  }

  csrfTokens.delete(token); // one-time use
  next();
}

// ─── IP allow / block ──────────────────────────────────────────────────────────

const blockedIps = new Set();
const BLOCK_DURATION_MS = 60 * 60 * 1000;
const blockExpiry = new Map();

function ipBlocker(req, res, next) {
  const ip = req.ip;
  if (blockedIps.has(ip)) {
    const expiry = blockExpiry.get(ip) || 0;
    if (Date.now() < expiry) {
      return res.status(429).json({ error: 'IP temporarily blocked' });
    }
    blockedIps.delete(ip);
    blockExpiry.delete(ip);
  }
  next();
}

function blockIp(ip) {
  blockedIps.add(ip);
  blockExpiry.set(ip, Date.now() + BLOCK_DURATION_MS);
}

// ─── Suspicious activity detection ────────────────────────────────────────────

const requestCounts = new Map(); // ip → { count, windowStart }
const RATE_WINDOW_MS = 60 * 1000;
const SOFT_LIMIT = 200;
const HARD_LIMIT = 500;

function anomalyDetector(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = requestCounts.get(ip) || { count: 0, windowStart: now };

  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 1;
    entry.windowStart = now;
  } else {
    entry.count++;
  }
  requestCounts.set(ip, entry);

  if (entry.count > HARD_LIMIT) {
    blockIp(ip);
    return res.status(429).json({ error: 'Too many requests — IP blocked temporarily' });
  }
  if (entry.count > SOFT_LIMIT) {
    res.setHeader('X-RateLimit-Warning', 'Approaching rate limit');
  }
  next();
}

// ─── Maintenance mode ─────────────────────────────────────────────────────────

let maintenanceMode = false;

function setMaintenanceMode(active) {
  maintenanceMode = active;
  console.log(`[middleware] maintenance mode ${active ? 'ENABLED' : 'DISABLED'}`);
}

function maintenanceGuard(req, res, next) {
  if (!maintenanceMode) return next();
  if (req.path.startsWith('/health') || req.path.startsWith('/admin/maintenance')) return next();
  return res.status(503).json({ error: 'Service temporarily unavailable for maintenance. Please try again shortly.' });
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function addResponseHelpers(req, res, next) {
  res.ok = (data) => res.status(200).json(data);
  res.created = (data) => res.status(201).json(data);
  res.noContent = () => res.status(204).send();
  res.badRequest = (msg) => res.status(400).json({ error: msg });
  res.unauthorized = (msg = 'Authentication required') => res.status(401).json({ error: msg });
  res.forbidden = (msg = 'Forbidden') => res.status(403).json({ error: msg });
  res.notFound = (msg = 'Not found') => res.status(404).json({ error: msg });
  res.serverError = (msg = 'Internal server error') => res.status(500).json({ error: msg });
  next();
}

// ─── Database health guard ────────────────────────────────────────────────────

let dbHealthy = true;
const DB_CHECK_INTERVAL_MS = 30000;

async function checkDbHealth() {
  try {
    await pool.query('SELECT 1');
    if (!dbHealthy) {
      console.log('[middleware] DB health restored');
      dbHealthy = true;
    }
  } catch (err) {
    if (dbHealthy) {
      console.error('[middleware] DB health check failed:', err.message);
      dbHealthy = false;
    }
  }
}

setInterval(checkDbHealth, DB_CHECK_INTERVAL_MS).unref();

function dbHealthGuard(req, res, next) {
  if (req.path.startsWith('/health')) return next();
  if (!dbHealthy) {
    return res.status(503).json({ error: 'Database unavailable. Please try again later.' });
  }
  next();
}

// ─── Pagination validator ─────────────────────────────────────────────────────

function validatePagination(req, res, next) {
  const { page, limit } = req.query;
  if (page !== undefined) {
    const p = parseInt(page);
    if (isNaN(p) || p < 1) return res.status(400).json({ error: 'page must be a positive integer' });
  }
  if (limit !== undefined) {
    const l = parseInt(limit);
    if (isNaN(l) || l < 1 || l > 500) return res.status(400).json({ error: 'limit must be between 1 and 500' });
  }
  next();
}

// ─── UUID param validator ─────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuidParam(...params) {
  return (req, res, next) => {
    for (const param of params) {
      const val = req.params[param];
      if (val && !UUID_RE.test(val)) {
        return res.status(400).json({ error: `Invalid ${param} format` });
      }
    }
    next();
  };
}

module.exports = {
  requestId,
  requestLogger,
  bodySizeGuard,
  requireJson,
  generateCsrfToken,
  verifyCsrfToken,
  ipBlocker,
  blockIp,
  anomalyDetector,
  maintenanceGuard,
  setMaintenanceMode,
  addResponseHelpers,
  dbHealthGuard,
  validatePagination,
  validateUuidParam,
};
