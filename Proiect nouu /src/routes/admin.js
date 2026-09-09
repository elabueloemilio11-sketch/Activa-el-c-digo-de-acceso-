import { withTransaction } from '../db.js';
import { keyedHash, randomToken, safeEqualText } from '../security/crypto.js';
import {
  assertCsrf,
  cookieNames,
  cookieOptions,
  countryCode,
  ensureAnonymousCookie,
  ipHash,
  safeUserAgent
} from '../security/request.js';
import { enforceRateLimit } from '../services/rate-limit.js';
import { setCsrfCookie } from '../services/session.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function authenticateAdmin(pool, request, config) {
  const token = request.cookies[cookieNames(config).admin];
  if (!token) return null;
  const result = await pool.query(
    `SELECT id, last_seen_at
     FROM admin_sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
     LIMIT 1`,
    [keyedHash(config.sessionSecret, 'admin-session', token)]
  );
  const session = result.rows[0];
  if (!session) return null;
  if (Date.now() - new Date(session.last_seen_at).getTime() > 5 * 60_000) {
    await pool.query('UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1', [session.id]);
  }
  return session;
}

async function requireAdmin(app, request, reply, { csrf = false } = {}) {
  const admin = await authenticateAdmin(app.db, request, app.config);
  if (!admin) {
    reply.code(401).send({ ok: false, message: 'Acceso administrativo requerido.' });
    return null;
  }
  if (csrf && !assertCsrf(request, app.config)) {
    reply.code(403).send({ ok: false, message: 'Solicitud no válida.' });
    return null;
  }
  return admin;
}

