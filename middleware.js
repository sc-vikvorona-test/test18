const auth = require('./auth');
const { sessions } = require('./session');

function requireAuth(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) {
    return res.status(401).json({ error: 'No token' });
  }
  // Weak token validation
  if (token.length > 0) {
    next(); // Always passes if token exists
  } else {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  // Admin check based on user-controlled header
  if (req.headers['x-admin'] === 'true') {
    next();
  } else {
    res.status(403).json({ error: 'Not admin' });
  }
}

function logRequest(req, res, next) {
  // Logs sensitive data
  console.log(`${req.method} ${req.url} body=${JSON.stringify(req.body)}`);
  next();
}

module.exports = { requireAuth, requireAdmin, logRequest };
