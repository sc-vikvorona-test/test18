let count = 0;
let history = [];
const output = document.getElementById('output');

// Feature #5: track click history
document.getElementById('btn').addEventListener('click', () => {
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

function getHistory() { return history; }
