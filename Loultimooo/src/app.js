import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { createDatabase } from './db.js';
import { hashSlowSecret, randomToken } from './security/crypto.js';
import {
  assertCsrf,
  assertSameOrigin,
  ensureAnonymousCookie
} from './security/request.js';
import { createMailer } from './services/email.js';
import { startOutboxWorker } from './services/outbox.js';
import { cleanExpiredRateLimits } from './services/rate-limit.js';
import {
  authenticateRequest,
  clearAuthenticatedCookies,
  revokeSession
} from './services/session.js';
import { accessRoutes } from './routes/access.js';
import { deviceRoutes } from './routes/devices.js';
import { adminRoutes } from './routes/admin.js';
import { webhookRoutes } from './routes/webhooks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicFiles = new Map([
  ['/assets/styles.css', ['public/assets/styles.css', 'text/css; charset=utf-8']],
  ['/assets/access.js', ['public/assets/access.js', 'text/javascript; charset=utf-8']],
  ['/assets/recover.js', ['public/assets/recover.js', 'text/javascript; charset=utf-8']],
  ['/assets/admin.js', ['public/assets/admin.js', 'text/javascript; charset=utf-8']]
]);

async function loadUi() {
  const entries = await Promise.all([
    Promise.all(['access', readFile(path.join(root, 'public/access.html'), 'utf8')]),
    Promise.all(['recover', readFile(path.join(root, 'public/recover.html'), 'utf8')]),
    Promise.all(['admin', readFile(path.join(root, 'public/admin.html'), 'utf8')]),
    Promise.all(['course', readFile(path.join(root, 'protected/course.html'), 'utf8')]),
    Promise.all(['courseScript', readFile(path.join(root, 'public/assets/course.js'))]),
    ...[...publicFiles].map(async ([url, [relative, type]]) => [url, await readFile(path.join(root, relative)), type])
  ]);
  return new Map(entries.map(([key, value, type]) => [key, { value, type }]));
}

export async function buildApp({ config, db, mailer: injectedMailer, outboxEnabled = true, logger = true } = {}) {
  if (!config) throw new Error('A validated config object is required.');
  const pool = db ?? createDatabase(config);
  const app = Fastify({
    logger: logger ? {
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'req.headers.x-shopify-hmac-sha256',
          'res.headers.set-cookie',
          'body.code',
          'body.otp',
          'body.password',
          'body.token'
        ],
        censor: '[REDACTED]'
      }
    } : false,
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
    requestTimeout: 15_000
  });
  const ui = await loadUi();
  const mailer = injectedMailer ?? createMailer(config);

  app.decorate('config', config);
  app.decorate('db', pool);
  app.decorate('mailer', mailer);
  app.decorate('dummyCodeHash', await hashSlowSecret(randomToken(32)));

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body;
    try {
      done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
    } catch (error) {
      error.statusCode = 400;
      done(error);
    }
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"]
      }
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'POST' && request.url.startsWith('/api/') && !assertSameOrigin(request, config)) {
      return reply.code(403).send({ ok: false, message: 'Solicitud no válida.' });
    }
  });

  app.get('/health', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return reply.send({ status: 'ok' });
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.get('/', async (_request, reply) => reply.redirect('/access'));
  app.get('/access', async (request, reply) => {
    ensureAnonymousCookie(request, reply, config);
    const auth = await authenticateRequest(pool, request, config);
    if (auth) return reply.redirect('/academy');
    return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(ui.get('access').value);
  });
  app.get('/recover', async (request, reply) => {
    ensureAnonymousCookie(request, reply, config);
    return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(ui.get('recover').value);
  });
  app.get('/admin', async (request, reply) => {
    ensureAnonymousCookie(request, reply, config);
    return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(ui.get('admin').value);
  });
  app.get('/academy', async (request, reply) => {
    const auth = await authenticateRequest(pool, request, config);
    if (!auth) return reply.redirect('/access');
    return reply.header('cache-control', 'private, no-store').type('text/html; charset=utf-8').send(ui.get('course').value);
  });
  app.get('/academy/assets/course.js', async (request, reply) => {
    const auth = await authenticateRequest(pool, request, config);
    if (!auth) return reply.code(401).send('Unauthorized');
    return reply
      .header('cache-control', 'private, no-store')
      .type('text/javascript; charset=utf-8')
      .send(ui.get('courseScript').value);
  });

  for (const [url, [, type]] of publicFiles) {
    app.get(url, async (_request, reply) => {
      const asset = ui.get(url);
      return reply.header('cache-control', 'public, max-age=300').type(type).send(asset.value);
    });
  }

  app.get('/api/public-config', async (_request, reply) => reply.send({
    ok: true,
    checkoutUrl: config.shopifyCheckoutUrl
  }));

  app.get('/api/session', async (request, reply) => {
    const auth = await authenticateRequest(pool, request, config);
    if (!auth) return reply.code(401).send({ ok: false, authenticated: false });
    return reply.send({
      ok: true,
      authenticated: true,
      email: auth.customer_email.replace(/^(.{1,2}).*(@.*)$/, '$1***$2'),
      device: auth.device_label,
      suspicious: auth.suspicious
    });
  });

  app.post('/logout', async (request, reply) => {
    if (!assertCsrf(request, config)) return reply.code(403).send({ ok: false, message: 'Solicitud no válida.' });
    await revokeSession(pool, request, config, 'buyer_logout');
    clearAuthenticatedCookies(reply, config);
    return reply.send({ ok: true });
  });

  await accessRoutes(app);
  await deviceRoutes(app);
  await adminRoutes(app);
  await webhookRoutes(app);

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/webhooks/')) {
      return reply.code(404).send({ ok: false, message: 'No encontrado.' });
    }
    return reply.redirect('/access');
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ error: error.message }, 'Request failed');
    if (reply.sent) return;
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    return reply.code(status).send({
      ok: false,
      message: status >= 500 ? 'Ha ocurrido un error. Inténtalo de nuevo.' : error.message
    });
  });

  let stopOutbox = null;
  let maintenanceTimer = null;
  app.addHook('onReady', async () => {
    if (outboxEnabled) stopOutbox = startOutboxWorker({ pool, config, mailer, logger: app.log });
    maintenanceTimer = setInterval(() => {
      void Promise.all([
        cleanExpiredRateLimits(pool),
        pool.query(`DELETE FROM activation_challenges WHERE expires_at < now() - interval '7 days'`),
        pool.query(`DELETE FROM recovery_tokens WHERE COALESCE(used_at, expires_at) < now() - interval '30 days'`),
        pool.query(`DELETE FROM admin_sessions WHERE expires_at < now() - interval '30 days'`),
        pool.query(`DELETE FROM email_outbox WHERE status IN ('sent', 'failed') AND created_at < now() - interval '30 days'`)
      ]).catch((error) => app.log.error({ error: error.message }, 'Maintenance task failed'));
    }, 60 * 60 * 1000);
    maintenanceTimer.unref();
  });
  app.addHook('onClose', async () => {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    if (stopOutbox) await stopOutbox();
    await mailer.close();
    if (!db) await pool.end();
  });

  return app;
}
