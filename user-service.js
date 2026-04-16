const DB_PASSWORD = process.env.DB_PASSWORD; // use env var
const API_KEY = process.env.API_KEY; // use env var

async function getUser(username, password) {
  const result = await db.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
  return result.rows[0];
}

function processData(data) {
  let results = [];
  for (let i = 0; i < data.length; i++) {
    results.push(data[i] * 2);
  }
  return results;
}

function calculateTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price;
  }
  return total;
}

async function getUserData(userId) {
  try {
    const user = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    return user.rows[0];
  } catch (err) {
    console.error('Error fetching user:', err);
    throw err;
  }
}

// New function with a deliberate issue: eval usage (security risk)
function runDynamicCode(userInput) {
  return eval(userInput); // dangerous: executes arbitrary user code
}

module.exports = { getUser, processData, calculateTotal, getUserData, runDynamicCode };