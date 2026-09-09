import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  decryptJson,
  hashSlowSecret,
  keyedHash,
  normalizeAccessCode
} from '../src/security/crypto.js';
import { applyMigrations, databaseAdapter } from './helpers.js';

class CookieJar {
  constructor() { this.cookies = new Map(); }
  absorb(response) {
    const values = response.headers['set-cookie'];
    for (const value of Array.isArray(values) ? values : (values ? [values] : [])) {
      const [pair] = value.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const content = pair.slice(separator + 1);
      if (/Max-Age=0/i.test(value) || content === '') this.cookies.delete(name);
      else this.cookies.set(name, content);
    }
  }
  header() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '); }
  csrf() {
    const found = [...this.cookies].find(([key]) => key.endsWith('ae_csrf'));
    return found ? decodeURIComponent(found[1]) : '';
  }
}

async function request(app, jar, method, url, body, userAgent) {
  const headers = {
    origin: 'http://localhost:3000',
    'user-agent': userAgent,
    ...(jar.header() ? { cookie: jar.header() } : {}),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {})
  };
  const response = await app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
  jar.absorb(response);
  return response;
}

async function latestOtp(database, encryptionKey) {
  const result = await database.query(
    `SELECT encrypted_payload FROM email_outbox
     WHERE kind = 'otp' AND status = 'pending'
     ORDER BY id DESC LIMIT 1`
  );
  return decryptJson(result.rows[0].encrypted_payload, encryptionKey).otp;
}

async function beginNewDevice(app, database, config, jar, userAgent) {
  let response = await request(app, jar, 'GET', '/access', undefined, userAgent);
  assert.equal(response.statusCode, 200);
  response = await request(app, jar, 'POST', '/api/access/validate', { code: 'AE-8K7P-42XM-55RW' }, userAgent);
  assert.equal(response.statusCode, 200, response.body);
  response = await request(app, jar, 'POST', '/api/access/verify-email', { email: 'buyer@example.com' }, userAgent);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().next, 'otp');
  return latestOtp(database, config.codeEncryptionKey);
}

