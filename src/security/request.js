import { keyedHash, randomToken, safeEqualText } from './crypto.js';

export function cookieNames(config) {
  const prefix = config.cookieSecure
    ? (config.cookieDomain ? '__Secure-' : '__Host-')
    : '';
  return {
    session: `${prefix}ae_session`,
    device: `${prefix}ae_device`,
    activation: `${prefix}ae_activation`,
    admin: `${prefix}ae_admin`,
    anonymous: `${prefix}ae_anon`,
    csrf: `${prefix}ae_csrf`
  };
}

export function cookieOptions(config, { httpOnly = true, maxAge, sameSite = 'lax' } = {}) {
  const options = {
    path: '/',
    httpOnly,
    secure: config.cookieSecure,
    sameSite,
    maxAge
  };
  if (config.cookieDomain) options.domain = config.cookieDomain;
  return options;
}

export function ensureAnonymousCookie(request, reply, config) {
  const names = cookieNames(config);
  const current = request.cookies[names.anonymous];
  if (current) return current;
  const token = randomToken(24);
  reply.setCookie(names.anonymous, token, cookieOptions(config, {
    maxAge: 60 * 60 * 24 * 30,
    sameSite: 'lax'
  }));
  request.cookies[names.anonymous] = token;
  return token;
}

export function clearCookie(reply, name, config) {
  reply.clearCookie(name, cookieOptions(config, { maxAge: 0 }));
}

export function clientIp(request) {
  return String(request.ip || request.socket?.remoteAddress || 'unknown').slice(0, 128);
}

export function ipHash(request, config) {
  return keyedHash(config.codePepper, 'ip-address', clientIp(request));
}

export function countryCode(request) {
  for (const header of ['cf-ipcountry', 'x-vercel-ip-country', 'x-country-code']) {
    const value = request.headers[header];
    if (typeof value === 'string' && /^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  }
  return null;
}

export function safeUserAgent(request) {
  return String(request.headers['user-agent'] || 'Unknown device').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500);
}

export function deviceLabel(userAgent) {
  const value = userAgent.toLowerCase();
  let device = 'Dispositivo';
  let browser = '';
  if (value.includes('iphone')) device = 'iPhone';
  else if (value.includes('ipad')) device = 'iPad';
  else if (value.includes('android')) device = value.includes('mobile') ? 'Android' : 'Tablet Android';
  else if (value.includes('macintosh') || value.includes('mac os')) device = 'Mac';
  else if (value.includes('windows')) device = 'PC Windows';
  else if (value.includes('linux')) device = 'Equipo Linux';

  if (value.includes('edg/')) browser = 'Edge';
  else if (value.includes('firefox/')) browser = 'Firefox';
  else if (value.includes('crios/') || value.includes('chrome/')) browser = 'Chrome';
  else if (value.includes('safari/')) browser = 'Safari';
  return browser ? `${device} · ${browser}` : device;
}

export function requestActor(request, config) {
  const names = cookieNames(config);
  for (const [kind, name] of [
    ['session', names.session],
    ['device', names.device],
    ['activation', names.activation],
    ['anonymous', names.anonymous]
  ]) {
    const token = request.cookies[name];
    if (token) return `${kind}:${keyedHash(config.sessionSecret, `actor-${kind}`, token)}`;
  }
  return `fallback:${keyedHash(config.sessionSecret, 'actor-fallback', `${clientIp(request)}\0${safeUserAgent(request)}`)}`;
}

export function assertSameOrigin(request, config) {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') return false;

  const origin = request.headers.origin;
  if (!origin) return config.nodeEnv !== 'production';

  try {
    const requestOrigin = new URL(origin).origin;
    const allowedOrigins = [
      config.appOrigin,
      'https://acceso.academiaemilio.es',
      'https://admin.academiaemilio.es'
    ].filter(Boolean);

    return allowedOrigins.some((allowedOrigin) => {
      try {
        return safeEqualText(requestOrigin, new URL(allowedOrigin).origin);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function assertCsrf(request, config) {
  if (!assertSameOrigin(request, config)) return false;
  const name = cookieNames(config).csrf;
  const cookieToken = request.cookies[name];
  const headerToken = request.headers['x-csrf-token'];
  return Boolean(cookieToken && typeof headerToken === 'string' && safeEqualText(cookieToken, headerToken));
}
