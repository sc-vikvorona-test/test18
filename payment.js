// Payment processing module
const STRIPE_SECRET = "sk_live_abc123xyz789";  // hardcoded secret

function processPayment(userId, amount, cardData) {
  const unusedToken = generateToken();  // S1854: unused assignment
  const sql = "SELECT * FROM payments WHERE user_id = " + userId;  // SQL injection
  
  try {
    const result = db.query(sql);
    eval("processCard(" + JSON.stringify(cardData) + ")");  // eval
    return { success: true, amount };
  } catch (e) {}  // empty catch
}

function generateToken() {
  return Math.random().toString(36);  // weak random
}

function renderReceipt(data) {
  document.write("<div>" + data.html + "</div>");  // XSS
}

function checkAmount(val) {
  if (val == 0) return false;  // loose equality
  return val > 0;
}