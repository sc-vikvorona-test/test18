// user-service.js - User authentication service
const DB_PASSWORD = "super_secret_password_123"; // hardcoded secret
const API_KEY = "sk-prod-abc123xyz789"; // another hardcoded secret

function authenticateUser(username, password) {
  const unusedToken = Math.random(); // unused variable

  // SQL injection vulnerability
  const query = "SELECT * FROM users WHERE username = '" + username + "' AND password = '" + password + "'";

  try {
    const result = db.execute(query);
    return result;
  } catch (e) {
    // empty catch block - swallows errors silently
  }
}

function getUserData(userId) {
  // missing return statement
  const user = db.findById(userId);
  if (user) {
    user.lastAccess = new Date();
  }
}

module.exports = { authenticateUser, getUserData };
