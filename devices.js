import { withTransaction } from '../db.js';
import { cookieNames, cookieOptions, assertCsrf, countryCode, ipHash } from '../security/request.js';
import { keyedHash } from '../security/crypto.js';
import { getActivation, createNewDeviceAndSession } from './access.js';
import {
  authenticateRequest,
  clearAuthenticatedCookies,
  setAuthenticatedCookies
} from '../services/session.js';
import { recordSecurityEvent, RISK } from '../services/risk.js';

async function authorizationContext(app, request) {
  const auth = await authenticateRequest(app.db, request, app.config);
  if (auth) return { kind: 'session', accessId: auth.access_id, auth };

  const challenge = await getActivation(app.db, request, app.config);
  const recentlyAuthorized = challenge?.management_authorized_at
    && Date.now() - new Date(challenge.management_authorized_at).getTime() <= app.config.otpTtlMinutes * 60_000;
  if (recentlyAuthorized && challenge.purpose === 'device_replace') {
    return { kind: 'management', accessId: challenge.access_id, challenge };
  }
  return null;
}

async function listDevices(db, accessId) {
  const result = await db.query(
    `SELECT id, label, status, created_at, last_seen_at, revoked_at
     FROM devices
     WHERE access_id = $1
     ORDER BY (status = 'active') DESC, last_seen_at DESC`,
    [accessId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at
  }));
}

export async function deviceRoutes(app) {
  app.get('/api/devices', async (request, reply) => {
    const context = await authorizationContext(app, request);
    if (!context) return reply.code(401).send({ ok: false, message: 'Sesión no válida.' });
    const devices = await listDevices(app.db, context.accessId);
    return reply.send({
      ok: true,
      mode: context.kind,
      devices: devices.map((device) => ({
        ...device,
        current: context.kind === 'session' && device.id === context.auth.device_id
      }))
    });
  });

  app.post('/api/device/revoke', async (request, reply) => {
    if (!assertCsrf(request, app.config)) {
      return reply.code(403).send({ ok: false, message: 'Solicitud no válida.' });
    }
    const deviceId = String(request.body?.deviceId ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
      return reply.code(400).send({ ok: false, message: 'Dispositivo no válido.' });
    }
    const context = await authorizationContext(app, request);
    if (!context) return reply.code(401).send({ ok: false, message: 'Sesión no válida.' });

    if (context.kind === 'management') {
      const result = await withTransaction(app.db, async (db) => {
        const challenge = await getActivation(db, request, app.config, { forUpdate: true });
        if (!challenge?.management_authorized_at || challenge.purpose !== 'device_replace') return null;
        await db.query('SELECT id FROM accesses WHERE id = $1 FOR UPDATE', [challenge.access_id]);
        const target = await db.query(
          `SELECT id FROM devices
           WHERE id = $1 AND access_id = $2 AND status = 'active'
           FOR UPDATE`,
          [deviceId, challenge.access_id]
        );
        if (!target.rows[0]) return null;
        await db.query(
          `UPDATE devices SET status = 'revoked', revoked_at = now(), revoked_reason = 'buyer_replacement'
           WHERE id = $1`,
          [deviceId]
        );
        await db.query(
          `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = 'device_revoked'
           WHERE device_id = $1`,
          [deviceId]
        );
        await recordSecurityEvent(db, {
          accessId: challenge.access_id,
          deviceId,
          eventType: 'device_replaced_by_buyer',
          riskPoints: RISK.DEVICE_REPLACEMENT,
          ipHash: ipHash(request, app.config),
          country: countryCode(request)
        });
        return createNewDeviceAndSession(db, app, request, challenge);
      });
      if (!result) return reply.code(400).send({ ok: false, message: 'No se ha podido cambiar el dispositivo.' });
      setAuthenticatedCookies(reply, app.config, result);
      reply.clearCookie(cookieNames(app.config).activation, cookieOptions(app.config));
      return reply.send({ ok: true, redirect: '/academy' });
    }

    const isCurrent = context.auth.device_id === deviceId;
    const revoked = await withTransaction(app.db, async (db) => {
      const target = await db.query(
        `SELECT id FROM devices
         WHERE id = $1 AND access_id = $2 AND status = 'active'
         FOR UPDATE`,
        [deviceId, context.accessId]
      );
      if (!target.rows[0]) return false;
      await db.query(
        `UPDATE devices SET status = 'revoked', revoked_at = now(), revoked_reason = 'buyer_revoked'
         WHERE id = $1`,
        [deviceId]
      );
      await db.query(
        `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = 'device_revoked'
         WHERE device_id = $1`,
        [deviceId]
      );
      await recordSecurityEvent(db, {
        accessId: context.accessId,
        deviceId,
        sessionId: context.auth.session_id,
        eventType: 'device_revoked_by_buyer',
        ipHash: ipHash(request, app.config),
        country: countryCode(request)
      });
      return true;
    });
    if (!revoked) return reply.code(404).send({ ok: false, message: 'Dispositivo no encontrado.' });
    if (isCurrent) clearAuthenticatedCookies(reply, app.config, { clearDevice: true });
    return reply.send({ ok: true, loggedOut: isCurrent });
  });
}
