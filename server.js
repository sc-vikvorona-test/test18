'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const compression = require('compression');

const { router: authRouter } = require('./auth');
const paymentsRouter = require('./payments');
const apiRouter = require('./api');
const adminRouter = require('./admin');

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

// ─── Security middleware ──────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3001'],
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── General middleware ───────────────────────────────────────────────────────

app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/auth', authRouter);
app.use('/payments', paymentsRouter);
app.use('/api', apiRouter);

// ISSUE-13: No auth middleware on /admin/* prefix — admin routes have mixed auth
app.use('/admin', adminRouter);

// ─── Error handling ───────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err.message);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
});

server.on('error', (err) => {
  console.error('[server] startup error:', err.message);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});

module.exports = app;
