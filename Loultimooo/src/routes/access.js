import { withTransaction } from '../db.js';
import {
  encryptJson,
  formatAccessCode,
  generateAccessCode,
  generateOtp,
  hashSlowSecret,
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
import { enqueueEmail } from '../services/outbox.js';
import { evaluateVelocityRisk, recordSecurityEvent, RISK } from '../services/risk.js';
import { createSessionRecord, setAuthenticatedCookies, setCsrfCookie } from '../services/session.js';

const ACCESS_DENIED = 'No hemos podido validar tus datos de acceso.';
const GENERIC_RECOVERY = 'Si el email está asociado a una compra, recibirás un enlace de recuperación.';

async function applyRateLimit(app, request, reply, bucket) {
  const result = await enforceRateLimit(app.db, request, app.config, bucket);
  reply.header('x-ratelimit-remaining', String(result.remaining));
  if (!result.allowed) {
    reply.header('retry-after', String(result.retryAfterSeconds));
    reply.code(429).send({ ok: false, message: 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.' });
    return false;
  }
  return true;
}

function setActivationCookie(reply, config, token) {
  reply.setCookie(cookieNames(config).activation, token, cookieOptions(config, {
    maxAge: config.otpTtlMinutes * 60,
    sameSite: 'lax'
  }));
}

function clearActivationCookie(reply, config) {
  reply.clearCookie(cookieNames(config).activation, cookieOptions(config));
}

async function getActivation(db, request, config, { forUpdate = false } = {}) {
  const token = request.cookies[cookieNames(config).activation];
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

async function queueOtp(db, app, challenge, email) {
  const otp = generateOtp();
  const otpHash = keyedHash(app.config.codePepper, `otp:${challenge.id}`, otp);
  await db.query(
    `UPDATE email_outbox
     SET status = 'failed', encrypted_payload = NULL, last_error = 'superseded'
     WHERE access_id = $1 AND kind = 'otp' AND status = 'pending'`,
    [challenge.access_id]
  );
  await db.query(
    `UPDATE activation_challenges
     SET otp_hash = $2,
         otp_expires_at = now() + ($3::bigint * interval '1 minute'),
         expires_at = now() + ($3::bigint * interval '1 minute'),
         otp_attempts = 0,
         email_sent_at = now(),
         email_verified_at = COALESCE(email_verified_at, now())
     WHERE id = $1`,
    [challenge.id, otpHash, app.config.otpTtlMinutes]
  );
  await enqueueEmail(db, app.config, {
    kind: 'otp',
    to: email,
    accessId: challenge.access_id,
    payload: { otp, minutes: app.config.otpTtlMinutes }
  });
}

async function createNewDeviceAndSession(db, app, request, challenge) {
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
     SET status = 'active', activated_at = COALESCE(activated_at, now()),
         last_used_at = now(), activation_count = activation_count + 1
     WHERE id = $1`,
    [challenge.access_id]
  );
  await db.query('UPDATE activation_challenges SET consumed_at = now(), otp_hash = NULL WHERE id = $1', [challenge.id]);
  await recordSecurityEvent(db, {
    accessId: challenge.access_id,
    deviceId,
    sessionId: session.sessionId,
    eventType: 'device_authorized',
    riskPoints: RISK.NEW_DEVICE,
    ipHash: currentIpHash,
    country,
    metadata: { label: deviceLabel(ua) }
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
         FROM accesses WHERE access_code_lookup = $1 LIMIT 1`,
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
       VALUES ($1, $2, $3, $4, $5,
         now() + ($6::bigint * interval '1 minute'))`,
      [
        keyedHash(app.config.sessionSecret, 'activation-token', token),
        access.id,
        ipHash(request, app.config),
        countryCode(request),
        safeUserAgent(request),
        app.config.otpTtlMinutes
      ]
    );
    setActivationCookie(reply, app.config, token);
    return reply.send({ ok: true, next: 'email' });
  });

  const activateHandler = async (request, reply) => {
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
        clearActivationCookie(reply, app.config);
        await evaluateVelocityRisk(app.db, {
          accessId: challenge.access_id,
          ipHash: ipHash(request, app.config),
          country: countryCode(request)
        });
        return reply.send({ ok: true, next: 'academy', redirect: '/academy' });
      }
    }

    await withTransaction(app.db, async (db) => {
      const current = await getActivation(db, request, app.config, { forUpdate: true });
      if (!current) throw new Error('Activation challenge expired.');
      const count = await db.query(
        `SELECT count(*)::int AS count FROM devices
         WHERE access_id = $1 AND status = 'active'`,
        [current.access_id]
      );
      const atLimit = Number(count.rows[0].count) >= Number(current.max_devices);
      await db.query(
        `UPDATE activation_challenges SET purpose = $2, email_verified_at = now() WHERE id = $1`,
        [current.id, atLimit ? 'device_replace' : 'activate']
      );
      await queueOtp(db, app, current, current.customer_email);
    });
    return reply.send({ ok: true, next: 'otp', message: 'Te hemos enviado un código de verificación.' });
  };

  app.post('/api/access/activate', activateHandler);
  app.post('/api/access/verify-email', activateHandler);

  app.post('/api/access/otp', async (request, reply) => {
    ensureAnonymousCookie(request, reply, app.config);
    if (!await applyRateLimit(app, request, reply, 'sendOtp')) return;
    const result = await withTransaction(app.db, async (db) => {
      const challenge = await getActivation(db, request, app.config, { forUpdate: true });
      if (!challenge || !challenge.email_verified_at || challenge.consumed_at) return null;
      if (challenge.email_sent_at && Date.now() - new Date(challenge.email_sent_at).getTime() < 60_000) {
        return { tooSoon: true };
      }
      await queueOtp(db, app, challenge, challenge.customer_email);
      return { tooSoon: false };
    });
    if (!result) return reply.code(401).send({ ok: false, message: ACCESS_DENIED });
    if (result.tooSoon) {
      return reply.code(429).send({ ok: false, message: 'Espera un minuto antes de solicitar otro código.' });
    }
    return reply.send({ ok: true, message: 'Te hemos enviado un nuevo código.' });
  });

  app.post('/api/access/verify-otp', async (request, reply) => {
    ensureAnonymousCookie(request, reply, app.config);
    if (!await applyRateLimit(app, request, reply, 'verifyOtp')) return;
    const otp = String(request.body?.otp ?? '').replace(/\D/g, '').slice(0, 6);
    const outcome = await withTransaction(app.db, async (db) => {
      const challenge = await getActivation(db, request, app.config, { forUpdate: true });
      if (!challenge || !challenge.otp_hash || !challenge.email_verified_at) return { denied: true };
      if (challenge.otp_attempts >= 8 || new Date(challenge.otp_expires_at).getTime() <= Date.now()) {
        return { denied: true, expired: true };
      }
      const expected = keyedHash(app.config.codePepper, `otp:${challenge.id}`, otp);
      if (otp.length !== 6 || !safeEqualText(expected, challenge.otp_hash)) {
        await db.query('UPDATE activation_challenges SET otp_attempts = otp_attempts + 1 WHERE id = $1', [challenge.id]);
        await recordSecurityEvent(db, {
          accessId: challenge.access_id,
          eventType: 'otp_rejected',
          riskPoints: RISK.INVALID_OTP,
          ipHash: ipHash(request, app.config),
          country: countryCode(request)
        });
        return { denied: true };
      }

      await db.query(
        `UPDATE email_outbox
         SET status = 'failed', encrypted_payload = NULL, last_error = 'otp_consumed'
         WHERE access_id = $1 AND kind = 'otp' AND status = 'pending'`,
        [challenge.access_id]
      );

      await db.query('SELECT id FROM accesses WHERE id = $1 FOR UPDATE', [challenge.access_id]);
      const devices = await db.query(
        `SELECT count(*)::int AS count FROM devices
         WHERE access_id = $1 AND status = 'active'`,
        [challenge.access_id]
      );
      if (Number(devices.rows[0].count) >= Number(challenge.max_devices)) {
        await db.query(
          `UPDATE activation_challenges
           SET otp_hash = NULL, management_authorized_at = now(), purpose = 'device_replace'
           WHERE id = $1`,
          [challenge.id]
        );
        await recordSecurityEvent(db, {
          accessId: challenge.access_id,
          eventType: 'device_limit_reached',
          riskPoints: RISK.DEVICE_LIMIT,
          ipHash: ipHash(request, app.config),
          country: countryCode(request)
        });
        return { deviceLimit: true };
      }

      const session = await createNewDeviceAndSession(db, app, request, challenge);
      return { session };
    });

    if (outcome.denied) {
      return reply.code(401).send({
        ok: false,
        message: outcome.expired ? 'El código ha caducado. Solicita uno nuevo.' : ACCESS_DENIED
      });
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
    clearActivationCookie(reply, app.config);
    await evaluateVelocityRisk(app.db, {
      accessId: outcome.session.accessId,
      ipHash: ipHash(request, app.config),
      country: countryCode(request)
    });
    return reply.send({ ok: true, next: 'academy', redirect: '/academy' });
  });

  app.post('/api/access/recover', async (request, reply) => {
    ensureAnonymousCookie(request, reply, app.config);
    if (!await applyRateLimit(app, request, reply, 'recover')) return;
    const email = normalizeEmail(request.body?.email);
    if (email && email.includes('@')) {
      const result = await app.db.query(
        `SELECT id, customer_email
         FROM accesses
         WHERE customer_email = $1 AND status IN ('issued', 'active')
         ORDER BY created_at DESC LIMIT 1`,
        [email]
      );
      const access = result.rows[0];
      if (access) {
        const token = randomToken(32);
        await withTransaction(app.db, async (db) => {
          await db.query(
            `UPDATE recovery_tokens SET used_at = COALESCE(used_at, now())
             WHERE access_id = $1 AND used_at IS NULL`,
            [access.id]
          );
          await db.query(
            `INSERT INTO recovery_tokens
               (access_id, token_hash, expires_at, requested_ip_hash)
             VALUES ($1, $2, now() + ($3::bigint * interval '1 minute'), $4)`,
            [
              access.id,
              keyedHash(app.config.sessionSecret, 'recovery-token', token),
              app.config.recoveryTtlMinutes,
              ipHash(request, app.config)
            ]
          );
          await enqueueEmail(db, app.config, {
            kind: 'recovery',
            to: access.customer_email,
            accessId: access.id,
            payload: {
              recoveryUrl: `${app.config.appUrl}/recover#token=${token}`,
              minutes: app.config.recoveryTtlMinutes
            }
          });
          await recordSecurityEvent(db, {
            accessId: access.id,
            eventType: 'recovery_requested',
            riskPoints: RISK.RECOVERY,
            ipHash: ipHash(request, app.config),
            country: countryCode(request)
          });
        });
      }
    }
    return reply.send({ ok: true, message: GENERIC_RECOVERY });
  });

  app.post('/api/access/recover/confirm', async (request, reply) => {
    ensureAnonymousCookie(request, reply, app.config);
    if (!await applyRateLimit(app, request, reply, 'recoverConfirm')) return;
    const token = String(request.body?.token ?? '');
    const replacementCode = generateAccessCode();
    const normalized = normalizeAccessCode(replacementCode);
    const replacementHash = await hashSlowSecret(normalized);
    const outcome = await withTransaction(app.db, async (db) => {
      const result = await db.query(
        `SELECT r.*, a.customer_email
         FROM recovery_tokens r
         JOIN accesses a ON a.id = r.access_id
         WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now()
           AND a.status IN ('issued', 'active')
         LIMIT 1
         FOR UPDATE OF r, a`,
        [keyedHash(app.config.sessionSecret, 'recovery-token', token)]
      );
      const recovery = result.rows[0];
      if (!recovery) return null;
      await db.query('UPDATE recovery_tokens SET used_at = now() WHERE id = $1', [recovery.id]);
      await db.query(
        `UPDATE email_outbox
         SET status = 'failed', encrypted_payload = NULL, last_error = 'recovery_token_consumed'
         WHERE access_id = $1 AND kind = 'recovery' AND status = 'pending'`,
        [recovery.access_id]
      );
      await db.query(
        `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = 'access_recovery'
         WHERE access_id = $1`,
        [recovery.access_id]
      );
      await db.query(
        `UPDATE devices SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()),
           revoked_reason = 'access_recovery' WHERE access_id = $1 AND status = 'active'`,
        [recovery.access_id]
      );
      const ciphertext = encryptJson({ code: replacementCode }, app.config.codeEncryptionKey);
      await db.query(
        `UPDATE accesses
         SET access_code_hash = $2, access_code_lookup = $3, access_code_last4 = $4,
             access_code_ciphertext = $5, status = 'issued'
         WHERE id = $1`,
        [
          recovery.access_id,
          replacementHash,
          keyedHash(app.config.codePepper, 'access-code-lookup', normalized),
          normalized.slice(-4),
          ciphertext
        ]
      );
      await enqueueEmail(db, app.config, {
        kind: 'access_code',
        to: recovery.customer_email,
        accessId: recovery.access_id,
        payload: { code: formatAccessCode(normalized), accessUrl: `${app.config.appUrl}/access` }
      });
      await recordSecurityEvent(db, {
        accessId: recovery.access_id,
        eventType: 'access_code_rotated_after_recovery',
        riskPoints: 0,
        ipHash: ipHash(request, app.config),
        country: countryCode(request)
      });
      return { accessId: recovery.access_id };
    });
    if (!outcome) return reply.code(400).send({ ok: false, message: 'El enlace no es válido o ha caducado.' });
    clearActivationCookie(reply, app.config);
    return reply.send({ ok: true, message: 'Hemos enviado un nuevo código a tu email.' });
  });
}

export { ACCESS_DENIED, getActivation, createNewDeviceAndSession };
