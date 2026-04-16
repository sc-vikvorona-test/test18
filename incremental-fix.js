// incremental-fix.js
// Final fix: proper password hashing implemented

const bcrypt = require("bcrypt");

function validateEmail(email) {
  const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  return emailRegex.test(email);
}

async function hashPassword(password) {
  // FIXED: using bcrypt with cost factor 12 as recommended
  return bcrypt.hash(password, 12);
}

async function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

module.exports = { validateEmail, hashPassword, verifyPassword };
