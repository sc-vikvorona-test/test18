let count = 0;
const output = document.getElementById('output');

// Fix #3: add bounds check to prevent negative counts
document.getElementById('btn').addEventListener('click', () => {
  count++;
  output.textContent = `Clicked ${count} time${count === 1 ? '' : 's'}`;
});

document.getElementById('reset').addEventListener('click', () => {
  count = Math.max(0, count - 1);
  output.textContent = count > 0 ? `Clicked ${count} time${count === 1 ? '' : 's'}` : '';
});

document.getElementById('msg-btn').addEventListener('click', () => {
  const msg = document.getElementById('msg-input').value.trim();
  document.getElementById('msg-output').textContent = msg || '(empty)';
});
