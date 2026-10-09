/**
 * Talking to a real ERP from the terminal, the way the web chat will:
 * sign in as a person, ask the ERP for a delegated token for M.Ai, and call
 * `/actions/*` with it. For scripts (chat, evals, the door check) only — the
 * M.Ai service gets its tokens from the person's own session instead.
 *
 *   POST /auth/login     { tenantCode, email, password } → { accessToken, refreshToken }
 *   POST /auth/refresh   { refreshToken }               → { accessToken, refreshToken? }
 *   POST /auth/delegate  { clientId, conversationId }   → { token, expiresAt }   (Bearer accessToken)
 *
 * Settings (.env):
 *   M_AI_ERP_URL       http://localhost:3001
 *   M_AI_ERP_TENANT    DEMO
 *   M_AI_ERP_PASSWORD  the test users' password
 *   M_AI_ERP_OWNER / M_AI_ERP_BOOKER / M_AI_ERP_OFFICER   their e-mails (defaults: the ERP's DEMO users)
 */
import { createHttpActionsClient } from '../src/index.js';
import type { HttpActionsClient } from '../src/index.js';

export const ERP_CLIENT_ID = 'm-ai';

export const DEFAULT_ERP_USERS: Record<string, string> = {
  owner: 'owner@demo.pk',
  booker: 'zahid@demo.pk',
  officer: 'imran@demo.pk',
};

export interface ErpSettings {
  baseUrl: string;
  tenantCode: string;
  password: string;
  /** Role name → e-mail. */
  users: Record<string, string>;
}

/** The ERP settings from the environment, or a list of what is missing. */
export function erpSettingsFromEnv(env: Record<string, string | undefined>, baseUrl?: string): ErpSettings | { missing: string[] } {
  const url = baseUrl ?? env['M_AI_ERP_URL'];
  const password = env['M_AI_ERP_PASSWORD'];
  const missing = [...(url ? [] : ['M_AI_ERP_URL (or --erp <url>)']), ...(password ? [] : ['M_AI_ERP_PASSWORD'])];
  if (missing.length > 0 || !url || !password) return { missing };
  const users = { ...DEFAULT_ERP_USERS };
  for (const role of Object.keys(DEFAULT_ERP_USERS)) {
    const v = env[`M_AI_ERP_${role.toUpperCase()}`];
    if (v) users[role] = v;
  }
  return { baseUrl: url.replace(/\/$/, ''), tenantCode: env['M_AI_ERP_TENANT'] || 'DEMO', password, users };
}

/** Which step failed, the HTTP status and the start of the body: enough to tell the ERP what happened. */
export class ErpError extends Error {
  constructor(
    message: string,
    readonly step: 'login' | 'refresh' | 'delegate',
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ErpError';
  }
}

export interface DelegatedClaims {
  sub: string;
  tid: string;
  aud?: string;
  act?: { sub: string };
  cnv?: string;
  exp?: number;
  [k: string]: unknown;
}

/** The claims inside a JWT, without checking its signature (the ERP checks it). */
export function decodeJwt(token: string): Record<string, unknown> | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function pick(body: unknown, key: string): unknown {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (b[key] !== undefined) return b[key];
  for (const inner of ['data', 'tokens', 'session'])
    if (b[inner] && typeof b[inner] === 'object' && (b[inner] as Record<string, unknown>)[key] !== undefined)
      return (b[inner] as Record<string, unknown>)[key];
  return undefined;
}

export interface ErpSession {
  email: string;
  /** A delegated token for this conversation (cached until 30 s before it expires). */
  token(conversationId: string): Promise<string>;
  /** Who the token acts for: `sub` (the user) and `tid` (the company). */
  claims(conversationId: string): Promise<DelegatedClaims>;
  /** A client for `/actions/*` (and `/documents/{id}`) that always sends a live token for this conversation. */
  actions(conversationId: string): HttpActionsClient;
}

