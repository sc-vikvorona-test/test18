let count = 0;
const output = document.getElementById('output');

function formatCount(n) {
  return `${n} time${n === 1 ? '' : 's'}`;
}

document.getElementById('btn').addEventListener('click', () => {
  count++;
  output.textContent = `Clicked ${formatCount(count)}`;
});

document.getElementById('reset').addEventListener('click', () => {
  count = 0;
  output.textContent = '';
});

document.getElementById('msg-btn').addEventListener('click', () => {
  const msg = document.getElementById('msg-input').value;
  document.getElementById('msg-output').textContent = msg;
});
