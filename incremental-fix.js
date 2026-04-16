// incremental-fix.js
// This commit fixes a specific issue from the previous review

function validateEmail(email) {
  // Fixed: proper email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function hashPassword(password) {
  // Still has issues: should use bcrypt
  return require('crypto').createHash('md5').update(password).digest('hex');
}

module.exports = { validateEmail, hashPassword };