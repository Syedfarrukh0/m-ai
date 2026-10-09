import { hmacSha256Bytes, timingSafeEqual, toHex } from './crypto.js';

/**
 * Signed requests between two servers — an app calling M.Ai (the wallet API)
 * and M.Ai calling an app (the licence check). The same HMAC as the webhooks,
 * with the method and path inside the signature, and a key id so each side
 * can hold two keys while one rotates.
 *
 * Each direction has its own keys: the app signs with the app's key, M.Ai
 * signs with M.Ai's key, so neither side's key can forge the other's calls.
 *
 * THE CANONICAL STRING — both sides must build exactly this:
 *
 *   "<t>.<METHOD>.<path>.<body>"
 *
 *   t       integer unix seconds, the same value as in the header
 *   METHOD  upper case: GET, POST…
 *   path    the path and query EXACTLY as sent on the wire — not re-encoded,
 *           not re-ordered (e.g. "/v1/wallets/abc/ledger?limit=50&cursor=x")
 *   body    the raw bytes of the body; empty for a GET
 *
 * The signature is HMAC-SHA256 over those bytes, as lower-case hex, sent as
 *   m-ai-key-id:    <key id>
 *   m-ai-signature: t=<t>,v1=<hex>
 * and accepted within 300 seconds of the receiver's clock.
 */

export const REQUEST_HEADERS = {
  keyId: 'm-ai-key-id',
  signature: 'm-ai-signature',
  idempotencyKey: 'idempotency-key',
} as const;

const encoder = new TextEncoder();

/** The exact bytes that are signed. */
export function canonicalRequest(timestampSeconds: number, method: string, path: string, body: string | Uint8Array = ''): Uint8Array {
  if (!Number.isInteger(timestampSeconds) || timestampSeconds < 0) throw new TypeError('timestamp must be integer unix seconds');
  if (!path.startsWith('/')) throw new TypeError(`path must start with "/" (got "${path}")`);
  const head = encoder.encode(`${timestampSeconds}.${method.toUpperCase()}.${path}.`);
  const rest = typeof body === 'string' ? encoder.encode(body) : body;
  const out = new Uint8Array(head.byteLength + rest.byteLength);
  out.set(head, 0);
  out.set(rest, head.byteLength);
  return out;
}

export interface SignRequestInput {
  keyId: string;
  secret: string | Uint8Array;
  method: string;
  /** Path and query exactly as they will be sent, e.g. `url.pathname + url.search`. */
  path: string;
  /** The raw body exactly as it will be sent. Omit for a GET. */
  body?: string | Uint8Array;
  timestampSeconds?: number;
}

/** The two headers to add to the request. */
export async function signRequest(input: SignRequestInput): Promise<{ 'm-ai-key-id': string; 'm-ai-signature': string }> {
  const t = input.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const mac = toHex(await hmacSha256Bytes(input.secret, canonicalRequest(t, input.method, input.path, input.body ?? '')));
  return { 'm-ai-key-id': input.keyId, 'm-ai-signature': `t=${t},v1=${mac}` };
}

export interface VerifyRequestInput {
  method: string;
  /** The request target exactly as received (e.g. Node's `req.url`), path and query. */
  path: string;
  /** The raw body bytes as received, before any JSON parsing. */
  body?: string | Uint8Array;
  headers: Headers | Record<string, string | string[] | undefined>;
}

export interface VerifyRequestOptions {
  /** Default 300 s. */
  toleranceSeconds?: number;
  now?: Date;
}

export type VerifyRequestResult =
  | { ok: true; keyId: string }
  | { ok: false; reason: 'missing_headers' | 'unknown_key' | 'expired' | 'bad_signature' };

function header(headers: VerifyRequestInput['headers'], name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key ? record[key] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Check a signed request against the caller's keys (key id → secret). Several
 * `v1=` values are accepted, but the key id picks the secret.
 */
export async function verifyRequest(
  input: VerifyRequestInput,
  keys: Readonly<Record<string, string | Uint8Array>>,
  options: VerifyRequestOptions = {},
): Promise<VerifyRequestResult> {
  const keyId = header(input.headers, REQUEST_HEADERS.keyId);
  const signature = header(input.headers, REQUEST_HEADERS.signature);
  if (!keyId || !signature) return { ok: false, reason: 'missing_headers' };
  const secret = Object.prototype.hasOwnProperty.call(keys, keyId) ? keys[keyId] : undefined;
  if (!secret) return { ok: false, reason: 'unknown_key' };

  let t: number | undefined;
  const macs: string[] = [];
  for (const part of signature.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't' && v && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && v && /^[0-9a-f]{64}$/.test(v)) macs.push(v);
  }
  if (t === undefined || macs.length === 0) return { ok: false, reason: 'missing_headers' };
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - t) > (options.toleranceSeconds ?? 300)) return { ok: false, reason: 'expired' };

  const expected = toHex(await hmacSha256Bytes(secret, canonicalRequest(t, input.method, input.path, input.body ?? '')));
  return macs.some((m) => timingSafeEqual(m, expected)) ? { ok: true, keyId } : { ok: false, reason: 'bad_signature' };
}
