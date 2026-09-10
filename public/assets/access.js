const $ = (selector) => document.querySelector(selector);
const steps = ['code', 'email', 'otp', 'devices', 'recover', 'done'];
const message = $('#message');

function csrfToken() {
  const match = document.cookie.split('; ').find((entry) => entry.split('=')[0].endsWith('ae_csrf'));
  return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : '';
}

function setMessage(text = '', success = false) {
  message.textContent = text;
  message.classList.toggle('is-success', success);
}

function showStep(name) {
  for (const step of steps) {
    const element = $(`#step-${step}`);
    if (!element) continue;
    element.hidden = step !== name;
    element.classList.toggle('is-active', step === name);
  }
  setMessage();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function busy(form, active) {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = active;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(options.csrf ? { 'x-csrf-token': csrfToken() } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || 'No se ha podido completar la solicitud.');
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
}

function formatCode(value) {
  const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14);
  if (!clean) return '';
  const prefix = clean.slice(0, 2);
  const groups = clean.slice(2).match(/.{1,4}/g) || [];
  return [prefix, ...groups].join('-');
}

$('#access-code').addEventListener('input', (event) => {
  event.target.value = formatCode(event.target.value);
});

$('#code-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  busy(event.currentTarget, true);
  try {
    await api('/api/access/validate', { body: { code: $('#access-code').value } });
    showStep('email');
    $('#buyer-email').focus();
  } catch (error) {
    setMessage(error.message);
  } finally {
    busy(event.currentTarget, false);
  }
});

$('#email-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  busy(event.currentTarget, true);
  try {
    const result = await api('/api/access/direct', { body: { email: $('#buyer-email').value } });
    return enterAcademy(result.redirect);
  } catch (error) {
    if (error.status === 409 && error.code === 'DEVICE_LIMIT') {
      showStep('devices');
      setMessage(error.message);
      await loadDevices();
    } else {
      setMessage(error.message);
    }
  } finally {
    busy(event.currentTarget, false);
  }
});

async function loadDevices() {
  const response = await fetch('/api/devices', { credentials: 'same-origin' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || 'No se han podido cargar los dispositivos.');
  const list = $('#device-list');
  list.replaceChildren();
  for (const device of body.devices.filter((item) => item.status === 'active')) {
    const item = document.createElement('div');
    item.className = 'device-item';
    const meta = document.createElement('div');
    meta.className = 'device-meta';
    const title = document.createElement('strong');
    title.textContent = device.label;
    const seen = document.createElement('span');
    seen.textContent = `Último uso: ${new Date(device.lastSeenAt).toLocaleString()}`;
    meta.append(title, seen);
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.textContent = 'REEMPLAZAR';
    revoke.addEventListener('click', () => replaceDevice(device.id, revoke));
    item.append(meta, revoke);
    list.append(item);
  }
}

async function replaceDevice(deviceId, button) {
  button.disabled = true;
  try {
    const result = await api('/api/device/revoke', { body: { deviceId }, csrf: true });
    enterAcademy(result.redirect);
  } catch (error) {
    setMessage(error.message);
    button.disabled = false;
  }
}

function enterAcademy(path = '/academy') {
  showStep('done');
  setTimeout(() => window.location.assign(path), 250);
}

$('#lost-code').addEventListener('click', () => showStep('recover'));
$('#cancel-device-change').addEventListener('click', () => showStep('code'));
for (const button of document.querySelectorAll('[data-back="code"]')) {
  button.addEventListener('click', () => showStep('code'));
}

$('#recover-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  busy(event.currentTarget, true);
  try {
    const result = await api('/api/access/recover', { body: { email: $('#recovery-email').value } });
    setMessage(result.message, true);
  } catch (error) {
    setMessage(error.message);
  } finally {
    busy(event.currentTarget, false);
  }
});

fetch('/api/public-config', { credentials: 'same-origin' })
  .then((response) => response.json())
  .then((config) => {
    const link = $('#checkout-link');
    if (config.checkoutUrl) link.href = config.checkoutUrl;
    else {
      link.setAttribute('aria-disabled', 'true');
      link.addEventListener('click', (event) => {
        event.preventDefault();
        setMessage('El checkout todavía no está configurado.');
      });
    }
  })
  .catch(() => setMessage('No se ha podido cargar el enlace de compra.'));
