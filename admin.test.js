import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashSlowSecret, keyedHash } from '../src/security/crypto.js';
import { applyMigrations, databaseAdapter } from './helpers.js';

function absorb(cookies, response) {
  const values = response.headers['set-cookie'];
  for (const value of Array.isArray(values) ? values : (values ? [values] : [])) {
    const [pair] = value.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    const content = pair.slice(index + 1);
    if (/Max-Age=0/i.test(value) || !content) cookies.delete(name);
    else cookies.set(name, content);
  }
}

function cookieHeader(cookies) {
  return [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
}

test('admin panel is isolated, redacts secrets and can revoke an access', async () => {
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
    ADMIN_USERNAME: 'owner',
    ADMIN_PASSWORD: 'correct-admin-password',
    EMAIL_PROVIDER: 'console'
  });
  const codeHash = await hashSlowSecret('AETESTTESTTEST');
  const access = await database.query(
    `INSERT INTO accesses
       (access_code_hash, access_code_lookup, access_code_last4, order_id, customer_email, status)
     VALUES ($1, $2, 'TEST', 'admin-order', 'admin-buyer@example.com', 'active') RETURNING id`,
    [codeHash, keyedHash(config.codePepper, 'access-code-lookup', 'AETESTTESTTEST')]
  );
  const accessId = access.rows[0].id;
  const device = await database.query(
    `INSERT INTO devices (access_id, token_hash, label, user_agent)
     VALUES ($1, $2, 'iPhone · Safari', 'Test') RETURNING id`,
    [accessId, 'd'.repeat(64)]
  );
  await database.query(
    `INSERT INTO sessions (access_id, device_id, token_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, 'Test', now() + interval '1 day')`,
    [accessId, device.rows[0].id, 's'.repeat(64)]
  );

  const app = await buildApp({
    config,
    db: databaseAdapter(database),
    mailer: { async send() {}, async close() {} },
    outboxEnabled: false,
    logger: false
  });
  await app.ready();
  let response = await app.inject({ method: 'GET', url: '/api/admin/accesses' });
  assert.equal(response.statusCode, 401);

  const cookies = new Map();
  response = await app.inject({
    method: 'POST', url: '/api/admin/login',
    headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
    payload: JSON.stringify({ username: 'owner', password: 'wrong-password-value' })
  });
  assert.equal(response.statusCode, 401);
  response = await app.inject({
    method: 'POST', url: '/api/admin/login',
    headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
    payload: JSON.stringify({ username: 'owner', password: 'correct-admin-password' })
  });
  absorb(cookies, response);
  assert.equal(response.statusCode, 200, response.body);

  response = await app.inject({
    method: 'GET', url: `/api/admin/access/${accessId}`,
    headers: { cookie: cookieHeader(cookies), origin: 'http://localhost:3000' }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.body.includes('access_code_hash'), false);
  assert.equal(response.body.includes('access_code_lookup'), false);

  const csrf = [...cookies].find(([name]) => name.endsWith('ae_csrf'))[1];
  response = await app.inject({
    method: 'POST', url: `/api/admin/access/${accessId}/action`,
    headers: {
      cookie: cookieHeader(cookies), origin: 'http://localhost:3000',
      'content-type': 'application/json', 'x-csrf-token': csrf
    },
    payload: JSON.stringify({ action: 'disable_access' })
  });
  assert.equal(response.statusCode, 200, response.body);
  const state = await database.query(
    `SELECT a.status, d.status AS device_status, s.revoked_reason
     FROM accesses a JOIN devices d ON d.access_id = a.id JOIN sessions s ON s.access_id = a.id
     WHERE a.id = $1`,
    [accessId]
  );
  assert.deepEqual(
    [state.rows[0].status, state.rows[0].device_status, state.rows[0].revoked_reason],
    ['disabled', 'revoked', 'access_disabled']
  );

  await app.close();
  await database.close();
});
