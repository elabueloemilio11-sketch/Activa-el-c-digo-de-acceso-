import { createHmac, timingSafeEqual } from 'node:crypto';
import { withTransaction } from '../db.js';
import {
  decryptJson,
  encryptJson,
  generateAccessCode,
  hashSlowSecret,
  keyedHash,
  normalizeAccessCode,
  normalizeEmail,
  plainHash
} from '../security/crypto.js';
import { enqueueEmail } from '../services/outbox.js';

function validHmac(rawBody, received, secret) {
  if (!rawBody || typeof received !== 'string' || !secret) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('base64'));
  const actual = Buffer.from(received.trim());
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function webhookContext(request, config, expectedTopic) {
  const hmac = request.headers['x-shopify-hmac-sha256'];
  const topic = String(request.headers['x-shopify-topic'] || '').toLowerCase();
  const shopDomain = String(request.headers['x-shopify-shop-domain'] || '').toLowerCase();
  const webhookId = String(request.headers['x-shopify-webhook-id'] || '');
  if (!validHmac(request.rawBody, hmac, config.shopifyWebhookSecret)) return null;
  if (topic !== expectedTopic || shopDomain !== config.shopifyStoreDomain || !webhookId) return null;
  return { topic, shopDomain, webhookId, payloadHash: plainHash(request.rawBody) };
}

async function alreadyProcessed(pool, webhookId) {
  const result = await pool.query('SELECT 1 FROM webhook_events WHERE webhook_id = $1', [webhookId]);
  return Boolean(result.rows[0]);
}

async function recordWebhook(db, context, { orderId = null, outcome }) {
  await db.query(
    `INSERT INTO webhook_events
       (webhook_id, topic, shop_domain, payload_sha256, order_id, outcome)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (webhook_id) DO NOTHING`,
    [context.webhookId, context.topic, context.shopDomain, context.payloadHash, orderId, outcome]
  );
}

function orderContainsAcademyProduct(payload, config) {
  if (!config.shopifyProductVariantIds.size) return false;
  return Array.isArray(payload.line_items) && payload.line_items.some((item) => {
    const candidates = [item.variant_id, item.product_id, item.admin_graphql_api_id]
      .filter((value) => value !== null && value !== undefined)
      .map(String);
    return candidates.some((candidate) => config.shopifyProductVariantIds.has(candidate));
  });
}

export async function webhookRoutes(app) {
  app.post('/webhooks/shopify/order-paid', async (request, reply) => {
    const context = webhookContext(request, app.config, 'orders/paid');
    if (!context) return reply.code(401).send({ ok: false });
    if (await alreadyProcessed(app.db, context.webhookId)) return reply.send({ ok: true, duplicate: true });

    const order = request.body ?? {};
    const orderId = String(order.id ?? '');
    const email = normalizeEmail(order.email || order.contact_email || order.customer?.email);
    const paid = String(order.financial_status || '').toLowerCase() === 'paid';
    if (!orderId || !email || !paid || !orderContainsAcademyProduct(order, app.config)) {
      await recordWebhook(app.db, context, { orderId: orderId || null, outcome: 'ignored' });
      return reply.send({ ok: true, ignored: true });
    }

    const displayCode = generateAccessCode();
    const normalizedCode = normalizeAccessCode(displayCode);
    const codeHash = await hashSlowSecret(normalizedCode);
    const codeLookup = keyedHash(app.config.codePepper, 'access-code-lookup', normalizedCode);
    const ciphertext = encryptJson({ code: displayCode }, app.config.codeEncryptionKey);

    await withTransaction(app.db, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`shopify-order:${orderId}`]);
      let result = await db.query(
        `SELECT id, customer_email, access_code_ciphertext
         FROM accesses WHERE order_id = $1 FOR UPDATE`,
        [orderId]
      );
      let access = result.rows[0];
      let codeToSend = displayCode;
      if (!access) {
        result = await db.query(
          `INSERT INTO accesses
             (access_code_hash, access_code_lookup, access_code_last4,
              access_code_ciphertext, order_id, order_name, customer_email, max_devices)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, customer_email, access_code_ciphertext`,
          [
            codeHash,
            codeLookup,
            normalizedCode.slice(-4),
            ciphertext,
            orderId,
            String(order.name || order.order_number || '').slice(0, 100) || null,
            email,
            app.config.maxDevices
          ]
        );
        access = result.rows[0];
      } else if (access.access_code_ciphertext) {
        codeToSend = decryptJson(access.access_code_ciphertext, app.config.codeEncryptionKey).code;
      } else {
        codeToSend = null;
      }

      if (codeToSend) {
        const pending = await db.query(
          `SELECT 1 FROM email_outbox
           WHERE access_id = $1 AND kind = 'access_code' AND status IN ('pending', 'processing')
           LIMIT 1`,
          [access.id]
        );
        if (!pending.rows[0]) {
          await enqueueEmail(db, app.config, {
            kind: 'access_code',
            to: access.customer_email,
            accessId: access.id,
            payload: { code: codeToSend, accessUrl: `${app.config.appUrl}/access` }
          });
        }
      }
      await recordWebhook(db, context, { orderId, outcome: access ? 'access_issued' : 'ignored' });
    });
    return reply.send({ ok: true });
  });

}

export { validHmac };
