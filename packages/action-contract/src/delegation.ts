import type { TokenScope } from './context.js';
import { WELL_KNOWN_ACTIONS } from './assistant.js';

/**
 * Delegation — how a client (the assistant) acts for a person without ever
 * holding a superuser credential. The app mints and verifies these tokens;
 * this package only fixes their shape. Only `/actions/*` accepts them.
 *
 * Web chat:  the signed-in user's session asks for a token for the client
 *            (`POST /auth/delegate { clientId }`).
 * WhatsApp:  the client proves itself and names an inbound message, received
 *            in the last few minutes from a contact the gateway has bound to a
 *            user by OTP (`POST /auth/token-exchange { messageId }`).
 *            No inbound message → no token.
 * Alerts:    the app mints a token per delivery attempt, scoped with
 *            `alertTokenScope()`, and puts it in the webhook envelope.
 */
export interface DelegatedTokenClaims {
  typ: 'delegated';
  /** The user. */
  sub: string;
  /** The company. */
  tid: string;
  /** The client acting for them, e.g. 'm-ai-assistant'. */
  act: { sub: string };
  aud: string;
  /** Conversation id, when the token came from the gateway or an alert. */
  cnv?: string;
  /** Inbound message the token was exchanged for (WhatsApp/SMS). */
  msg?: string;
  /** Narrower than the user's own permissions. Absent = the user's permissions. */
  scp?: TokenScope;
  iat: number;
  /** At most DELEGATED_TOKEN_MAX_TTL_SECONDS after iat. */
  exp: number;
}

export const DELEGATED_TOKEN_MAX_TTL_SECONDS = 300;

export interface DelegatedToken {
  token: string;
  expiresAt: string;
}

/**
 * The scope of a token minted for a proactive alert: read actions of the
 * event's module and of the always-readable modules (e.g. CORE, to name the
 * customer or product), plus sending to the user's own conversation and
 * recording usage. Nothing else.
 */
export function alertTokenScope(eventModule: string, alwaysReadable: readonly string[] = ['CORE']): TokenScope {
  return {
    allowReadModules: [...new Set([eventModule, ...alwaysReadable])],
    allowActions: [WELL_KNOWN_ACTIONS.messagingSend, WELL_KNOWN_ACTIONS.usageRecord],
  };
}

/** Whether a token scope covers an action. No scope = covered. */
export function scopeAllows(
  scope: TokenScope | undefined,
  def: { name: string; kind: 'query' | 'command'; module: string },
): boolean {
  if (scope === undefined) return true;
  if (scope.allowActions?.includes(def.name)) return true;
  if (def.kind === 'query' && scope.allowReadModules?.includes(def.module)) return true;
  return false;
}
