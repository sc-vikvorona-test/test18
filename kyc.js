'use strict';

// KYC (Know Your Customer) service
// Handles identity verification documents, status tracking, and compliance checks.

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
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

const KYC_UPLOAD_DIR = process.env.KYC_DOC_DIR || '/var/uploads/kyc';
const KYC_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const KYC_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const KYC_PROVIDER_URL = process.env.KYC_PROVIDER_URL;
const KYC_PROVIDER_KEY = process.env.KYC_PROVIDER_KEY;

const KYC_STATUSES = ['NOT_STARTED', 'PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED'];
const DOC_TYPES = ['PASSPORT', 'DRIVERS_LICENSE', 'NATIONAL_ID', 'UTILITY_BILL', 'BANK_STATEMENT'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, KYC_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safe = `${req.user.sub}-${Date.now()}-${Math.random().toString(36).substr(2, 8)}${ext}`;
      cb(null, safe);
    },
  }),
  limits: { fileSize: KYC_MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (KYC_ALLOWED_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Only JPEG, PNG, and PDF allowed.'));
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getKycProfile(userId) {
  const result = await pool.query(
    `SELECT id, user_id, status, level, submitted_at, reviewed_at, rejection_reason, expires_at
     FROM kyc_profiles WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] || null;
}

async function ensureKycProfile(userId) {
  await pool.query(
    `INSERT INTO kyc_profiles (user_id, status, level, created_at)
     VALUES ($1, 'NOT_STARTED', 0, NOW())
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
}

async function getDocuments(userId) {
  const result = await pool.query(
    `SELECT id, doc_type, status, uploaded_at, reviewed_at FROM kyc_documents WHERE user_id = $1 ORDER BY uploaded_at DESC`,
    [userId],
  );
  return result.rows;
}

async function submitToKycProvider(userId, docPaths) {
  const response = await axios.post(
    `${KYC_PROVIDER_URL}/verify`,
    { userId, documents: docPaths },
    {
      headers: { 'Authorization': `Bearer ${KYC_PROVIDER_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    },
  );
  return response.data;
}

async function createAuditLog(userId, action, details, ipAddress) {
  await pool.query(
    'INSERT INTO audit_logs (user_id, action, details, ip_address, created_at) VALUES ($1, $2, $3, $4, NOW())',
    [userId, action, JSON.stringify(details), ipAddress],
  );
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /kyc/status
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    await ensureKycProfile(req.user.sub);
    const profile = await getKycProfile(req.user.sub);
    const docs = await getDocuments(req.user.sub);
    return res.status(200).json({ ...profile, documents: docs });
  } catch (err) {
    console.error('[kyc] status error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve KYC status' });
  }
});

/**
 * POST /kyc/documents
 */
router.post('/documents', requireAuth, upload.single('document'), async (req, res) => {
  const { docType } = req.body;

  if (!req.file) return res.status(400).json({ error: 'Document file required' });
  if (!docType || !DOC_TYPES.includes(docType)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Invalid document type', allowed: DOC_TYPES });
  }

  try {
    await ensureKycProfile(req.user.sub);

    const docResult = await pool.query(
      `INSERT INTO kyc_documents (user_id, doc_type, file_path, status, uploaded_at)
       VALUES ($1, $2, $3, 'PENDING', NOW()) RETURNING id`,
      [req.user.sub, docType, req.file.path],
    );

    await pool.query(
      `UPDATE kyc_profiles SET status = 'PENDING', submitted_at = NOW() WHERE user_id = $1 AND status IN ('NOT_STARTED', 'REJECTED')`,
      [req.user.sub],
    );

    await createAuditLog(req.user.sub, 'KYC_DOCUMENT_UPLOADED', { docType, docId: docResult.rows[0].id }, req.ip);
    return res.status(201).json({ message: 'Document uploaded', docId: docResult.rows[0].id });
  } catch (err) {
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch (_) { /* ignore */ }
    }
    console.error('[kyc] upload error:', err.message);
    return res.status(500).json({ error: 'Failed to upload document' });
  }
});

/**
 * DELETE /kyc/documents/:id
 */
router.delete('/documents/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, file_path, status FROM kyc_documents WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.sub],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Document not found' });

    const doc = result.rows[0];
    if (doc.status !== 'PENDING') {
      return res.status(400).json({ error: 'Can only delete pending documents' });
    }

    await pool.query('DELETE FROM kyc_documents WHERE id = $1', [doc.id]);
    try { fs.unlinkSync(doc.file_path); } catch (_) { /* file may already be gone */ }

    return res.status(200).json({ message: 'Document deleted' });
  } catch (err) {
    console.error('[kyc] delete-doc error:', err.message);
    return res.status(500).json({ error: 'Failed to delete document' });
  }
});

/**
 * POST /kyc/submit
 */
router.post('/submit', requireAuth, async (req, res) => {
  try {
    const profile = await getKycProfile(req.user.sub);
    if (!profile) return res.status(400).json({ error: 'No KYC profile found. Upload documents first.' });

    if (profile.status === 'APPROVED') return res.status(400).json({ error: 'KYC already approved' });
    if (profile.status === 'UNDER_REVIEW') return res.status(400).json({ error: 'KYC already under review' });

    const docs = await getDocuments(req.user.sub);
    const pendingDocs = docs.filter((d) => d.status === 'PENDING');
    if (pendingDocs.length === 0) {
      return res.status(400).json({ error: 'No pending documents to submit' });
    }

    const docPaths = pendingDocs.map((d) => d.id);
    const providerResponse = await submitToKycProvider(req.user.sub, docPaths);

    await pool.query(
      `UPDATE kyc_profiles SET status = 'UNDER_REVIEW', submitted_at = NOW() WHERE user_id = $1`,
      [req.user.sub],
    );

    await createAuditLog(req.user.sub, 'KYC_SUBMITTED', { docCount: pendingDocs.length, ref: providerResponse.ref }, req.ip);
    return res.status(200).json({ message: 'KYC submitted for review', ref: providerResponse.ref });
  } catch (err) {
    console.error('[kyc] submit error:', err.message);
    return res.status(500).json({ error: 'Failed to submit KYC' });
  }
});

// ─── Admin KYC Routes ─────────────────────────────────────────────────────────

/**
 * GET /kyc/admin/pending
 */
router.get('/admin/pending', requireAuth, requireRole('admin', 'compliance'), async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const result = await pool.query(
      `SELECT k.id, k.user_id, u.email, k.status, k.submitted_at, k.level
       FROM kyc_profiles k JOIN users u ON u.id = k.user_id
       WHERE k.status = 'UNDER_REVIEW' ORDER BY k.submitted_at ASC LIMIT $1 OFFSET $2`,
      [parseInt(limit), offset],
    );
    return res.status(200).json({ profiles: result.rows });
  } catch (err) {
    console.error('[kyc] admin-pending error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve pending KYC' });
  }
});

/**
 * POST /kyc/admin/review/:userId
 */
router.post('/admin/review/:userId', requireAuth, requireRole('admin', 'compliance'), async (req, res) => {
  const { decision, reason, level } = req.body;

  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be APPROVED or REJECTED' });
  }
  if (decision === 'REJECTED' && !reason) {
    return res.status(400).json({ error: 'Rejection reason required' });
  }

  try {
    const profile = await getKycProfile(req.params.userId);
    if (!profile) return res.status(404).json({ error: 'KYC profile not found' });
    if (profile.status !== 'UNDER_REVIEW') {
      return res.status(400).json({ error: `Cannot review profile with status ${profile.status}` });
    }

    const expiresAt = decision === 'APPROVED' ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) : null;

    await pool.query(
      `UPDATE kyc_profiles SET status = $1, rejection_reason = $2, reviewed_at = NOW(), expires_at = $3, level = COALESCE($4, level)
       WHERE user_id = $5`,
      [decision, reason || null, expiresAt, level || null, req.params.userId],
    );

    // Update document statuses
    await pool.query(
      `UPDATE kyc_documents SET status = $1, reviewed_at = NOW() WHERE user_id = $2 AND status = 'PENDING'`,
      [decision === 'APPROVED' ? 'APPROVED' : 'REJECTED', req.params.userId],
    );

    await createAuditLog(
      req.user.sub,
      'KYC_REVIEWED',
      { targetUser: req.params.userId, decision, reason },
      req.ip,
    );

    return res.status(200).json({ message: `KYC ${decision.toLowerCase()}` });
  } catch (err) {
    console.error('[kyc] admin-review error:', err.message);
    return res.status(500).json({ error: 'Failed to process review decision' });
  }
});

/**
 * GET /kyc/admin/stats
 */
router.get('/admin/stats', requireAuth, requireRole('admin', 'compliance'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
        COUNT(*) FILTER (WHERE status = 'UNDER_REVIEW') AS under_review,
        COUNT(*) FILTER (WHERE status = 'APPROVED') AS approved,
        COUNT(*) FILTER (WHERE status = 'REJECTED') AS rejected,
        COUNT(*) FILTER (WHERE status = 'EXPIRED') AS expired
      FROM kyc_profiles
    `);
    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[kyc] admin-stats error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve stats' });
  }
});

/**
 * POST /kyc/webhook
 * ISSUE-15: No signature verification on the KYC provider webhook
 */
router.post('/webhook', async (req, res) => {
  const { userId, status, ref, level } = req.body;

  if (!userId || !status) {
    return res.status(400).json({ error: 'userId and status required' });
  }

  try {
    const validStatuses = ['APPROVED', 'REJECTED', 'UNDER_REVIEW'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const expiresAt = status === 'APPROVED' ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) : null;

    await pool.query(
      `UPDATE kyc_profiles SET status = $1, reviewed_at = NOW(), expires_at = $2, level = COALESCE($3, level)
       WHERE user_id = $4`,
      [status, expiresAt, level || null, userId],
    );

    if (status === 'APPROVED') {
      await pool.query(
        `UPDATE kyc_documents SET status = 'APPROVED', reviewed_at = NOW() WHERE user_id = $1 AND status = 'PENDING'`,
        [userId],
      );
    } else if (status === 'REJECTED') {
      await pool.query(
        `UPDATE kyc_documents SET status = 'REJECTED', reviewed_at = NOW() WHERE user_id = $1 AND status = 'PENDING'`,
        [userId],
      );
    }

    console.log(`[kyc] webhook processed: userId=${userId} status=${status} ref=${ref}`);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[kyc] webhook error:', err.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
