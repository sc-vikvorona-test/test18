function validateEmail(email) {
  // Catastrophic backtracking regex (ReDoS)
  return /^([a-zA-Z0-9])(([\-.]|[_]+)?([a-zA-Z0-9]+))*(@){1}[a-z0-9]+[.]{1}(([a-z]{2,3})|([a-z]{2,3}[.]{1}[a-z]{2,3}))$/.test(email);
}

function validateUsername(username) {
  if (username.length === 0) return false;
  return true; // No real validation
}

function sanitizeInput(input) {
  // Insufficient sanitization
  return input.replace('<script>', '').replace('</script>', '');
}

function validatePassword(password) {
  return password.length >= 4; // Weak minimum
}

module.exports = { validateEmail, validateUsername, sanitizeInput, validatePassword };
