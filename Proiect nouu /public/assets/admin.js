const $ = (selector) => document.querySelector(selector);
let selectedAccessId = null;

function csrfToken() {
  const match = document.cookie.split('; ').find((entry) => entry.split('=')[0].endsWith('ae_csrf'));
  return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : '';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json', 'x-csrf-token': csrfToken() } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || 'Error de administración.');
  return body;
}

function adminMessage(text = '', success = false) {
  const element = $('#admin-message');
  element.textContent = text;
  element.classList.toggle('is-success', success);
}

function showPanel(authenticated) {
  $('#admin-login').hidden = authenticated;
  $('#admin-panel').hidden = !authenticated;
  $('#admin-logout').hidden = !authenticated;
}

function badge(status, suspicious = false) {
  const span = document.createElement('span');
  span.className = `badge ${suspicious ? 'suspicious' : status}`;
  span.textContent = suspicious ? 'SUSPICIOUS' : String(status).toUpperCase();
  return span;
}

async function loadAccesses(query = '') {
  const body = await api(`/api/admin/accesses?q=${encodeURIComponent(query)}`);
  const table = $('#access-table');
  table.replaceChildren();
  for (const access of body.accesses) {
    const row = document.createElement('tr');
    const email = document.createElement('td');
    email.textContent = access.customer_email;
    const order = document.createElement('td');
    order.textContent = access.order_name || access.order_id;
    const status = document.createElement('td');
    status.append(badge(access.status, access.suspicious));
    const devices = document.createElement('td');
    devices.textContent = `${access.active_devices}/${access.max_devices}`;
    const risk = document.createElement('td');
    risk.textContent = String(access.risk_score);
    row.append(email, order, status, devices, risk);
    row.addEventListener('click', () => loadDetail(access.id));
    table.append(row);
  }
  if (!body.accesses.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = 'No hay resultados.';
    cell.className = 'muted';
    row.append(cell);
    table.append(row);
  }
}

function metric(label, value) {
  const item = document.createElement('div');
  item.className = 'metric';
  const small = document.createElement('small');
  small.textContent = label;
  const strong = document.createElement('strong');
  strong.textContent = value ?? '—';
  item.append(small, strong);
  return item;
}

function actionButton(label, action, danger = false, extra = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = danger ? 'danger-button' : 'secondary';
  button.textContent = label;
  button.addEventListener('click', () => runAction(action, extra, button));
  return button;
}

async function loadDetail(id) {
  selectedAccessId = id;
  const body = await api(`/api/admin/access/${id}`);
  const { access, devices, sessions, events } = body;
  const panel = $('#access-detail');
  panel.replaceChildren();
  const eyebrow = document.createElement('div');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = access.suspicious ? 'REVISIÓN NECESARIA' : 'DETALLE DE LICENCIA';
  const title = document.createElement('h2');
  title.textContent = access.customer_email;
  const sub = document.createElement('p');
  sub.className = 'muted small';
  sub.textContent = `${access.order_name || access.order_id} · código terminado en ${access.access_code_last4}`;
  const grid = document.createElement('div');
  grid.className = 'detail-grid';
  grid.append(
    metric('Estado', access.status),
    metric('Riesgo', `${access.risk_score}/100`),
    metric('Activaciones', access.activation_count),
    metric('Límite', access.max_devices)
  );
  panel.append(eyebrow, title, sub, grid);

  const deviceTitle = document.createElement('div');
  deviceTitle.className = 'section-title';
  deviceTitle.textContent = 'Dispositivos';
  panel.append(deviceTitle);
  const activeDevices = devices.filter((device) => device.status === 'active');
  for (const device of activeDevices) {
    const item = document.createElement('div');
    item.className = 'device-item';
    const meta = document.createElement('div');
    meta.className = 'device-meta';
    const name = document.createElement('strong');
    name.textContent = device.label;
    const seen = document.createElement('span');
    seen.textContent = new Date(device.last_seen_at).toLocaleString();
    meta.append(name, seen);
    item.append(meta, actionButton('REVOCAR', 'revoke_device', true, { deviceId: device.id }));
    panel.append(item);
  }
  if (!activeDevices.length) {
    const none = document.createElement('p');
    none.className = 'muted small';
    none.textContent = 'No hay dispositivos activos.';
    panel.append(none);
  }

  const eventTitle = document.createElement('div');
  eventTitle.className = 'section-title';
  eventTitle.textContent = `Actividad · ${sessions.filter((item) => !item.revoked_at).length} sesiones activas`;
  panel.append(eventTitle);
  for (const event of events.slice(0, 6)) {
    const line = document.createElement('p');
    line.className = 'muted small';
    line.textContent = `${new Date(event.created_at).toLocaleString()} · ${event.event_type} (+${event.risk_points})`;
    panel.append(line);
  }

  const actions = document.createElement('div');
  actions.className = 'action-grid';
  actions.append(
    actionButton('REVOCAR TODOS LOS DISPOSITIVOS', 'revoke_all_devices', true),
    actionButton(access.status === 'disabled' ? 'REACTIVAR ACCESO' : 'DESACTIVAR ACCESO', access.status === 'disabled' ? 'reactivate_access' : 'disable_access', access.status !== 'disabled'),
    actionButton(access.suspicious ? 'LIMPIAR ALERTA SUSPICIOUS' : 'MARCAR COMO SUSPICIOUS', access.suspicious ? 'clear_suspicious' : 'mark_suspicious'),
    actionButton('RESTABLECER LÍMITE A 2', 'set_device_limit', false, { maxDevices: 2 })
  );
  panel.append(actions);
}

async function runAction(action, extra, button) {
  if (!selectedAccessId) return;
  button.disabled = true;
  try {
    await api(`/api/admin/access/${selectedAccessId}/action`, { method: 'POST', body: { action, ...extra } });
    adminMessage('Acción aplicada.', true);
    await Promise.all([loadDetail(selectedAccessId), loadAccesses($('#admin-search').value)]);
  } catch (error) {
    adminMessage(error.message);
  } finally {
    button.disabled = false;
  }
}

$('#admin-login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: { username: $('#admin-user').value, password: $('#admin-password').value }
    });
    showPanel(true);
    await loadAccesses();
  } catch (error) {
    $('#admin-login-message').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#admin-search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await loadAccesses($('#admin-search').value); }
  catch (error) { adminMessage(error.message); }
});

$('#admin-logout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch {}
  showPanel(false);
});

api('/api/admin/session')
  .then(async (result) => {
    showPanel(result.authenticated);
    if (result.authenticated) await loadAccesses();
  })
  .catch(() => showPanel(false));
