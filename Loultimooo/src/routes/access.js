import { withTransaction } from '../db.js';
import {
  isAccessCodeShapeValid,
  keyedHash,
  normalizeAccessCode,
  normalizeEmail,
  randomToken,
  safeEqualText,
  verifySlowSecret
} from '../security/crypto.js';
import {
  cookieNames,
  cookieOptions,
  countryCode,
  deviceLabel,
  ensureAnonymousCookie,
  ipHash,
  safeUserAgent
} from '../security/request.js';
import { enforceRateLimit } from '../services/rate-limit.js';
import { evaluateVelocityRisk, recordSecurityEvent, RISK } from '../services/risk.js';
import { createSessionRecord, setAuthenticatedCookies } from '../services/session.js';

const ACCESS_DENIED = 'No hemos podido validar tus datos de acceso.';

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

function setActivationCookie(reply, config, token) {
  reply.setCookie(
    cookieNames(config).activation,
    token,
    cookieOptions(config, { maxAge: 15 * 60, sameSite: 'lax' })
  );
}

function clearActivationCookie(reply, config) {
  reply.clearCookie(cookieNames(config).activation, cookieOptions(config));
}

async function getActivation(db, request, config, { forUpdate = false } = {}) {
  const token = request.cookies[cookieNames(config).activation];
  if (!token) return null;
  const suffix = forUpdate ? ' FOR UPDATE OF c, a' : '';
  const result = await db.query(
    `SELECT c.*, a.customer_email, a.status AS access_status, a.max_devices
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

async function createDeviceAndSession(db, app, request, challenge) {
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
      challenge.access_id,
      keyedHash(app.config.sessionSecret, 'device-token', deviceToken),
      deviceLabel(ua),
      ua,
      currentIpHash,
      country
    ]
  );

  const deviceId = device.rows[0].id;
  const session = await createSessionRecord(db, app.config, request, {
    accessId: challenge.access_id,
    deviceId
  });

  await db.query(
    `UPDATE accesses
        SET status = 'active',
            activated_at = COALESCE(activated_at, now()),
            last_used_at = now(),
            activation_count = activation_count + 1
      WHERE id = $1`,
    [challenge.access_id]
  );

  await db.query(
    'UPDATE activation_challenges SET consumed_at = now(), email_verified_at = now(), otp_hash = NULL WHERE id = $1',
    [challenge.id]
  );

  await recordSecurityEvent(db, {
    accessId: challenge.access_id,
    deviceId,
    sessionId: session.sessionId,
    eventType: 'device_authorized',
    riskPoints: RISK.NEW_DEVICE,
    ipHash: currentIpHash,
    country,
    metadata: { label: deviceLabel(ua), verification: 'access_code_and_email' }
  });

  return { accessId: challenge.access_id, deviceId, deviceToken, ...session };
}

export async function accessRoutes(app) {
  app.post('/api/access/validate', async (request, reply) => {
    ensureAnonymousCookie(request, reply, app.config);
    if (!await applyRateLimit(app, request, reply, 'validate')) return;

    const normalizedCode = normalizeAccessCode(request.body?.code);
    let access = null;

    if (isAccessCodeShapeValid(normalizedCode)) {
      const result = await app.db.query(
        `SELECT id, access_code_hash, status
           FROM accesses
          WHERE access_code_lookup = $1
          LIMIT 1`,
        [keyedHash(app.config.codePepper, 'access-code-lookup', normalizedCode)]
      );
      access = result.rows[0] ?? null;
    }

    const hashToVerify = access?.access_code_hash ?? app.dummyCodeHash;
    const hashMatches = await verifySlowSecret(normalizedCode || 'invalid', hashToVerify);

    if (!access || !hashMatches || !['issued', 'active'].includes(access.status)) {
      await recordSecurityEvent(app.db, {
        eventType: 'access_code_rejected',
        ipHash: ipHash(request, app.config),
        country: countryCode(request),
        metadata: { shapedLikeCode: isAccessCodeShapeValid(normalizedCode) }
      });
      return reply.code(401).send({ ok: false, message: ACCESS_DENIED });
    }

    const token = randomToken(32);
    await app.db.query(
      `INSERT INTO activation_challenges
         (token_hash, access_id, ip_hash, country, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '15 minutes')`,
      [
        keyedHash(app.config.sessionSecret, 'activation-token', token),
        access.id,
        ipHash(request, app.config),
        countryCode(request),
        safeUserAgent(request)
      ]
    );

    setActivationCookie(reply, app.config, token);
    return reply.send({ ok: true, next: 'email' });
  });

  const verifyEmailHandler = async (request, reply) => {
    ensureAnonymousCookie(request, reply, app.config);
    if (!await applyRateLimit(app, request, reply, 'activate')) return;

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
        `SELECT id
           FROM devices
          WHERE access_id = $1
            AND token_hash = $2
            AND status = 'active'
          LIMIT 1`,
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
          await db.query(
            'UPDATE activation_challenges SET consumed_at = now(), email_verified_at = now() WHERE id = $1',
            [challenge.id]
          );
          await db.query(
            `UPDATE accesses
                SET status = 'active',
                    activated_at = COALESCE(activated_at, now()),
                    last_used_at = now()
              WHERE id = $1`,
            [challenge.access_id]
          );
          return session;
        });

        setAuthenticatedCookies(reply, app.config, {
          sessionToken: result.sessionToken,
          deviceToken: existingDeviceToken
        });
        clearActivationCookie(reply, app.config);
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
        `SELECT count(*)::int AS count
           FROM devices
          WHERE access_id = $1 AND status = 'active'`,
        [current.access_id]
      );

      if (Number(count.rows[0].count) >= Number(current.max_devices)) {
        return { deviceLimit: true };
      }

      const session = await createDeviceAndSession(db, app, request, current);
      return { session };
    });

    if (outcome.denied) {
      return reply.code(401).send({ ok: false, message: ACCESS_DENIED });
    }

    if (outcome.deviceLimit) {
      return reply.code(409).send({
        ok: false,
        code: 'DEVICE_LIMIT',
        message: 'Has alcanzado el límite de dispositivos autorizados. Contacta con soporte para reemplazar un dispositivo.'
      });
    }

    setAuthenticatedCookies(reply, app.config, outcome.session);
    clearActivationCookie(reply, app.config);

    await evaluateVelocityRisk(app.db, {
      accessId: outcome.session.accessId,
      ipHash: ipHash(request, app.config),
      country: countryCode(request)
    });

    return reply.send({ ok: true, next: 'academy', redirect: '/academy' });
  };

  app.post('/api/access/activate', verifyEmailHandler);
  app.post('/api/access/verify-email', verifyEmailHandler);

  // OTP is intentionally disabled: access code + buyer email are sufficient.
  app.post('/api/access/otp', async (_request, reply) => {
    return reply.code(410).send({ ok: false, message: 'La verificación por código de 6 cifras ya no es necesaria.' });
  });

  app.post('/api/access/verify-otp', async (_request, reply) => {
    return reply.code(410).send({ ok: false, message: 'La verificación por código de 6 cifras ya no es necesaria.' });
  });
}
