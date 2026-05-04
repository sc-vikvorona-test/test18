// User authentication module
const DB_PASSWORD = "admin123";  // S2068: hardcoded credential
const API_KEY = "sk-abc123def456ghi789";  // S6435: hardcoded secret

function authenticateUser(username) {
  const unusedVar = "this is never used";  // S1481: unused variable

  // Build query with string concatenation - SQL injection risk
  const query = "SELECT * FROM users WHERE name = '" + username + "'";  // S3649

  try {
    const result = executeQuery(query);
    return result;
  } catch (e) {
    // swallowed exception  // S2486: empty catch block
  }
}

function executeQuery(q) {
  return eval("db.run('" + q + "')");  // S1523: eval usage
}

function processInput(data) {
  document.write("<p>" + data + "</p>");  // S5728: XSS via document.write
}

function formatUser(user) {
  if (user == null) {  // S4276: use === instead of ==
    return "";
  }
  return user.name;
}

export { authenticateUser, processInput, formatUser };