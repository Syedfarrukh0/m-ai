import type { ActionSource, Locale, LocalizedText } from './vocabulary.js';

/**
 * Limits carried by a delegated token. An action is allowed when its name is
 * in `allowActions`, or it is a query of a module in `allowReadModules`.
 * Absent scope = the user's own permissions, unnarrowed.
 */
export interface TokenScope {
  allowActions?: readonly string[];
  allowReadModules?: readonly string[];
}

/**
 * Present when a client acts FOR the user (a delegated, on-behalf-of token):
 * the assistant, a partner integration. It never replaces `userId`; it is
 * recorded next to it in the audit log.
 */
export interface ActionActor {
  clientId: string;
  conversationId?: string;
  scope?: TokenScope;
}

/** Who is asking, for which company, through which door. */
export interface ActionContext {
  tenantId: string;
  /** Always the real person. Never a service account, never a superuser. */
  userId: string;
  roles: readonly string[];
  /** Effective permission keys, e.g. 'invoice:create'. */
  permissions: readonly string[];
  locale: Locale;
  source: ActionSource;
  requestId: string;
  idempotencyKey?: string;
  actor?: ActionActor;
}

/** What a handler sees: the context, plus the app's transaction-bound tools. */
export interface HandlerContext<R, E extends object> extends ActionContext {
  /** 'preview' runs the SAME code inside a transaction that is always rolled back. */
  mode: 'execute' | 'preview';
  /** The app's services, bound to this request's transaction (opaque to this package). */
  runtime: R;
  /** Record a domain event in the outbox, in this transaction. */
  emit<K extends keyof E & string>(type: K, payload: E[K]): Promise<void>;
  /** Stop with a stable error code. Rolls the transaction back. */
  fail(code: string, message: LocalizedText, details?: unknown): never;
}