test('full activation enforces two devices and securely replaces an old device', async () => {
  const database = new PGlite();
  await applyMigrations(database);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://embedded/test',
    APP_URL: 'http://localhost:3000',
    ACADEMY_URL: '/academy',
    SESSION_SECRET: 'session-secret-'.repeat(4),
    CODE_PEPPER: 'code-pepper-'.repeat(4),
    CODE_ENCRYPTION_KEY: 'encryption-secret-'.repeat(3),
    ADMIN_PASSWORD: 'test-admin-password-long',
    EMAIL_PROVIDER: 'console'
  });
  const code = normalizeAccessCode('AE-8K7P-42XM-55RW');
  await database.query(
    `INSERT INTO accesses
       (access_code_hash, access_code_lookup, access_code_last4, order_id, customer_email)
     VALUES ($1, $2, $3, 'order-100', 'buyer@example.com')`,
    [
      await hashSlowSecret(code),
      keyedHash(config.codePepper, 'access-code-lookup', code),
      code.slice(-4)
    ]
  );
  const mailer = { async send() {}, async close() {} };
  const app = await buildApp({ config, db: databaseAdapter(database), mailer, outboxEnabled: false, logger: false });
  await app.ready();

  const phone = new CookieJar();
  let otp = await beginNewDevice(app, database, config, phone, 'Mozilla/5.0 (iPhone) Version/18.0 Mobile Safari/604.1');
  let response = await request(app, phone, 'POST', '/api/access/verify-otp', { otp }, 'Mozilla/5.0 (iPhone) Version/18.0 Mobile Safari/604.1');
  assert.equal(response.statusCode, 200, response.body);
  assert.ok([...phone.cookies.keys()].some((name) => name.endsWith('ae_session')));

  const computer = new CookieJar();
  otp = await beginNewDevice(app, database, config, computer, 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0');
  response = await request(app, computer, 'POST', '/api/access/verify-otp', { otp }, 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0');
  assert.equal(response.statusCode, 200, response.body);

  const tablet = new CookieJar();
  otp = await beginNewDevice(app, database, config, tablet, 'Mozilla/5.0 (iPad) Version/18.0 Safari/604.1');
  response = await request(app, tablet, 'POST', '/api/access/verify-otp', { otp }, 'Mozilla/5.0 (iPad) Version/18.0 Safari/604.1');
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'DEVICE_LIMIT');

  response = await request(app, tablet, 'GET', '/api/devices', undefined, 'Mozilla/5.0 (iPad) Version/18.0 Safari/604.1');
  assert.equal(response.statusCode, 200, response.body);
  const oldDeviceId = response.json().devices.find((device) => device.status === 'active' && device.label.startsWith('iPhone')).id;
  response = await app.inject({
    method: 'POST',
    url: '/api/device/revoke',
    headers: {
      origin: 'http://localhost:3000',
      cookie: tablet.header(),
      'content-type': 'application/json',
      'x-csrf-token': tablet.csrf(),
      'user-agent': 'Mozilla/5.0 (iPad) Version/18.0 Safari/604.1'
    },
    payload: JSON.stringify({ deviceId: oldDeviceId })
  });
  tablet.absorb(response);
  assert.equal(response.statusCode, 200, response.body);

  const deviceCount = await database.query(`SELECT count(*)::int AS count FROM devices WHERE status = 'active'`);
  const sessionCount = await database.query(`SELECT count(*)::int AS count FROM sessions WHERE revoked_at IS NULL AND expires_at > now()`);
  const access = await database.query(`SELECT status, suspicious, risk_score FROM accesses WHERE order_id = 'order-100'`);
  assert.equal(Number(deviceCount.rows[0].count), 2);
  assert.equal(Number(sessionCount.rows[0].count), 2);
  assert.equal(access.rows[0].status, 'active');
  assert.equal(access.rows[0].suspicious, false, 'one legitimate device replacement must not flag the buyer');

  response = await request(app, tablet, 'GET', '/academy', undefined, 'Mozilla/5.0 (iPad) Version/18.0 Safari/604.1');
  assert.equal(response.statusCode, 200);
  response = await request(app, tablet, 'GET', '/academy/assets/course.js', undefined, 'Mozilla/5.0 (iPad) Version/18.0 Safari/604.1');
  assert.equal(response.statusCode, 200);
  response = await request(app, phone, 'GET', '/academy', undefined, 'Mozilla/5.0 (iPhone) Version/18.0 Mobile Safari/604.1');
  assert.equal(response.statusCode, 302);

  response = await request(app, computer, 'POST', '/api/access/validate', { code: 'AE-8K7P-42XM-55RW' }, 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0');
  assert.equal(response.statusCode, 200, response.body);
  response = await request(app, computer, 'POST', '/api/access/verify-email', { email: 'buyer@example.com' }, 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0');
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().next, 'academy');
  const sessionsAfterRelogin = await database.query(
    `SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS active_count,
            count(*) FILTER (WHERE revoked_reason = 'simultaneous_session_limit')::int AS evicted_count
     FROM sessions WHERE expires_at > now()`
  );
  assert.equal(Number(sessionsAfterRelogin.rows[0].active_count), 2);
  assert.equal(Number(sessionsAfterRelogin.rows[0].evicted_count), 1);

  const recoveryJar = new CookieJar();
  await request(app, recoveryJar, 'GET', '/access', undefined, 'Recovery browser');
  response = await request(app, recoveryJar, 'POST', '/api/access/recover', { email: 'buyer@example.com' }, 'Recovery browser');
  assert.equal(response.statusCode, 200, response.body);
  const recoveryEmail = await database.query(
    `SELECT encrypted_payload FROM email_outbox
     WHERE kind = 'recovery' AND status = 'pending' ORDER BY id DESC LIMIT 1`
  );
  const recoveryPayload = decryptJson(recoveryEmail.rows[0].encrypted_payload, config.codeEncryptionKey);
  const recoveryToken = new URLSearchParams(new URL(recoveryPayload.recoveryUrl).hash.slice(1)).get('token');
  response = await request(app, recoveryJar, 'POST', '/api/access/recover/confirm', { token: recoveryToken }, 'Recovery browser');
  assert.equal(response.statusCode, 200, response.body);
  const replacementEmail = await database.query(
    `SELECT encrypted_payload FROM email_outbox
     WHERE kind = 'access_code' AND status = 'pending' ORDER BY id DESC LIMIT 1`
  );
  const replacementCode = decryptJson(replacementEmail.rows[0].encrypted_payload, config.codeEncryptionKey).code;
  const recoveredState = await database.query(
    `SELECT a.status,
       (SELECT count(*)::int FROM devices WHERE access_id = a.id AND status = 'active') AS active_devices,
       (SELECT count(*)::int FROM sessions WHERE access_id = a.id AND revoked_at IS NULL) AS active_sessions
     FROM accesses a WHERE order_id = 'order-100'`
  );
  assert.deepEqual(
    [recoveredState.rows[0].status, Number(recoveredState.rows[0].active_devices), Number(recoveredState.rows[0].active_sessions)],
    ['issued', 0, 0]
  );
  const freshJar = new CookieJar();
  await request(app, freshJar, 'GET', '/access', undefined, 'Fresh browser');
  response = await request(app, freshJar, 'POST', '/api/access/validate', { code: 'AE-8K7P-42XM-55RW' }, 'Fresh browser');
  assert.equal(response.statusCode, 401);
  response = await request(app, freshJar, 'POST', '/api/access/validate', { code: replacementCode }, 'Fresh browser');
  assert.equal(response.statusCode, 200, response.body);

  await app.close();
  await database.close();
});
