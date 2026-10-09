/**
 * Hashing and signing on Web Crypto (`globalThis.crypto.subtle`), which Node
 * ≥ 20, Deno, Bun and browsers all provide — so this package imports no
 * `node:` module.
 */

const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('Web Crypto (globalThis.crypto.subtle) is not available; Node ≥ 20 is required');
  return c.subtle;
}

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped, Dates as
 * ISO strings, bigints as strings, -0 as 0. Two equal values always produce
 * the same string, so hashes over it are stable.
 */
export function canonicalJson(value: unknown): string {
  return canon(value, new Set());
}

function canon(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    case 'object':
      break;
  }
  const obj = value as object;
  if (obj instanceof Date) return JSON.stringify(obj.toISOString());
  if (seen.has(obj)) throw new TypeError('canonicalJson: circular structure');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return `[${obj.map((v) => canon(v, seen)).join(',')}]`;
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined && typeof record[k] !== 'function' && typeof record[k] !== 'symbol')
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(record[k], seen)}`).join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', encoder.encode(text));
  return toHex(new Uint8Array(digest));
}

async function hmacKey(secret: string | Uint8Array): Promise<CryptoKey> {
  const raw = typeof secret === 'string' ? encoder.encode(secret) : secret;
  if (raw.byteLength < 16) throw new Error('HMAC secret must be at least 16 bytes');
  return subtle().importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacSha256(secret: string | Uint8Array, message: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(await subtle().sign('HMAC', key, encoder.encode(message)));
}

/** HMAC-SHA256 over raw bytes (a request body exactly as sent). */
export async function hmacSha256Bytes(secret: string | Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(await subtle().sign('HMAC', key, message as BufferSource));
}

/** Constant-time comparison for equal-length strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomBase64Url(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}
