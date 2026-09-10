import { withTransaction } from '../db.js';
import {
  isAccessCodeShapeValid,
  keyedHash,
  normalizeAccessCode,
  randomToken,
  verifySlowSecret
} from '../security/crypto.js';
import {
  cookieNames,
  countryCode,
  deviceLabel,
  ensureAnonymousCookie,
  ipHash,
  safeUserAgent
} from '../security/request.js';
import { enforceRateLimit } from '../services/rate-limit.js';
import { evaluateVelocityRisk, recordSecurityEvent, RISK } from '../services/risk.js';
import { createSessionRecord, setAuthenticatedCookies } from '../services/session.js';

const ACCESS_DENIED = 'Código de acceso no válido.';

async function applyRateLimit(app, request, reply, bucket) {
  const result = await enforceRateLimit(app.db, request, app.config, bucket);
  reply.header('x-ratelimit-remaining', String(result.remaining));
  if (!result.allowed) {
    reply.header('retry-after', String(result.retryAfterSeconds));
    reply.code(429).send({
      ok: false,
      message: 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.'
    });
    return false;
  }
  return true;
}

export async function getActivation(db, request, config, { forUpdate = false } = {}) {
  const token = request.cookies?.[cookieNames(config).activation];
  if (!token) return null;

  const suffix = forUpdate ? ' FOR UPDATE OF c, a' : '';
  const result = await db.query(
    `SELECT c.*, a.customer_email, a.status AS access_status, a.max_devices,
            a.risk_score, a.suspicious
       FROM activation_challenges c
       JOIN accesses a ON a.id = c.access_id
      WHERE c.token_hash = $1
        AND c.consumed_at IS NULL
        AND c.expires_at > now()
        AND a.status IN ('issued', 'active')
      LIMIT 1${suffix}`,
    [keyedHash(config.sessionSecret, 'activation-token', token)]
  );

  return result.rows[0] ?? null;
}

