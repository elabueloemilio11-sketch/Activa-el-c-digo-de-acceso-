import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

test('all PostgreSQL migrations apply cleanly and create critical tables', async () => {
  const db = new PGlite();
  const directory = path.resolve('migrations');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = (await readFile(path.join(directory, file), 'utf8'))
      .replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '');
    await db.exec(sql);
  }
  const result = await db.query(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' ORDER BY tablename`
  );
  const tables = new Set(result.rows.map((row) => row.tablename));
  for (const required of [
    'accesses', 'devices', 'sessions', 'activation_challenges', 'recovery_tokens',
    'webhook_events', 'security_events', 'rate_limits', 'email_outbox', 'audit_logs'
  ]) {
    assert.equal(tables.has(required), true, `missing table ${required}`);
  }
  await db.close();
});
