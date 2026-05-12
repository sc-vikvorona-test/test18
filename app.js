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

// Debounce utility: delay function execution until after wait ms of inactivity
function debounce(fn, wait) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

const msgInput = document.getElementById('msg-input');
const msgOutput = document.getElementById('msg-output');

msgInput.addEventListener('input', debounce((e) => {
  msgOutput.textContent = e.target.value;
}, 300));
