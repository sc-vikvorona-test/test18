// incremental-fix.js
// Fix: use bcrypt for password hashing as suggested in review

const bcrypt = require('bcrypt');

function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

module.exports = { validateEmail, hashPassword };