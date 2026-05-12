let count = 0;
const output = document.getElementById('output');

document.getElementById('btn').addEventListener('click', () => {
  count++;
  output.textContent = `Clicked ${count} time${count === 1 ? '' : 's'}`;
});

document.getElementById('reset').addEventListener('click', () => {
  count = 0;
  output.textContent = '';
});

document.getElementById('msg-btn').addEventListener('click', () => {
  const msg = document.getElementById('msg-input').value;
  document.getElementById('msg-output').textContent = msg;
});

// New feature: persist click count to localStorage so it survives page reloads
function loadCount() {
  const saved = localStorage.getItem('clickCount');
  if (saved !== null) {
    count = parseInt(saved, 10);
    output.textContent = count > 0 ? `Clicked ${count} time${count === 1 ? '' : 's'}` : '';
  }
}

document.getElementById('btn').addEventListener('click', () => {
  localStorage.setItem('clickCount', count);
});

document.getElementById('reset').addEventListener('click', () => {
  localStorage.removeItem('clickCount');
});

loadCount();
