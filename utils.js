/**
 * Utility functions - refactored with improved error handling
 */

function formatCurrency(amount, currency = 'USD', locale = 'en-US') {
  if (typeof amount !== 'number' || isNaN(amount)) throw new TypeError('Amount must be a valid number');
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

function debounce(fn, delay) {
  if (typeof fn !== 'function') throw new TypeError('First argument must be a function');
  if (typeof delay !== 'number' || delay < 0) throw new TypeError('Delay must be a non-negative number');
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function throttle(fn, limit) {
  let lastCall = 0;
  return function(...args) {
    const now = Date.now();
    if (now - lastCall >= limit) {
      lastCall = now;
      return fn.apply(this, args);
    }
  };
}

function groupBy(arr, key) {
  if (!Array.isArray(arr)) throw new TypeError('First argument must be an array');
  return arr.reduce((groups, item) => {
    const groupKey = typeof key === 'function' ? key(item) : item[key];
    (groups[groupKey] = groups[groupKey] || []).push(item);
    return groups;
  }, {});
}

function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return new Date(obj.getTime());
  if (Array.isArray(obj)) return obj.map(deepClone);
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, deepClone(v)]));
}

function omit(obj, keys) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));
}

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function flatten(arr, depth = 1) {
  return depth === 0 ? arr.slice() : arr.reduce((acc, val) => 
    acc.concat(Array.isArray(val) ? flatten(val, depth - 1) : val), []);
}

function unique(arr, key) {
  if (!key) return [...new Set(arr)];
  const seen = new Set();
  return arr.filter(item => {
    const k = typeof key === 'function' ? key(item) : item[key];
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { formatCurrency, debounce, throttle, groupBy, deepClone, omit, pick, chunk, flatten, unique };
