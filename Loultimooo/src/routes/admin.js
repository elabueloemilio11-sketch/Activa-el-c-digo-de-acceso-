import { withTransaction } from '../db.js';
import {
  keyedHash,
  randomToken,
  safeEqualText,
  encryptJson,
  generateAccessCode,
  hashSlowSecret,
  normalizeAccessCode,
  normalizeEmail
} from '../security/crypto.js';
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

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

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

  // PAGINA SIMPLA PENTRU GENERARE MANUALA DE CODURI
  app.get('/admin/generate', async (request, reply) => {
    const admin = await authenticateAdmin(app.db, request, app.config);
    if (!admin) return reply.redirect('/admin');

    const csrfName = cookieNames(app.config).csrf;
    const csrf = request.cookies[csrfName] || '';

    const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow">
  <title>Generar código · Abuelo Emilio Academy</title>
  <style>
    body{margin:0;background:#0b0b0d;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .wrap{max-width:560px;margin:0 auto;padding:28px 18px 60px}
    .card{background:#151519;border:1px solid #2a2a30;border-radius:20px;padding:22px}
    h1{font-size:28px;margin:0 0 8px}.muted{color:#a9a9b2;line-height:1.45}
    label{display:block;margin:22px 0 8px;font-weight:700}
    input{width:100%;box-sizing:border-box;padding:15px 14px;border-radius:12px;border:1px solid #3a3a42;background:#0f0f12;color:#fff;font-size:16px}
    button,a.btn{display:block;width:100%;box-sizing:border-box;margin-top:16px;padding:15px;border:0;border-radius:12px;background:#fff;color:#000;font-weight:800;font-size:16px;text-align:center;text-decoration:none}
    a.secondary{background:#232329;color:#fff}
  </style>
</head>
<body>
  <main class="wrap">
    <div class="card">
      <div class="muted">ABUELO EMILIO ACADEMY · ADMIN</div>
      <h1>Generar código manual</h1>
      <p class="muted">Introduce el email del comprador. Se creará un código único y quedará guardado en la base de datos.</p>
      <form method="get" action="/admin/generate/create">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
        <label for="email">Email del comprador</label>
        <input id="email" name="email" type="email" autocomplete="email" required placeholder="cliente@email.com">
        <button type="submit">GENERAR CÓDIGO</button>
      </form>
      <a class="btn secondary" href="/admin">VOLVER AL PANEL</a>
    </div>
  </main>
</body>
</html>`;
    return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(html);
  });

  app.get('/admin/generate/create', async (request, reply) => {
    const admin = await authenticateAdmin(app.db, request, app.config);
    if (!admin) return reply.redirect('/admin');

    const query = request.query || {};
    const csrfFromQuery = String(query._csrf || '');
    const csrfCookie = request.cookies[cookieNames(app.config).csrf] || '';
    if (!csrfFromQuery || !csrfCookie || !safeEqualText(csrfFromQuery, csrfCookie)) {
      return reply.code(403).type('text/html; charset=utf-8').send('<h1>Solicitud no válida.</h1>');
    }

    const email = normalizeEmail(query.email);
    if (!email) {
      return reply.code(400).type('text/html; charset=utf-8').send('<h1>Email no válido.</h1>');
    }

    const displayCode = generateAccessCode();
    const normalizedCode = normalizeAccessCode(displayCode);
    const codeHash = await hashSlowSecret(normalizedCode);
    const codeLookup = keyedHash(app.config.codePepper, 'access-code-lookup', normalizedCode);
    const ciphertext = encryptJson({ code: displayCode }, app.config.codeEncryptionKey);
    const manualOrderId = `manual-${Date.now()}-${randomToken(8)}`;

    const result = await app.db.query(
      `INSERT INTO accesses
         (access_code_hash, access_code_lookup, access_code_last4,
          access_code_ciphertext, order_id, order_name, customer_email, max_devices)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        codeHash,
        codeLookup,
        normalizedCode.slice(-4),
        ciphertext,
        manualOrderId,
        'MANUAL',
        email,
        app.config.maxDevices
      ]
    );

    await writeAudit(app.db, app, request, admin, result.rows[0].id, 'manual_access_created', { email });

    const accessUrl = `${app.config.appUrl}/access`;
    const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow">
  <title>Código creado · Abuelo Emilio Academy</title>
  <style>
    body{margin:0;background:#0b0b0d;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .wrap{max-width:560px;margin:0 auto;padding:28px 18px 60px}
    .card{background:#151519;border:1px solid #2a2a30;border-radius:20px;padding:22px}
    h1{font-size:28px}.muted{color:#a9a9b2}.code{font-size:26px;font-weight:900;letter-spacing:1.5px;background:#09090b;border:1px solid #34343c;border-radius:14px;padding:18px;word-break:break-all;margin:18px 0}
    a{display:block;margin-top:14px;padding:15px;border-radius:12px;background:#fff;color:#000;text-decoration:none;text-align:center;font-weight:800}
    a.secondary{background:#232329;color:#fff}
  </style>
</head>
<body>
  <main class="wrap">
    <div class="card">
      <div class="muted">CÓDIGO CREADO CORRECTAMENTE</div>
      <h1>Acceso listo</h1>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <div class="code">${escapeHtml(displayCode)}</div>
      <p class="muted">Envía al cliente este código junto con el enlace:</p>
      <p>${escapeHtml(accessUrl)}</p>
      <a href="${escapeHtml(accessUrl)}">ABRIR PÁGINA DE ACCESO</a>
      <a class="secondary" href="/admin/generate">GENERAR OTRO CÓDIGO</a>
      <a class="secondary" href="/admin">VOLVER AL PANEL</a>
    </div>
  </main>
</body>
</html>`;
    return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(html);
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