export async function createNewDeviceAndSession(db, app, request, challengeOrAccessId) {
  const accessId =
    typeof challengeOrAccessId === 'object' && challengeOrAccessId !== null
      ? challengeOrAccessId.access_id
      : challengeOrAccessId;

  const deviceToken = randomToken(32);
  const ua = safeUserAgent(request);
  const currentIpHash = ipHash(request, app.config);
  const country = countryCode(request);

  const device = await db.query(
    `INSERT INTO devices
       (access_id, token_hash, label, user_agent, last_ip_hash, last_country)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      accessId,
      keyedHash(app.config.sessionSecret, 'device-token', deviceToken),
      deviceLabel(ua),
      ua,
      currentIpHash,
      country
    ]
  );

  const deviceId = device.rows[0].id;

  const session = await createSessionRecord(db, app.config, request, {
    accessId,
    deviceId
  });

  await db.query(
    `UPDATE accesses
        SET status = 'active',
            activated_at = COALESCE(activated_at, now()),
            last_used_at = now(),
            activation_count = activation_count + 1
      WHERE id = $1`,
    [accessId]
  );

  if (challengeOrAccessId && typeof challengeOrAccessId === 'object' && challengeOrAccessId.id) {
    await db.query(
      `UPDATE activation_challenges
          SET consumed_at = now(),
              otp_hash = NULL
        WHERE id = $1`,
      [challengeOrAccessId.id]
    );
  }

  await recordSecurityEvent(db, {
    accessId,
    deviceId,
    sessionId: session.sessionId,
    eventType: 'device_authorized',
    riskPoints: RISK.NEW_DEVICE,
    ipHash: currentIpHash,
    country,
    metadata: {
      label: deviceLabel(ua),
      verification: 'access_code_only'
    }
  });

  return {
    accessId,
    deviceId,
    deviceToken,
    ...session
  };
}

export async function accessRoutes(app) {
  app.post('/api/access/validate', async (request, reply) => {
    ensureAnonymousCookie(request, reply, app.config);

    if (!await applyRateLimit(app, request, reply, 'validate')) return;

    const normalizedCode = normalizeAccessCode(request.body?.code);
    let access = null;

    if (isAccessCodeShapeValid(normalizedCode)) {
      const result = await app.db.query(
        `SELECT id, access_code_hash, status, max_devices
           FROM accesses
          WHERE access_code_lookup = $1
          LIMIT 1`,
        [keyedHash(app.config.codePepper, 'access-code-lookup', normalizedCode)]
      );

      access = result.rows[0] ?? null;
    }

    const hashToVerify = access?.access_code_hash ?? app.dummyCodeHash;
    const hashMatches = await verifySlowSecret(
      normalizedCode || 'invalid',
      hashToVerify
    );

    if (
      !access ||
      !hashMatches ||
      !['issued', 'active'].includes(access.status)
    ) {
      await recordSecurityEvent(app.db, {
        eventType: 'access_code_rejected',
        ipHash: ipHash(request, app.config),
        country: countryCode(request),
        metadata: {
          shapedLikeCode: isAccessCodeShapeValid(normalizedCode)
        }
      });

      return reply.code(401).send({
        ok: false,
        message: ACCESS_DENIED
      });
    }

    const names = cookieNames(app.config);
    const existingDeviceToken = request.cookies?.[names.device];

    if (existingDeviceToken) {
      const existing = await app.db.query(
        `SELECT id
           FROM devices
          WHERE access_id = $1
            AND token_hash = $2
            AND status = 'active'
          LIMIT 1`,
        [
          access.id,
          keyedHash(
            app.config.sessionSecret,
            'device-token',
            existingDeviceToken
          )
        ]
      );

      if (existing.rows[0]) {
        const session = await withTransaction(app.db, async (db) => {
          const created = await createSessionRecord(
            db,
            app.config,
            request,
            {
              accessId: access.id,
              deviceId: existing.rows[0].id
            }
          );

          await db.query(
            `UPDATE accesses
                SET status = 'active',
                    activated_at = COALESCE(activated_at, now()),
                    last_used_at = now()
              WHERE id = $1`,
            [access.id]
          );

          return created;
        });

        setAuthenticatedCookies(reply, app.config, {
          sessionToken: session.sessionToken,
          deviceToken: existingDeviceToken
        });

        await evaluateVelocityRisk(app.db, {
          accessId: access.id,
          ipHash: ipHash(request, app.config),
          country: countryCode(request)
        });

        return reply.send({
          ok: true,
          next: 'academy',
          redirect: '/academy'
        });
      }
    }

    const outcome = await withTransaction(app.db, async (db) => {
      await db.query(
        'SELECT id FROM accesses WHERE id = $1 FOR UPDATE',
        [access.id]
      );

      const count = await db.query(
        `SELECT count(*)::int AS count
           FROM devices
          WHERE access_id = $1
            AND status = 'active'`,
        [access.id]
      );

      if (
        Number(count.rows[0].count) >= Number(access.max_devices)
      ) {
        return { deviceLimit: true };
      }

      const session = await createNewDeviceAndSession(
        db,
        app,
        request,
        access.id
      );

      return { session };
    });

    if (outcome.deviceLimit) {
      return reply.code(409).send({
        ok: false,
        code: 'DEVICE_LIMIT',
        message: 'Has alcanzado el límite de dispositivos autorizados.'
      });
    }

    setAuthenticatedCookies(
      reply,
      app.config,
      outcome.session
    );

    await evaluateVelocityRisk(app.db, {
      accessId: access.id,
      ipHash: ipHash(request, app.config),
      country: countryCode(request)
    });

    return reply.send({
      ok: true,
      next: 'academy',
      redirect: '/academy'
    });
  });

  for (const path of [
    '/api/access/activate',
    '/api/access/verify-email',
    '/api/access/otp',
    '/api/access/verify-otp'
  ]) {
    app.post(path, async (_request, reply) => {
      return reply.code(410).send({
        ok: false,
        message: 'Este paso ya no es necesario. Introduce tu código de acceso.'
      });
    });
  }
}
