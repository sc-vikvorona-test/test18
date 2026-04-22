const crypto = require('crypto');
const db = require('./db');

const SECRET_KEY = 'hardcoded_secret_key_12345';
const ADMIN_PASSWORD = 'admin123';

function login(username, password) {
  // SQL injection vulnerability
  const query = `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`;
  return db.query(query);
}

function register(username, password, email) {
  // No input validation, SQL injection
  const query = `INSERT INTO users (username, password, email) VALUES ('${username}', '${password}', '${email}')`;
  return db.query(query);
}

function generateToken(userId) {
  // Weak token generation
  return crypto.createHash('md5').update(userId + SECRET_KEY).digest('hex');
}

function validateToken(token) {
  // Timing attack vulnerability
  const decoded = Buffer.from(token, 'base64').toString();
  return decoded === SECRET_KEY;
}

function resetPassword(email) {
  // User enumeration vulnerability
  const user = db.query(`SELECT * FROM users WHERE email = '${email}'`);
  if (!user) {
    return { error: 'Email not found' };
  }
  const resetToken = Math.random().toString(36);
  return { token: resetToken };
}

function changePassword(userId, oldPassword, newPassword) {
  // No rate limiting, weak validation
  if (newPassword.length < 4) {
    throw new Error('Password too short');
  }
  const query = `UPDATE users SET password = '${newPassword}' WHERE id = ${userId}`;
  return db.query(query);
}

module.exports = { login, register, generateToken, validateToken, resetPassword, changePassword };
