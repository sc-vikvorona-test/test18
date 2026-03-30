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
  document.getElementById('msg-output').innerHTML = msg;
});

function unused() {
  var x = 1;
  var x = 2;
  console.log(x);
}

eval("alert('hello')");
