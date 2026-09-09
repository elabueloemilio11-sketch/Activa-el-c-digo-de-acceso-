import { decryptJson, encryptJson } from '../security/crypto.js';

export async function enqueueEmail(db, config, { kind, to, payload, accessId = null }) {
  await db.query(
    `INSERT INTO email_outbox (kind, access_id, recipient, encrypted_payload)
     VALUES ($1, $2, $3, $4)`,
    [kind, accessId, to, encryptJson(payload, config.codeEncryptionKey)]
  );
}

async function claimNextJob(pool) {
  const result = await pool.query(
    `WITH candidate AS (
       SELECT id
       FROM email_outbox
       WHERE (
         (status = 'pending' AND next_attempt_at <= now())
         OR (status = 'processing' AND locked_at < now() - interval '5 minutes')
       )
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE email_outbox AS job
     SET status = 'processing', locked_at = now()
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.*`
  );
  return result.rows[0] ?? null;
}

async function finishJob(pool, job) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE email_outbox
       SET status = 'sent', sent_at = now(), locked_at = NULL,
           encrypted_payload = NULL, last_error = NULL
       WHERE id = $1`,
      [job.id]
    );
    if (job.kind === 'access_code' && job.access_id) {
      await client.query(
        `UPDATE accesses SET access_code_ciphertext = NULL WHERE id = $1`,
        [job.access_id]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function failJob(pool, job, error) {
  const attempts = Number(job.attempts) + 1;
  const permanentlyFailed = attempts >= 8;
  const delaySeconds = Math.min(3600, 15 * (2 ** Math.min(attempts, 8)));
  await pool.query(
    `UPDATE email_outbox
     SET status = $2,
         attempts = $3,
         next_attempt_at = now() + ($4::bigint * interval '1 second'),
         locked_at = NULL,
         last_error = $5
     WHERE id = $1`,
    [job.id, permanentlyFailed ? 'failed' : 'pending', attempts, delaySeconds, String(error.message || error).slice(0, 500)]
  );
}

export function startOutboxWorker({ pool, config, mailer, logger }) {
  let stopped = false;
  let running = false;

  const work = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (let processed = 0; processed < 10; processed += 1) {
        const job = await claimNextJob(pool);
        if (!job) break;
        try {
          const payload = decryptJson(job.encrypted_payload, config.codeEncryptionKey);
          await mailer.send({ kind: job.kind, to: job.recipient, payload });
          await finishJob(pool, job);
          logger.info({ outboxJobId: job.id, kind: job.kind }, 'Email delivered');
        } catch (error) {
          await failJob(pool, job, error);
          logger.error({ outboxJobId: job.id, kind: job.kind, error: error.message }, 'Email delivery failed');
        }
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Outbox worker iteration failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(work, 2_000);
  timer.unref();
  void work();

  return async () => {
    stopped = true;
    clearInterval(timer);
    while (running) await new Promise((resolve) => setTimeout(resolve, 25));
  };
}
