import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { applyMigrations, databaseAdapter } from './helpers.js';

function signedHeaders(body, secret, topic, webhookId) {
  return {
    'content-type': 'application/json',
    'x-shopify-hmac-sha256': createHmac('sha256', secret).update(body).digest('base64'),
    'x-shopify-topic': topic,
    'x-shopify-shop-domain': 'demo-store.myshopify.com',
    'x-shopify-webhook-id': webhookId
  };
}

test('paid webhook is HMAC-verified, product-scoped and idempotent', async () => {
  const database = new PGlite();
  await applyMigrations(database);
  const secret = 'shopify-webhook-secret-value';
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://embedded/test',
    APP_URL: 'http://localhost:3000',
    ACADEMY_URL: '/academy',
    SHOPIFY_STORE_DOMAIN: 'demo-store.myshopify.com',
    SHOPIFY_WEBHOOK_SECRET: secret,
    SHOPIFY_PRODUCT_VARIANT_IDS: '987654321',
    SESSION_SECRET: 'session-secret-'.repeat(4),
    CODE_PEPPER: 'code-pepper-'.repeat(4),
    CODE_ENCRYPTION_KEY: 'encryption-secret-'.repeat(3),
    ADMIN_PASSWORD: 'test-admin-password-long',
    EMAIL_PROVIDER: 'console'
  });
  const app = await buildApp({
    config,
    db: databaseAdapter(database, { ignoreAdvisoryLocks: true }),
    mailer: { async send() {}, async close() {} },
    outboxEnabled: false,
    logger: false
  });
  await app.ready();

  const order = {
    id: 5001,
    name: '#1001',
    financial_status: 'paid',
    email: 'Buyer@Example.com',
    line_items: [{ variant_id: 987654321, product_id: 111 }]
  };
  const body = JSON.stringify(order);
  let response = await app.inject({
    method: 'POST', url: '/webhooks/shopify/order-paid',
    headers: signedHeaders(body, secret, 'orders/paid', 'wh-paid-1'), payload: body
  });
  assert.equal(response.statusCode, 200, response.body);
  response = await app.inject({
    method: 'POST', url: '/webhooks/shopify/order-paid',
    headers: signedHeaders(body, secret, 'orders/paid', 'wh-paid-1'), payload: body
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().duplicate, true);

  const state = await database.query(
    `SELECT
       (SELECT count(*)::int FROM accesses) AS accesses,
       (SELECT count(*)::int FROM email_outbox WHERE kind = 'access_code') AS emails,
       (SELECT count(*)::int FROM webhook_events WHERE webhook_id = 'wh-paid-1') AS events`
  );
  assert.deepEqual(
    [Number(state.rows[0].accesses), Number(state.rows[0].emails), Number(state.rows[0].events)],
    [1, 1, 1]
  );
  const access = await database.query(`SELECT * FROM accesses WHERE order_id = '5001'`);
  assert.equal(access.rows[0].customer_email, 'buyer@example.com');
  assert.equal(access.rows[0].access_code_hash.includes('AE-'), false);

  const badResponse = await app.inject({
    method: 'POST', url: '/webhooks/shopify/order-paid',
    headers: { ...signedHeaders(body, secret, 'orders/paid', 'wh-bad'), 'x-shopify-hmac-sha256': 'invalid' },
    payload: body
  });
  assert.equal(badResponse.statusCode, 401);

  await app.close();
  await database.close();
});
