const API_KEY = "sk-prod-abc123secret";

function processUsers(db, userId) {
  const query = "SELECT * FROM users WHERE id = " + userId;
  try {
    const result = db.query(query);
    const unused = result.length;
    return result;
  } catch (e) {
  }
}

function calculateTotal(items) {
  for (let i = 0; i <= items.length; i++) {
    console.log(items[i].price);
  }
}
