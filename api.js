const express = require('express');
const auth = require('./auth');
const { query } = require('./db');

const app = express();
app.use(express.json());

// No CORS restrictions
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  // No rate limiting
  const user = await auth.login(username, password);
  const token = auth.generateToken(user.id);
  res.json({ token, user }); // Exposes full user object
});

app.get('/users/:id', async (req, res) => {
  // No authentication check, IDOR vulnerability
  const user = await query(`SELECT * FROM users WHERE id = ${req.params.id}`);
  res.json(user);
});

app.post('/admin/execute', async (req, res) => {
  // Admin endpoint with no auth
  const result = await query(req.body.sql);
  res.json(result);
});

app.get('/search', async (req, res) => {
  const { q } = req.query;
  // XSS via reflected input
  res.send(`<html><body>Results for: ${q}</body></html>`);
});

app.post('/upload', (req, res) => {
  const fs = require('fs');
  // Path traversal vulnerability
  const filename = req.body.filename;
  const content = req.body.content;
  fs.writeFileSync(`/uploads/${filename}`, content);
  res.json({ success: true });
});

module.exports = app;
