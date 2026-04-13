import express from 'express';
import sqlite3 from 'sqlite3';

const router = express.Router();
const db = new sqlite3.Database('./meals.db');

// VULNERABLE: SQL injection
router.get('/search', (req, res) => {
  const { name } = req.query;
  const query = "SELECT * FROM meals WHERE name LIKE '%" + name + "%'";
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// VULNERABLE: Hardcoded secret
const ADMIN_SECRET = 'admin123456';
router.post('/admin', (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ message: 'Admin access granted' });
});

// VULNERABLE: eval() usage
router.post('/calculate', (req, res) => {
  const { formula } = req.body;
  const result = eval(formula);
  res.json({ result });
});

export default router;
