import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const root = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required.');
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : undefined
});

try {
  const files = (await readdir(root))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();

  if (files.length === 0) {
    throw new Error('No migration SQL files found in repository root.');
  }

  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock(824051947)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const exists = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [file]
      );

      if (exists.rows[0]) continue;

      const sql = await readFile(path.join(root, file), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.info(`Applied ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    await client.query('SELECT pg_advisory_unlock(824051947)');
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
