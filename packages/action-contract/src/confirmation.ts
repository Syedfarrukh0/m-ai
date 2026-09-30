import type { ActionPreview } from './definition.js';
import { canonicalJson, hmacSha256, randomBase64Url, sha256Hex, timingSafeEqual, toBase64Url } from './crypto.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint — "what the person saw"
// ─────────────────────────────────────────────────────────────────────────────

export interface FingerprintInput {
  action: string;
  version: number;
  tenantId: string;
  userId: string;
  /** The parsed (post-defaults) input. */
  input: unknown;
  preview: ActionPreview;
}

/**
 * sha-256 over the canonical form of: action, version, tenant, user, input,
 * primaryAmount, and each change's op, entity, amounts and fields, plus the
 * warning codes.
 *
 * Left out on purpose, because they can change without the substance
 * changing: provisional `ref`s (document numbers), the summary and labels
 * (text that may quote a ref), and warning message text.
 *
 * Apps must not put volatile values (timestamps, sequence numbers) in
 * `amounts` or `fields`.
 */
export async function computeFingerprint(f: FingerprintInput): Promise<string> {
  const material = {
    v: 1,
    action: f.action,
    version: f.version,
    tenantId: f.tenantId,
    userId: f.userId,
    input: f.input,
    primaryAmount: f.preview.primaryAmount ?? null,
    changes: f.preview.changes.map((c) => ({
      op: c.op,
      entity: c.entity,
      amounts: c.amounts ?? null,
      fields: c.fields ?? null,
    })),
    warnings: f.preview.warnings.map((w) => w.code),
  };
  return sha256Hex(canonicalJson(material));
}

/** Hash of action + version + input, stored with an idempotency key to detect reuse with different input. */
export async function inputHash(action: string, version: number, input: unknown): Promise<string> {
  return sha256Hex(canonicalJson({ action, version, input }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirmation token — stateless, single-use when consumed by the host
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX = 'c1';

export interface ConfirmationClaims {
  fingerprint: string;
  tenantId: string;
  userId: string;
  action: string;
  version: number;
}

/**
 * `c1.<random>.<expiresAtUnixSeconds>.<mac>` — the MAC is HMAC-SHA256 over the
 * random part, the expiry and the claims. Nothing is stored at preview time
 * (the preview transaction rolls back); the host consumes the id inside the
 * execute transaction with a unique insert.
 */
export async function issueConfirmation(
  secret: string | Uint8Array,
  claims: ConfirmationClaims,
  expiresAt: Date,
): Promise<{ confirmationId: string; expiresAt: string }> {
  const random = randomBase64Url(16);
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const mac = await sign(secret, random, exp, claims);
  return { confirmationId: `${PREFIX}.${random}.${exp}.${mac}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export type ConfirmationCheck = { ok: true; expiresAt: Date } | { ok: false; reason: 'invalid' | 'expired' };

export async function verifyConfirmation(
  secret: string | Uint8Array,
  confirmationId: string,
  claims: ConfirmationClaims,
  now: Date,
): Promise<ConfirmationCheck> {
  const parts = typeof confirmationId === 'string' ? confirmationId.split('.') : [];
  if (parts.length !== 4 || parts[0] !== PREFIX) return { ok: false, reason: 'invalid' };
  const [, random = '', expText = '', mac = ''] = parts;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(random) || !/^\d{1,12}$/.test(expText)) return { ok: false, reason: 'invalid' };
  const exp = Number(expText);
  const expected = await sign(secret, random, exp, claims);
  if (!timingSafeEqual(mac, expected)) return { ok: false, reason: 'invalid' };
  const expiresAt = new Date(exp * 1000);
  if (now.getTime() >= expiresAt.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, expiresAt };
}

async function sign(secret: string | Uint8Array, random: string, exp: number, c: ConfirmationClaims): Promise<string> {
  const material = canonicalJson({
    v: PREFIX,
    r: random,
    exp,
    fingerprint: c.fingerprint,
    tenantId: c.tenantId,
    userId: c.userId,
    action: c.action,
    version: c.version,
  });
  return toBase64Url(await hmacSha256(secret, material));
}
