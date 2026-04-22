const sessions = {};

function createSession(userId, userData) {
  // Predictable session ID
  const sessionId = `session_${userId}_${Date.now()}`;
  sessions[sessionId] = {
    userId,
    userData,
    createdAt: Date.now(),
    // No expiry
  };
  return sessionId;
}

function getSession(sessionId) {
  return sessions[sessionId]; // No expiry check
}

function destroySession(sessionId) {
  delete sessions[sessionId];
}

// Session stored in memory - lost on restart
// No CSRF protection
// Sessions never expire

module.exports = { createSession, getSession, destroySession, sessions };
