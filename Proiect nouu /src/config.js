import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  APP_URL: z.string().url().default('http://localhost:3000'),
  ACADEMY_URL: z.string().default('/academy'),
  SHOPIFY_CHECKOUT_URL: z.string().url().optional().or(z.literal('')),
  SHOPIFY_STORE_DOMAIN: z.string().optional().default(''),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional().default(''),
  SHOPIFY_PRODUCT_VARIANT_IDS: z.string().optional().default(''),
  SESSION_SECRET: z.string().min(32),
  CODE_PEPPER: z.string().min(32),
  CODE_ENCRYPTION_KEY: z.string().min(32),
  EMAIL_PROVIDER: z.enum(['resend', 'smtp', 'console']).default('console'),
  EMAIL_FROM: z.string().optional().default(''),
  EMAIL_API_KEY: z.string().optional().default(''),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: booleanFromString,
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(12),
  MAX_DEVICES: z.coerce.number().int().min(1).max(10).default(2),
  MAX_SESSIONS: z.coerce.number().int().min(1).max(10).default(2),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  DEVICE_TTL_DAYS: z.coerce.number().int().min(30).max(1000).default(400),
  OTP_TTL_MINUTES: z.coerce.number().int().min(5).max(30).default(10),
  RECOVERY_TTL_MINUTES: z.coerce.number().int().min(10).max(60).default(20),
  COOKIE_DOMAIN: z.string().optional().default(''),
  TRUST_PROXY: z.enum(['true', 'false']).default('true').transform((value) => value === 'true')
});

function assertProductionConfig(env) {
  if (env.NODE_ENV !== 'production') return;

  const missing = [];
  for (const key of [
    'SHOPIFY_CHECKOUT_URL',
    'SHOPIFY_STORE_DOMAIN',
    'SHOPIFY_WEBHOOK_SECRET',
    'SHOPIFY_PRODUCT_VARIANT_IDS',
    'EMAIL_FROM'
  ]) {
    if (!env[key]) missing.push(key);
  }

  if (env.EMAIL_PROVIDER === 'resend' && !env.EMAIL_API_KEY) missing.push('EMAIL_API_KEY');
  if (env.EMAIL_PROVIDER === 'smtp') {
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']) {
      if (!env[key]) missing.push(key);
    }
  }
  if (env.EMAIL_PROVIDER === 'console') {
    throw new Error('EMAIL_PROVIDER=console is forbidden in production.');
  }
  if (env.ADMIN_PASSWORD.length < 16) {
    throw new Error('ADMIN_PASSWORD must contain at least 16 characters in production.');
  }
  if (missing.length) {
    throw new Error(`Missing production environment variables: ${[...new Set(missing)].join(', ')}`);
  }
}

export function loadConfig(source = process.env) {
  const env = schema.parse(source);
  assertProductionConfig(env);

  const appOrigin = new URL(env.APP_URL).origin;
  if (env.NODE_ENV === 'production' && !appOrigin.startsWith('https://')) {
    throw new Error('APP_URL must use HTTPS in production.');
  }
  if (env.NODE_ENV === 'production' && env.SHOPIFY_CHECKOUT_URL && !env.SHOPIFY_CHECKOUT_URL.startsWith('https://')) {
    throw new Error('SHOPIFY_CHECKOUT_URL must use HTTPS in production.');
  }
  if (env.NODE_ENV === 'production' && env.SHOPIFY_WEBHOOK_SECRET.length < 16) {
    throw new Error('SHOPIFY_WEBHOOK_SECRET is too short.');
  }
  const academyUrl = env.ACADEMY_URL.startsWith('/')
    ? env.ACADEMY_URL
    : new URL(env.ACADEMY_URL).pathname;
  const academyOrigin = env.ACADEMY_URL.startsWith('/') ? appOrigin : new URL(env.ACADEMY_URL).origin;
  if (academyOrigin !== appOrigin || academyUrl !== '/academy') {
    throw new Error('ACADEMY_URL must resolve to the protected /academy route on APP_URL.');
  }
  const storeDomain = env.SHOPIFY_STORE_DOMAIN
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');

  if (storeDomain && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(storeDomain)) {
    throw new Error('SHOPIFY_STORE_DOMAIN must look like store-name.myshopify.com.');
  }

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    appUrl: env.APP_URL.replace(/\/$/, ''),
    appOrigin,
    academyUrl,
    shopifyCheckoutUrl: env.SHOPIFY_CHECKOUT_URL || '',
    shopifyStoreDomain: storeDomain,
    shopifyWebhookSecret: env.SHOPIFY_WEBHOOK_SECRET,
    shopifyProductVariantIds: new Set(
      env.SHOPIFY_PRODUCT_VARIANT_IDS.split(',').map((value) => value.trim()).filter(Boolean)
    ),
    sessionSecret: env.SESSION_SECRET,
    codePepper: env.CODE_PEPPER,
    codeEncryptionKey: env.CODE_ENCRYPTION_KEY,
    emailProvider: env.EMAIL_PROVIDER,
    emailFrom: env.EMAIL_FROM,
    emailApiKey: env.EMAIL_API_KEY,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD
    },
    adminUsername: env.ADMIN_USERNAME,
    adminPassword: env.ADMIN_PASSWORD,
    maxDevices: env.MAX_DEVICES,
    maxSessions: env.MAX_SESSIONS,
    sessionTtlDays: env.SESSION_TTL_DAYS,
    deviceTtlDays: env.DEVICE_TTL_DAYS,
    otpTtlMinutes: env.OTP_TTL_MINUTES,
    recoveryTtlMinutes: env.RECOVERY_TTL_MINUTES,
    cookieDomain: env.COOKIE_DOMAIN || undefined,
    cookieSecure: env.NODE_ENV === 'production' || appOrigin.startsWith('https://'),
    trustProxy: env.TRUST_PROXY
  });
}
