import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptJson,
  encryptJson,
  generateAccessCode,
  hashSlowSecret,
  isAccessCodeShapeValid,
  keyedHash,
  normalizeAccessCode,
  verifySlowSecret
} from '../src/security/crypto.js';
import { validHmac } from '../src/routes/webhooks.js';
import { createHmac } from 'node:crypto';

test('access codes use the expected high-entropy shape and do not repeat', () => {
  const codes = new Set();
  for (let index = 0; index < 5_000; index += 1) {
    const code = generateAccessCode();
    assert.match(code, /^AE-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
    assert.equal(isAccessCodeShapeValid(code), true);
    codes.add(code);
  }
  assert.equal(codes.size, 5_000);
});

test('slow hashes verify normalized codes and reject incorrect codes', async () => {
  const code = normalizeAccessCode('AE-8K7P-42XM-55RW');
  const hash = await hashSlowSecret(code);
  assert.equal(await verifySlowSecret(code, hash), true);
  assert.equal(await verifySlowSecret(`${code}X`, hash), false);
  assert.equal(hash.includes(code), false);
});

test('keyed lookups are separated by purpose', () => {
  const secret = 'a'.repeat(48);
  assert.notEqual(keyedHash(secret, 'access', 'value'), keyedHash(secret, 'session', 'value'));
});

test('encrypted payloads round-trip and reject tampering', () => {
  const secret = 'b'.repeat(48);
  const encoded = encryptJson({ code: 'AE-TEST-TEST-TEST' }, secret);
  assert.deepEqual(decryptJson(encoded, secret), { code: 'AE-TEST-TEST-TEST' });
  const parts = encoded.split('.');
  parts[3] = `${parts[3][0] === 'A' ? 'B' : 'A'}${parts[3].slice(1)}`;
  const tampered = parts.join('.');
  assert.throws(() => decryptJson(tampered, secret));
});

test('Shopify webhook HMAC validates the exact raw body', () => {
  const body = Buffer.from('{"id":123,"financial_status":"paid"}');
  const secret = 'shopify-secret-value';
  const hmac = createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(validHmac(body, hmac, secret), true);
  assert.equal(validHmac(Buffer.from(`${body} `), hmac, secret), false);
});
