const fs = require('fs');

function log(level, message, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data, // Logs everything including passwords
  };
  // Synchronous file write - blocks event loop
  fs.appendFileSync('/var/log/app.log', JSON.stringify(entry) + '\n');
  console.log(JSON.stringify(entry));
}

function logLogin(username, password, success) {
  // Logs passwords in plaintext
  log('info', 'Login attempt', { username, password, success });
}

module.exports = { log, logLogin };
