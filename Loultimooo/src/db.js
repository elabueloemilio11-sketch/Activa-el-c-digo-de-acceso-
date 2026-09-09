import pg from 'pg';

const { Pool } = pg;

export function createDatabase(config) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.nodeEnv === 'production' ? 10 : 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : undefined
  });

  pool.on('error', (error) => {
    // Avoid leaking the connection string while still surfacing an actionable error.
    console.error('Unexpected PostgreSQL pool error:', error.message);
  });

  return pool;
}

export async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
