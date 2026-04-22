// Refactor #9 AMENDED: simpler approach after review feedback
class Counter {
  #value = 0;

  increment() { return ++this.#value; }
  reset() { this.#value = 0; }
  get value() { return this.#value; }
}

const counter = new Counter();
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