async function writeAudit(db, app, request, admin, accessId, action, metadata = {}) {
  await db.query(
    `INSERT INTO audit_logs (admin_session_id, access_id, action, metadata, ip_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [admin.id, accessId, action, JSON.stringify(metadata), ipHash(request, app.config)]
  );
}

export async function adminRoutes(app) {
  app.post('/api/admin/login', async (request, reply) => {
    ensureAnonymousCookie(request, reply, app.config);
    const rate = await enforceRateLimit(app.db, request, app.config, 'adminLogin');
    if (!rate.allowed) {
      reply.header('retry-after', String(rate.retryAfterSeconds));
      return reply.code(429).send({ ok: false, message: 'Demasiados intentos.' });
    }
    const username = String(request.body?.username ?? '');
    const password = String(request.body?.password ?? '');
    if (!safeEqualText(username, app.config.adminUsername) || !safeEqualText(password, app.config.adminPassword)) {
      await app.db.query(
        `INSERT INTO security_events (event_type, risk_points, ip_hash, country, metadata)
         VALUES ('admin_login_rejected', 0, $1, $2, '{}'::jsonb)`,
        [ipHash(request, app.config), countryCode(request)]
      );
      return reply.code(401).send({ ok: false, message: 'Credenciales no válidas.' });
    }

    const token = randomToken(32);
    await app.db.query(
      `INSERT INTO admin_sessions (token_hash, expires_at, ip_hash, user_agent)
       VALUES ($1, now() + interval '8 hours', $2, $3)`,
      [
        keyedHash(app.config.sessionSecret, 'admin-session', token),
        ipHash(request, app.config),
        safeUserAgent(request)
      ]
    );
    reply.setCookie(cookieNames(app.config).admin, token, cookieOptions(app.config, {
      maxAge: 8 * 60 * 60,
      sameSite: 'strict'
    }));
    setCsrfCookie(reply, app.config);
    return reply.send({ ok: true });
  });

  app.post('/api/admin/logout', async (request, reply) => {
    const admin = await requireAdmin(app, request, reply, { csrf: true });
    if (!admin) return;
    await app.db.query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1', [admin.id]);
    reply.clearCookie(cookieNames(app.config).admin, cookieOptions(app.config));
    reply.clearCookie(cookieNames(app.config).csrf, cookieOptions(app.config, { httpOnly: false }));
    return reply.send({ ok: true });
  });

  app.get('/api/admin/session', async (request, reply) => {
    const admin = await authenticateAdmin(app.db, request, app.config);
    return reply.send({ ok: true, authenticated: Boolean(admin) });
  });

  app.get('/api/admin/accesses', async (request, reply) => {
    const admin = await requireAdmin(app, request, reply);
    if (!admin) return;
    const query = String(request.query?.q ?? '').trim().slice(0, 200);
    const like = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const result = await app.db.query(
      `SELECT
         a.id, a.order_id, a.order_name, a.customer_email, a.access_code_last4,
         a.status, a.created_at, a.activated_at, a.last_used_at,
         a.max_devices, a.activation_count, a.risk_score, a.suspicious,
         count(DISTINCT d.id) FILTER (WHERE d.status = 'active')::int AS active_devices,
         count(DISTINCT s.id) FILTER (
           WHERE s.revoked_at IS NULL AND s.expires_at > now()
         )::int AS active_sessions
       FROM accesses a
       LEFT JOIN devices d ON d.access_id = a.id
       LEFT JOIN sessions s ON s.access_id = a.id
       WHERE ($1 = '' OR a.customer_email ILIKE $2 ESCAPE '\\'
              OR a.order_id ILIKE $2 ESCAPE '\\'
              OR COALESCE(a.order_name, '') ILIKE $2 ESCAPE '\\')
       GROUP BY a.id
       ORDER BY a.created_at DESC
       LIMIT 50`,
      [query, like]
    );
    return reply.send({ ok: true, accesses: result.rows });
  });

  app.get('/api/admin/access/:id', async (request, reply) => {
    const admin = await requireAdmin(app, request, reply);
    if (!admin) return;
    const accessId = String(request.params.id ?? '');
    if (!UUID_PATTERN.test(accessId)) return reply.code(400).send({ ok: false, message: 'Identificador no válido.' });
    const [access, devices, sessions, events] = await Promise.all([
      app.db.query('SELECT * FROM accesses WHERE id = $1', [accessId]),
      app.db.query(
        `SELECT id, label, user_agent, status, created_at, last_seen_at, revoked_at, revoked_reason,
                last_country FROM devices WHERE access_id = $1 ORDER BY last_seen_at DESC`,
        [accessId]
      ),
      app.db.query(
        `SELECT id, device_id, created_at, last_seen_at, expires_at, revoked_at, revoked_reason, country
         FROM sessions WHERE access_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [accessId]
      ),
      app.db.query(
        `SELECT event_type, risk_points, country, metadata, created_at
         FROM security_events WHERE access_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [accessId]
      )
    ]);
    if (!access.rows[0]) return reply.code(404).send({ ok: false, message: 'Acceso no encontrado.' });
    const safeAccess = { ...access.rows[0] };
    delete safeAccess.access_code_hash;
    delete safeAccess.access_code_lookup;
    delete safeAccess.access_code_ciphertext;
    return reply.send({
      ok: true,
      access: safeAccess,
      devices: devices.rows,
      sessions: sessions.rows,
      events: events.rows
    });
  });

  app.post('/api/admin/access/:id/action', async (request, reply) => {
    const admin = await requireAdmin(app, request, reply, { csrf: true });
    if (!admin) return;
    const accessId = String(request.params.id ?? '');
    if (!UUID_PATTERN.test(accessId)) return reply.code(400).send({ ok: false, message: 'Identificador no válido.' });
    const action = String(request.body?.action ?? '');
    const deviceId = request.body?.deviceId ? String(request.body.deviceId) : null;
    const maxDevices = Number(request.body?.maxDevices ?? app.config.maxDevices);
    const allowed = new Set([
      'revoke_device',
      'revoke_all_devices',
      'disable_access',
      'reactivate_access',
      'mark_suspicious',
      'clear_suspicious',
      'set_device_limit'
    ]);
    if (!allowed.has(action)) return reply.code(400).send({ ok: false, message: 'Acción no válida.' });

    const result = await withTransaction(app.db, async (db) => {
      const locked = await db.query('SELECT id, status FROM accesses WHERE id = $1 FOR UPDATE', [accessId]);
      if (!locked.rows[0]) return { notFound: true };

      if (action === 'revoke_device') {
        if (!deviceId || !UUID_PATTERN.test(deviceId)) return { invalid: true };
        const changed = await db.query(
          `UPDATE devices SET status = 'revoked', revoked_at = now(), revoked_reason = 'admin_revoked'
           WHERE id = $1 AND access_id = $2 AND status = 'active' RETURNING id`,
          [deviceId, accessId]
        );
        if (!changed.rows[0]) return { invalid: true };
        await db.query(
          `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = 'device_revoked'
           WHERE device_id = $1`,
          [deviceId]
        );
      }
      if (action === 'revoke_all_devices' || action === 'disable_access') {
        await db.query(
          `UPDATE devices SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()),
             revoked_reason = $2 WHERE access_id = $1 AND status = 'active'`,
          [accessId, action === 'disable_access' ? 'access_disabled' : 'admin_revoked_all']
        );
        await db.query(
          `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()),
             revoked_reason = $2 WHERE access_id = $1 AND revoked_at IS NULL`,
          [accessId, action === 'disable_access' ? 'access_disabled' : 'devices_revoked']
        );
      }
      if (action === 'disable_access') {
        await db.query(`UPDATE accesses SET status = 'disabled' WHERE id = $1`, [accessId]);
        await db.query(
          `UPDATE activation_challenges SET consumed_at = COALESCE(consumed_at, now())
           WHERE access_id = $1`,
          [accessId]
        );
        await db.query(
          `UPDATE recovery_tokens SET used_at = COALESCE(used_at, now())
           WHERE access_id = $1`,
          [accessId]
        );
        await db.query(
          `UPDATE email_outbox SET status = 'failed', encrypted_payload = NULL, last_error = 'access_disabled'
           WHERE access_id = $1 AND status IN ('pending', 'processing')`,
          [accessId]
        );
      }
      if (action === 'reactivate_access') {
        await db.query(`UPDATE accesses SET status = CASE WHEN activated_at IS NULL THEN 'issued' ELSE 'active' END WHERE id = $1`, [accessId]);
      }
      if (action === 'mark_suspicious') {
        await db.query(`UPDATE accesses SET suspicious = true, risk_score = GREATEST(risk_score, 50) WHERE id = $1`, [accessId]);
      }
      if (action === 'clear_suspicious') {
        await db.query(`UPDATE accesses SET suspicious = false, risk_score = 0, risk_notes = NULL WHERE id = $1`, [accessId]);
      }
      if (action === 'set_device_limit') {
        if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 10) return { invalid: true };
        await db.query('UPDATE accesses SET max_devices = $2 WHERE id = $1', [accessId, maxDevices]);
        const devices = await db.query(
          `SELECT id FROM devices
           WHERE access_id = $1 AND status = 'active'
           ORDER BY last_seen_at DESC
           FOR UPDATE`,
          [accessId]
        );
        const revokeIds = devices.rows.slice(maxDevices).map((device) => device.id);
        if (revokeIds.length) {
          await db.query(
            `UPDATE devices SET status = 'revoked', revoked_at = now(), revoked_reason = 'admin_device_limit'
             WHERE id = ANY($1::uuid[])`,
            [revokeIds]
          );
          await db.query(
            `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = 'device_revoked'
             WHERE device_id = ANY($1::uuid[])`,
            [revokeIds]
          );
        }
      }
      await writeAudit(db, app, request, admin, accessId, action, { deviceId, maxDevices });
      return { ok: true };
    });
    if (result.notFound) return reply.code(404).send({ ok: false, message: 'Acceso no encontrado.' });
    if (result.invalid) return reply.code(400).send({ ok: false, message: 'La acción no se puede aplicar.' });
    return reply.send({ ok: true });
  });
}

export { authenticateAdmin };
