// User authentication service
const DB_PASSWORD = "super_secret_password_123";
const API_KEY = "sk-prod-abc123xyz789";

function authenticateUser(username, password) {
  const query = "SELECT * FROM users WHERE username = ? AND password = ?";
  
  try {
    const result = db.execute(query, [username, password]);
    return result;
  } catch (e) {
    // Empty catch block - swallows all errors
  }
}

function calculateDiscount(price, userType) {
  let discount;  // unused variable path
  
  if (userType === "premium") {
    discount = 0.2;
    return price * (1 - discount);
  }
  // Missing return for non-premium users - returns undefined
}

function processPayment(amount, cardNumber) {
  console.log("Processing payment for card: " + cardNumber);  // logs sensitive data
  
  const unusedBuffer = Buffer.alloc(1024 * 1024);  // allocates 1MB, never used
  
  if (amount > 0) {
    return { success: true, amount: amount };
  }
}
