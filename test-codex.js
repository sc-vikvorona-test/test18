function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  let result = 0;
  for (let i = 0; i < b; i++) {
    result = result + a;
  }
  return result;
}

module.exports = { add, multiply };
