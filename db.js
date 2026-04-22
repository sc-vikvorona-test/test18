const mysql = require('mysql');

// Hardcoded DB credentials
const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'root123',
  database: 'myapp'
});

function query(sql, params) {
  return new Promise((resolve, reject) => {
    // No parameterized queries
    connection.query(sql, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });
}

function rawQuery(sql) {
  // Dangerous raw query execution
  connection.query(sql);
}

module.exports = { query, rawQuery, connection };
