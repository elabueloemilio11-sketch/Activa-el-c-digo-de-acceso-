import { withTransaction } from '../db.js';
import { normalizeEmail, safeEqualText, keyedHash } from '../security/crypto.js';
import { cookieNames, cookieOptions, countryCode, ensureAnonymousCookie, ipHash } from '../security/request.js';
import { createSessionRecord, setAuthenticatedCookies, setCsrfCookie } from '../services/session.js';
import { evaluateVelocityRisk, recordSecurityEvent, RISK } from '../services/risk.js';
import { getActivation, createNewDeviceAndSession, ACCESS_DENIED } from './access.js';

export async function directAccessRoutes(app) {
  app.post('/api/access/direct', async (request, reply) => {
    ensureAnonymousCookie(request, reply, app.config);

    const challenge = await getActivation(app.db, request, app.config);
    const email = normalizeEmail(request.body?.email);

    if (!challenge || !email || !['issued', 'active'].includes(challenge.access_status)) {
      return reply.code(401).send({ ok: false, message: ACCESS_DENIED });
    }

    if (!safeEqualText(email, challenge.customer_email)) {
      await recordSecurityEvent(app.db, {
        accessId: challenge.access_id,
        eventType: 'buyer_email_rejected',
        riskPoints: RISK.INVALID_EMAIL,
        ipHash: ipHash(request, app.config),
        country: countryCode(request)
      });
      return reply.code(401).send({ ok: false, message: ACCESS_DENIED });
    }

    const names = cookieNames(app.config);
    const existingDeviceToken = request.cookies[names.device];

    if (existingDeviceToken) {
      const existing = await app.db.query(
        `SELECT id FROM devices
         WHERE access_id = $1 AND token_hash = $2 AND status = 'active' LIMIT 1`,
        [
          challenge.access_id,
          keyedHash(app.config.sessionSecret, 'device-token', existingDeviceToken)
        ]
      );

      if (existing.rows[0]) {
        const result = await withTransaction(app.db, async (db) => {
          await db.query('SELECT id FROM accesses WHERE id = $1 FOR UPDATE', [challenge.access_id]);
          const session = await createSessionRecord(db, app.config, request, {
            accessId: challenge.access_id,
            deviceId: existing.rows[0].id
          });
          await db.query('UPDATE activation_challenges SET consumed_at = now() WHERE id = $1', [challenge.id]);
          await db.query(
            `UPDATE accesses SET status = 'active', activated_at = COALESCE(activated_at, now()),
               last_used_at = now() WHERE id = $1`,
            [challenge.access_id]
          );
          return session;
        });

        setAuthenticatedCookies(reply, app.config, {
          sessionToken: result.sessionToken,
          deviceToken: existingDeviceToken
        });
        reply.clearCookie(names.activation, cookieOptions(app.config));
        await evaluateVelocityRisk(app.db, {
          accessId: challenge.access_id,
          ipHash: ipHash(request, app.config),
          country: countryCode(request)
        });
        return reply.send({ ok: true, next: 'academy', redirect: '/academy' });
      }
    }

    const outcome = await withTransaction(app.db, async (db) => {
      const current = await getActivation(db, request, app.config, { forUpdate: true });
      if (!current) return { denied: true };

      await db.query('SELECT id FROM accesses WHERE id = $1 FOR UPDATE', [current.access_id]);

      const count = await db.query(
        `SELECT count(*)::int AS count FROM devices
         WHERE access_id = $1 AND status = 'active'`,
        [current.access_id]
      );

      if (Number(count.rows[0].count) >= Number(current.max_devices)) {
        await db.query(
          `UPDATE activation_challenges
           SET email_verified_at = now(), management_authorized_at = now(), purpose = 'device_replace'
           WHERE id = $1`,
          [current.id]
        );
        await recordSecurityEvent(db, {
          accessId: current.access_id,
          eventType: 'device_limit_reached',
          riskPoints: RISK.DEVICE_LIMIT,
          ipHash: ipHash(request, app.config),
          country: countryCode(request)
        });
        return { deviceLimit: true };
      }

      await db.query(
        `UPDATE activation_challenges SET email_verified_at = now(), purpose = 'activate' WHERE id = $1`,
        [current.id]
      );
      const session = await createNewDeviceAndSession(db, app, request, current);
      return { session };
    });

    if (outcome.denied) {
      return reply.code(401).send({ ok: false, message: ACCESS_DENIED });
    }

    if (outcome.deviceLimit) {
      setCsrfCookie(reply, app.config);
      return reply.code(409).send({
        ok: false,
        code: 'DEVICE_LIMIT',
        next: 'manage_devices',
        message: 'Has alcanzado el límite de dispositivos autorizados.'
      });
    }

    setAuthenticatedCookies(reply, app.config, outcome.session);
    reply.clearCookie(names.activation, cookieOptions(app.config));
    await evaluateVelocityRisk(app.db, {
      accessId: outcome.session.accessId,
      ipHash: ipHash(request, app.config),
      country: countryCode(request)
    });

    return reply.send({ ok: true, next: 'academy', redirect: '/academy' });
  });
}
