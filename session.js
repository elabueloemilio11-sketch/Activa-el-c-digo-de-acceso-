import { keyedHash, randomToken } from '../security/crypto.js';
import {
  cookieNames,
  cookieOptions,
  countryCode,
  ipHash,
  safeUserAgent
} from '../security/request.js';
import { recordSecurityEvent, RISK } from './risk.js';

export function setAuthenticatedCookies(reply, config, { sessionToken, deviceToken }) {
  const names = cookieNames(config);
  reply.setCookie(names.session, sessionToken, cookieOptions(config, {
    maxAge: config.sessionTtlDays * 24 * 60 * 60,
    sameSite: 'lax'
  }));
  if (deviceToken) {
    reply.setCookie(names.device, deviceToken, cookieOptions(config, {
      maxAge: config.deviceTtlDays * 24 * 60 * 60,
      sameSite: 'lax'
    }));
  }
  setCsrfCookie(reply, config);
}

export function setCsrfCookie(reply, config) {
  const names = cookieNames(config);
  const csrfToken = randomToken(24);
  reply.setCookie(names.csrf, csrfToken, cookieOptions(config, {
    httpOnly: false,
    maxAge: config.sessionTtlDays * 24 * 60 * 60,
    sameSite: 'strict'
  }));
  return csrfToken;
}

export function clearAuthenticatedCookies(reply, config, { clearDevice = false } = {}) {
  const names = cookieNames(config);
  reply.clearCookie(names.session, cookieOptions(config));
  reply.clearCookie(names.csrf, cookieOptions(config, { httpOnly: false, sameSite: 'strict' }));
  if (clearDevice) reply.clearCookie(names.device, cookieOptions(config));
}

export async function createSessionRecord(db, config, request, { accessId, deviceId }) {
  await db.query(
    `UPDATE sessions
     SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = COALESCE(revoked_reason, 'expired')
     WHERE access_id = $1 AND revoked_at IS NULL AND expires_at <= now()`,
    [accessId]
  );

  const activeResult = await db.query(
    `SELECT id
     FROM sessions
     WHERE access_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY created_at ASC
     FOR UPDATE`,
    [accessId]
  );
  const revokeCount = Math.max(0, activeResult.rows.length - config.maxSessions + 1);
  if (revokeCount > 0) {
    const ids = activeResult.rows.slice(0, revokeCount).map((row) => row.id);
    await db.query(
      `UPDATE sessions
       SET revoked_at = now(), revoked_reason = 'simultaneous_session_limit'
       WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    await recordSecurityEvent(db, {
      accessId,
      eventType: 'oldest_session_revoked',
      riskPoints: RISK.EXCESS_SESSIONS,
      ipHash: ipHash(request, config),
      country: countryCode(request),
      metadata: { revokedCount: ids.length }
    });
  }

  const sessionToken = randomToken(32);
  const result = await db.query(
    `INSERT INTO sessions
       (access_id, device_id, token_hash, ip_hash, country, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6,
       now() + ($7::bigint * interval '1 day'))
     RETURNING id`,
    [
      accessId,
      deviceId,
      keyedHash(config.sessionSecret, 'session-token', sessionToken),
      ipHash(request, config),
      countryCode(request),
      safeUserAgent(request),
      config.sessionTtlDays
    ]
  );
  return { sessionId: result.rows[0].id, sessionToken };
}

export async function authenticateRequest(pool, request, config) {
  const names = cookieNames(config);
  const sessionToken = request.cookies[names.session];
  const deviceToken = request.cookies[names.device];
  if (!sessionToken || !deviceToken) return null;

  const result = await pool.query(
    `SELECT
       s.id AS session_id, s.access_id, s.device_id, s.last_seen_at AS session_last_seen,
       a.customer_email, a.status AS access_status, a.suspicious, a.risk_score,
       d.label AS device_label, d.status AS device_status
     FROM sessions s
     JOIN accesses a ON a.id = s.access_id
     JOIN devices d ON d.id = s.device_id
     WHERE s.token_hash = $1
       AND d.token_hash = $2
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND d.status = 'active'
       AND a.status = 'active'
     LIMIT 1`,
    [
      keyedHash(config.sessionSecret, 'session-token', sessionToken),
      keyedHash(config.sessionSecret, 'device-token', deviceToken)
    ]
  );
  const auth = result.rows[0];
  if (!auth) return null;

  if (Date.now() - new Date(auth.session_last_seen).getTime() > 5 * 60 * 1000) {
    const currentIpHash = ipHash(request, config);
    const country = countryCode(request);
    await Promise.all([
      pool.query(
        `UPDATE sessions SET last_seen_at = now(), ip_hash = $2, country = COALESCE($3, country)
         WHERE id = $1`,
        [auth.session_id, currentIpHash, country]
      ),
      pool.query(
        `UPDATE devices SET last_seen_at = now(), last_ip_hash = $2,
           last_country = COALESCE($3, last_country) WHERE id = $1`,
        [auth.device_id, currentIpHash, country]
      ),
      pool.query('UPDATE accesses SET last_used_at = now() WHERE id = $1', [auth.access_id])
    ]);
  }
  return auth;
}

export async function revokeSession(pool, request, config, reason = 'logout') {
  const token = request.cookies[cookieNames(config).session];
  if (!token) return;
  await pool.query(
    `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = $2
     WHERE token_hash = $1`,
    [keyedHash(config.sessionSecret, 'session-token', token), reason]
  );
}
