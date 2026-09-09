import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const ACCESS_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function normalizeEmail(email) {
  return String(email ?? '').trim().normalize('NFKC').toLowerCase();
}

export function normalizeAccessCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatAccessCode(normalizedCode) {
  const value = normalizeAccessCode(normalizedCode);
  if (!value.startsWith('AE')) return value;
  return ['AE', ...value.slice(2).match(/.{1,4}/g) ?? []].join('-');
}

export function isAccessCodeShapeValid(code) {
  return /^AE[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8,12}$/.test(normalizeAccessCode(code));
}

export function generateAccessCode(groups = 3) {
  let body = '';
  for (let index = 0; index < groups * 4; index += 1) {
    body += ACCESS_ALPHABET[randomInt(0, ACCESS_ALPHABET.length)];
  }
  return formatAccessCode(`AE${body}`);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function generateOtp() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export async function hashSlowSecret(value) {
  const salt = randomBytes(16);
  const derived = await scrypt(String(value), salt, 32, SCRYPT_OPTIONS);
  return `scrypt$v=1$N=${SCRYPT_OPTIONS.N},r=${SCRYPT_OPTIONS.r},p=${SCRYPT_OPTIONS.p}$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

export async function verifySlowSecret(value, encoded) {
  try {
    const [algorithm, version, parameters, saltText, hashText] = String(encoded).split('$');
    if (algorithm !== 'scrypt' || version !== 'v=1') return false;
    const parsed = Object.fromEntries(parameters.split(',').map((entry) => entry.split('=')));
    const options = {
      N: Number(parsed.N),
      r: Number(parsed.r),
      p: Number(parsed.p),
      maxmem: 64 * 1024 * 1024
    };
    const expected = Buffer.from(hashText, 'base64url');
    const actual = Buffer.from(await scrypt(String(value), Buffer.from(saltText, 'base64url'), expected.length, options));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function keyedHash(secret, purpose, value) {
  return createHmac('sha256', secret).update(`${purpose}\0${String(value)}`).digest('hex');
}

export function plainHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqualText(left, right) {
  const leftDigest = createHash('sha256').update(String(left)).digest();
  const rightDigest = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function encryptionKey(secret) {
  return createHash('sha256').update(`abuelo-emilio-academy\0${secret}`).digest();
}

export function encryptJson(value, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptJson(encoded, secret) {
  const [version, ivText, tagText, ciphertextText] = String(encoded).split('.');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) {
    throw new Error('Invalid encrypted payload.');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}
