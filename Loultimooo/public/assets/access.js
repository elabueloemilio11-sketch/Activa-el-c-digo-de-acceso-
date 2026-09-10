const $ = (selector) => document.querySelector(selector);
const message = $('#message');

function setMessage(text = '', success = false) {
  if (!message) return;
  message.textContent = text;
  message.classList.toggle('is-success', success);
}

function busy(form, active) {
  const button = form?.querySelector('button[type="submit"]');
  if (button) button.disabled = active;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body || {})
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.message || 'No se ha podido completar la solicitud.'
    );
    error.status = response.status;
    error.code = data.code;
    throw error;
  }

  return data;
}

function formatCode(value) {
  const clean = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 14);

  if (!clean) return '';

  const prefix = clean.slice(0, 2);
  const groups = clean.slice(2).match(/.{1,4}/g) || [];

  return [prefix, ...groups].join('-');
}

const accessCode = $('#access-code');

if (accessCode) {
  accessCode.addEventListener('input', (event) => {
    event.target.value = formatCode(event.target.value);
  });
}

const codeForm = $('#code-form');

if (codeForm) {
  codeForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    busy(event.currentTarget, true);
    setMessage('');

    try {
      const result = await api('/api/access/validate', {
        code: $('#access-code').value
      });

      setMessage('Acceso correcto. Entrando en la Academy…', true);

      window.location.assign(result.redirect || '/academy');
    } catch (error) {
      setMessage(error.message);
      busy(event.currentTarget, false);
    }
  });
}

fetch('/api/public-config', {
  credentials: 'same-origin'
})
  .then((response) => response.json())
  .then((config) => {
    const link = $('#checkout-link');
    if (!link) return;

    if (config.checkoutUrl) {
      link.href = config.checkoutUrl;
    } else {
      link.setAttribute('aria-disabled', 'true');
      link.addEventListener('click', (event) => {
        event.preventDefault();
        setMessage('El checkout todavía no está configurado.');
      });
    }
  })
  .catch(() => {});
