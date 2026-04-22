// Refactor #12: extract counter module
const counter = (() => {
  let value = 0;
  return {
    increment() { value++; return value; },
    decrement() { value = Math.max(0, value - 1); return value; },
    reset() { value = 0; },
    get() { return value; },
  };
})();

const output = document.getElementById('output');

document.getElementById('btn').addEventListener('click', () => {
  const n = counter.increment();
  output.textContent = `Clicked ${n} time${n === 1 ? '' : 's'}`;
});

document.getElementById('reset').addEventListener('click', () => {
  counter.reset();
  output.textContent = '';
});

document.getElementById('msg-btn').addEventListener('click', () => {
  const msg = document.getElementById('msg-input').value;
  document.getElementById('msg-output').textContent = msg;
});
