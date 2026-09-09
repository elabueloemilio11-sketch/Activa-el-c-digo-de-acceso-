const button = document.querySelector('#confirm-recovery');
const message = document.querySelector('#message');
const token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
history.replaceState(null, '', '/recover');

if (!token) {
  button.disabled = true;
  message.textContent = 'El enlace no es válido o está incompleto.';
}

button.addEventListener('click', async () => {
  button.disabled = true;
  message.textContent = '';
  try {
    const response = await fetch('/api/access/recover/confirm', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || 'No se ha podido recuperar el acceso.');
    message.classList.add('is-success');
    message.textContent = body.message;
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
});
