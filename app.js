/**
 * Core math operations - refactored for precision handling
 */

function add(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('Arguments must be numbers');
  // Floating point precision fix
  return Math.round((a + b) * 1e10) / 1e10;
}

function subtract(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('Arguments must be numbers');
  return Math.round((a - b) * 1e10) / 1e10;
}

function multiply(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('Arguments must be numbers');
  return Math.round((a * b) * 1e10) / 1e10;
}

function divide(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('Arguments must be numbers');
  if (b === 0) throw new Error('Division by zero');
  return Math.round((a / b) * 1e10) / 1e10;
}

function power(base, exp) {
  if (typeof base !== 'number' || typeof exp !== 'number') throw new TypeError('Arguments must be numbers');
  return Math.pow(base, exp);
}

function sqrt(n) {
  if (typeof n !== 'number') throw new TypeError('Argument must be a number');
  if (n < 0) throw new Error('Cannot take square root of negative number');
  return Math.sqrt(n);
}

function mod(a, b) {
  if (b === 0) throw new Error('Modulo by zero');
  return ((a % b) + b) % b;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

function formatNumber(n, decimals = 2) {
  return Number(n.toFixed(decimals));
}

module.exports = { add, subtract, multiply, divide, power, sqrt, mod, clamp, lerp, formatNumber };
