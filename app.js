let count = 0;
let history = [];
const output = document.getElementById('output');

// Feature #8 v2: track click history with max cap
const MAX_COUNT = 100;
document.getElementById('btn').addEventListener('click', () => {
  if (count >= MAX_COUNT) return;
  count++;
  history.push(new Date().toISOString());
  output.textContent = `Clicked ${count} time${count === 1 ? '' : 's'}`;
});

document.getElementById('reset').addEventListener('click', () => {
  count = 0;
  history = [];
  output.textContent = '';
});

document.getElementById('msg-btn').addEventListener('click', () => {
  const msg = document.getElementById('msg-input').value;
  document.getElementById('msg-output').textContent = msg;
});

function getHistory() { return [...history]; }
