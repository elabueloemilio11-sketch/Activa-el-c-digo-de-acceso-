import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { loadConfig } from '../src/config.js';
import { enqueueEmail, startOutboxWorker } from '../src/services/outbox.js';
import { applyMigrations, databaseAdapter } from './helpers.js';

test('email outbox decrypts, delivers and erases the sensitive payload', async () => {
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
  const pool = databaseAdapter(database);
  await enqueueEmail(pool, config, {
    kind: 'otp', to: 'buyer@example.com', payload: { otp: '123456', minutes: 10 }
  });
  const delivered = [];
  const stop = startOutboxWorker({
    pool,
    config,
    mailer: { async send(message) { delivered.push(message); } },
    logger: { info() {}, error() {} }
  });
  const deadline = Date.now() + 3_000;
  while (!delivered.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await stop();
  assert.deepEqual(delivered, [{ kind: 'otp', to: 'buyer@example.com', payload: { otp: '123456', minutes: 10 } }]);
  const job = await database.query('SELECT status, encrypted_payload FROM email_outbox');
  assert.equal(job.rows[0].status, 'sent');
  assert.equal(job.rows[0].encrypted_payload, null);
  await database.close();
});
