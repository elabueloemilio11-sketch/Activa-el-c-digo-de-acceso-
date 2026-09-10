const $ = (selector) => document.querySelector(selector);
const steps = ['code', 'email', 'otp', 'devices', 'recover', 'done'];
const message = $('#message');

function setMessage(text = '', success = false) {
  if (!message) return;
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
  const button = form?.querySelector('button[type="submit"]');
  if (button) button.disabled = active;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || 'No se ha podido completar la solicitud.');
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function formatCode(value) {
  const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14);
  if (!clean) return '';
  const prefix = clean.slice(0, 2);
  const groups = clean.slice(2).match(/.{1,4}/g) || [];
  return [prefix, ...groups].join('-');
}

function enterAcademy(path = '/academy') {
  showStep('done');
  setTimeout(() => window.location.assign(path), 350);
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
    try {
      await api('/api/access/validate', { code: $('#access-code').value });
      showStep('email');
      $('#buyer-email')?.focus();
    } catch (error) {
      setMessage(error.message);
    } finally {
      busy(event.currentTarget, false);
    }
  });
}

const emailForm = $('#email-form');
if (emailForm) {
  emailForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(event.currentTarget, true);
    try {
      const result = await api('/api/access/verify-email', {
        email: $('#buyer-email').value
      });
      enterAcademy(result.redirect || '/academy');
    } catch (error) {
      setMessage(error.message);
    } finally {
      busy(event.currentTarget, false);
    }
  });
}

// The old 6-digit verification step is no longer used.
const otpStep = $('#step-otp');
if (otpStep) otpStep.hidden = true;

const lostCode = $('#lost-code');
if (lostCode) {
  lostCode.addEventListener('click', () => {
    setMessage('Si has perdido tu código de acceso, contacta con soporte.');
  });
}

const cancelDeviceChange = $('#cancel-device-change');
if (cancelDeviceChange) {
  cancelDeviceChange.addEventListener('click', () => showStep('code'));
}

for (const button of document.querySelectorAll('[data-back="code"]')) {
  button.addEventListener('click', () => showStep('code'));
}

fetch('/api/public-config', { credentials: 'same-origin' })
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
