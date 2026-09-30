import { z } from 'zod';
import { hmacSha256, timingSafeEqual, toHex } from './crypto.js';
import { IsoDateTime } from './schemas.js';
import { EVENT_TYPE, LOCALES } from './vocabulary.js';

/**
 * Event delivery to an external consumer (the assistant runs as its own
 * service). The app delivers each outbox event — and each inbound channel
 * message (`message.received`) — as a signed HTTPS POST, at least once, with
 * retries. Consumers dedupe on `eventId` (+ `recipient.userId`).
 */

export const WEBHOOK_HEADERS = {
  /** `t=<unix seconds>,v1=<hex hmac>` — several v1 entries while a secret rotates. */
  signature: 'm-ai-signature',
  deliveryId: 'm-ai-delivery-id',
  eventType: 'm-ai-event-type',
} as const;

export const EventDelivery = z.object({
  /** Unique per attempt series of (subscription, event, recipient). */
  deliveryId: z.string().min(1),
  /** The outbox event id. Dedupe on it. */
  eventId: z.string().min(1),
  type: z.string().regex(EVENT_TYPE),
  /** Payload version. */
  version: z.number().int().min(1),
  tenantId: z.string().min(1),
  occurredAt: IsoDateTime,
  /** 1 for the first attempt. */
  attempt: z.number().int().min(1),
  /**
   * For alerts: the ONE user this delivery is for. The app has already checked
   * the event's audience permission and the user's alert settings, and the
   * payload holds only what this user may see.
   */
  recipient: z
    .object({
      userId: z.string().min(1),
      locale: z.enum(LOCALES),
      conversationId: z.string().optional(),
    })
    .optional(),
  payload: z.unknown(),
  /** A delegated token minted for this attempt, scoped with alertTokenScope(). Never stored by the app. */
  token: z.object({ token: z.string().min(1), expiresAt: IsoDateTime }).optional(),
});
export type EventDelivery = z.infer<typeof EventDelivery>;

/** Sign a raw request body. Returns the value of the `m-ai-signature` header. */
export async function signWebhook(
  secret: string | Uint8Array,
  rawBody: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const mac = toHex(await hmacSha256(secret, `${timestampSeconds}.${rawBody}`));
  return `t=${timestampSeconds},v1=${mac}`;
}

export interface VerifyWebhookOptions {
  /** Reject signatures older or newer than this. Default 300 s. */
  toleranceSeconds?: number;
  now?: Date;
}

/**
 * Verify a `m-ai-signature` header against the RAW body (before JSON
 * parsing). Accepts any of several secrets, for rotation.
 */
export async function verifyWebhook(
  secrets: string | Uint8Array | ReadonlyArray<string | Uint8Array>,
  rawBody: string,
  header: string | null | undefined,
  options: VerifyWebhookOptions = {},
): Promise<boolean> {
  if (!header) return false;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't' && v && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === 'v1' && v && /^[0-9a-f]{64}$/.test(v)) signatures.push(v);
  }
  if (timestamp === undefined || signatures.length === 0) return false;

  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false;

  const list = Array.isArray(secrets) ? secrets : [secrets as string | Uint8Array];
  for (const secret of list) {
    const expected = toHex(await hmacSha256(secret, `${timestamp}.${rawBody}`));
    if (signatures.some((s) => timingSafeEqual(s, expected))) return true;
  }
  return false;
}
