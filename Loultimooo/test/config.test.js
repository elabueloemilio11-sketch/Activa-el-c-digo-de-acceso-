import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

function base(overrides = {}) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://example/test',
    APP_URL: 'http://localhost:3000',
    ACADEMY_URL: '/academy',
    SESSION_SECRET: 's'.repeat(48),
    CODE_PEPPER: 'p'.repeat(48),
    CODE_ENCRYPTION_KEY: 'e'.repeat(48),
    ADMIN_PASSWORD: 'admin-password-for-test',
    ...overrides
  };
}

test('config fixes the security limits and normalizes Shopify values', () => {
  const config = loadConfig(base({
    SHOPIFY_STORE_DOMAIN: 'https://Demo-Store.myshopify.com/',
    SHOPIFY_PRODUCT_VARIANT_IDS: '123, 456'
  }));
  assert.equal(config.shopifyStoreDomain, 'demo-store.myshopify.com');
  assert.deepEqual([...config.shopifyProductVariantIds], ['123', '456']);
  assert.equal(config.maxDevices, 2);
  assert.equal(config.maxSessions, 2);
});

test('course target cannot bypass the protected gateway', () => {
  assert.throws(() => loadConfig(base({ ACADEMY_URL: 'https://elsewhere.example/course' })), /protected/);
});

test('production rejects incomplete secrets and console email delivery', () => {
  assert.throws(() => loadConfig(base({ NODE_ENV: 'production' })), /forbidden|Missing/);
});
