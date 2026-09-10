import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export function databaseAdapter(database, { ignoreAdvisoryLocks = false } = {}) {
  const query = (sql, parameters) => {
    if (ignoreAdvisoryLocks && String(sql).includes('pg_advisory_')) return Promise.resolve({ rows: [{}], rowCount: 1 });
    return database.query(sql, parameters);
  };
  return {
    query,
    async connect() {
      return { query, release() {} };
    }
  };
}

export async function applyMigrations(database) {
  const directory = path.resolve('migrations');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = (await readFile(path.join(directory, file), 'utf8'))
      .replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '');
    await database.exec(sql);
  }
}
