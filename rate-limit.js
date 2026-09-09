import { keyedHash } from '../security/crypto.js';
import { ipHash, requestActor } from '../security/request.js';

const LIMITS = Object.freeze({
  validate: { limit: 10, windowSeconds: 15 * 60 },
  activate: { limit: 8, windowSeconds: 15 * 60 },
  verifyOtp: { limit: 8, windowSeconds: 10 * 60 },
  sendOtp: { limit: 3, windowSeconds: 10 * 60 },
  recover: { limit: 5, windowSeconds: 60 * 60 },
  recoverConfirm: { limit: 5, windowSeconds: 60 * 60 },
  adminLogin: { limit: 8, windowSeconds: 15 * 60 }
});

async function consume(pool, config, route, identity, rules) {
  const keyHash = keyedHash(config.sessionSecret, 'rate-limit', `${route}\0${identity}`);
  const result = await pool.query(
    `INSERT INTO rate_limits (key_hash, route, hits, reset_at, updated_at)
     VALUES ($1, $2, 1, now() + ($3::bigint * interval '1 second'), now())
     ON CONFLICT (key_hash) DO UPDATE SET
       route = EXCLUDED.route,
       hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
       reset_at = CASE
         WHEN rate_limits.reset_at <= now()
           THEN now() + ($3::bigint * interval '1 second')
         ELSE rate_limits.reset_at
       END,
       updated_at = now()
     RETURNING hits, reset_at`,
    [keyHash, route, rules.windowSeconds]
  );
  const row = result.rows[0];
  return { allowed: row.hits <= rules.limit, remaining: Math.max(0, rules.limit - row.hits), resetAt: row.reset_at };
}

export async function enforceRateLimit(pool, request, config, bucketName) {
  const rules = LIMITS[bucketName];
  if (!rules) throw new Error(`Unknown rate-limit bucket: ${bucketName}`);

  const [byIp, byActor] = await Promise.all([
    consume(pool, config, `${bucketName}:ip`, ipHash(request, config), rules),
    consume(pool, config, `${bucketName}:actor`, requestActor(request, config), rules)
  ]);
  const allowed = byIp.allowed && byActor.allowed;
  const resetAt = new Date(Math.max(new Date(byIp.resetAt).getTime(), new Date(byActor.resetAt).getTime()));
  return {
    allowed,
    remaining: Math.min(byIp.remaining, byActor.remaining),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000))
  };
}

export async function cleanExpiredRateLimits(pool) {
  await pool.query(`DELETE FROM rate_limits WHERE reset_at < now() - interval '1 day'`);
}