export async function loginErp(
  settings: Pick<ErpSettings, 'baseUrl' | 'tenantCode' | 'password'>,
  email: string,
  options: { fetch?: typeof globalThis.fetch; now?: () => number; clientId?: string } = {},
): Promise<ErpSession> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const clientId = options.clientId ?? ERP_CLIENT_ID;
  const base = settings.baseUrl.replace(/\/$/, '');

  async function call(step: ErpError['step'], path: string, body: unknown, bearer?: string): Promise<{ status: number; json: unknown; text: string }> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ErpError(`could not reach ${base}${path}: ${(e as Error).message}. Is the ERP running?`, step);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text: text.slice(0, 300) };
  }

  let access = '';
  let refresh = '';
  let accessUntil = 0;

  function keep(json: unknown, step: ErpError['step'], status: number, text: string): void {
    const a = pick(json, 'accessToken');
    if (typeof a !== 'string') throw new ErpError(`${step}: no accessToken in the reply`, step, status, text);
    access = a;
    const r = pick(json, 'refreshToken');
    if (typeof r === 'string') refresh = r;
    const exp = decodeJwt(a)?.['exp'];
    // Renew a minute early; without an exp, assume the ERP's 15 minutes.
    accessUntil = (typeof exp === 'number' ? exp * 1000 : now() + 15 * 60_000) - 60_000;
  }

  async function login(): Promise<void> {
    const r = await call('login', '/auth/login', { tenantCode: settings.tenantCode, email, password: settings.password });
    if (r.status >= 300) throw new ErpError(`login as ${email} (company ${settings.tenantCode}) failed with ${r.status}`, 'login', r.status, r.text);
    keep(r.json, 'login', r.status, r.text);
  }

  async function fresh(): Promise<string> {
    if (now() < accessUntil) return access;
    if (refresh) {
      const r = await call('refresh', '/auth/refresh', { refreshToken: refresh });
      if (r.status < 300) {
        keep(r.json, 'refresh', r.status, r.text);
        return access;
      }
    }
    await login();
    return access;
  }

  const cache = new Map<string, { token: string; until: number; claims: DelegatedClaims }>();

  async function delegate(conversationId: string, retried = false): Promise<{ token: string; until: number; claims: DelegatedClaims }> {
    const bearer = await fresh();
    const r = await call('delegate', '/auth/delegate', { clientId, conversationId }, bearer);
    if (r.status === 401 && !retried) {
      accessUntil = 0; // the session token was refused: renew it once
      return delegate(conversationId, true);
    }
    if (r.status >= 300) {
      const notLicensed = /module_not_licensed/i.test(r.text);
      throw new ErpError(
        notLicensed
          ? `the company ${settings.tenantCode} does not hold ASSISTANT. In the ERP run \`pnpm demo:assistant\`, then switch it on in Accounts → Assistant.`
          : `the ERP refused a token for ${email} with ${r.status}`,
        'delegate',
        r.status,
        r.text,
      );
    }
    const token = pick(r.json, 'token');
    if (typeof token !== 'string') throw new ErpError('delegate: no token in the reply', 'delegate', r.status, r.text);
    const expiresAt = pick(r.json, 'expiresAt');
    const claims = decodeJwt(token) as DelegatedClaims | undefined;
    if (!claims || typeof claims.sub !== 'string' || typeof claims.tid !== 'string')
      throw new ErpError('delegate: the token has no sub/tid claims', 'delegate', r.status, r.text);
    const until = (typeof expiresAt === 'string' ? Date.parse(expiresAt) : (claims.exp ?? 0) * 1000) - 30_000;
    return { token, until, claims };
  }

  async function entry(conversationId: string) {
    const hit = cache.get(conversationId);
    if (hit && now() < hit.until) return hit;
    const next = await delegate(conversationId);
    cache.set(conversationId, next);
    return next;
  }

  await login();
  return {
    email,
    token: async (cid) => (await entry(cid)).token,
    claims: async (cid) => (await entry(cid)).claims,
    actions: (cid) => createHttpActionsClient({ baseUrl: base, token: async () => (await entry(cid)).token, ...(options.fetch ? { fetch: options.fetch } : {}) }),
  };
}

/** A role name ("owner") or an e-mail → the e-mail. */
export function userEmail(settings: ErpSettings, who: string): string | undefined {
  return who.includes('@') ? who : settings.users[who];
}
