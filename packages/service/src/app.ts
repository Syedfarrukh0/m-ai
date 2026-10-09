/**
 * M.Ai's server.
 *
 *   GET  /                              the web chat
 *   POST /v1/pilot/sign-in              pilot sign-in to one app (ERP credentials, see below)
 *   POST /v1/pilot/turn                 a turn for the signed-in person
 *   GET  /v1/pilot/documents/:id        a PDF the turn made
 *   POST /v1/apps/:app/turn             a turn for an app that hands over the person's delegated token
 *   GET  /v1/apps/:app/documents/:id    a PDF, with the same token
 *
 * TWO WAYS IN
 *
 * The app's way (the one to ship): the person is signed in to the app; the
 * app asks itself for a delegated token for M.Ai (`POST /auth/delegate`,
 * five minutes, `/actions/*` only) and sends it with each message. M.Ai never
 * sees a password or a session. Who the person is comes from the app
 * (`core.context.get` with that token), never from the token's own claims.
 *
 * The pilot's way (until the app embeds the chat): the person signs in on
 * M.Ai's page; M.Ai signs in to the app for them and asks for delegated tokens
 * as the app would. The password is passed on, never kept; the app's session
 * is held in memory only, for this server's life, and ends after 8 idle hours.
 * Meant for a server on the owner's own machine (it listens on 127.0.0.1 by
 * default).
 */
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErpError, TransportError, createHttpActionsClient, loginErp } from '@m-ai/assistant-core';
import type { ActionsClient, Assistant, ErpSession, HttpActionsClient, TurnResult } from '@m-ai/assistant-core';
import { CHAT_PAGE, CHAT_SCRIPT } from './chat-page.js';

export interface ServiceOptions {
  /** Built from the model settings (createAssistant). */
  assistant: Assistant;
  /** The app the pilot sign-in goes to. Without it there is no pilot sign-in. */
  pilot?: { baseUrl: string; tenantCode: string };
  /** App id → base URL, for turns with a delegated token. */
  apps?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  logger?: boolean | Record<string, unknown>;
  now?: () => number;
  /** A pilot session ends after this long unused. Default 8 hours. */
  sessionIdleMs?: number;
}

/** What a turn sends back to a page: the reply and what to show with it. Internal details stay in the log. */
export interface TurnView {
  turnId: string;
  reply: string;
  status: TurnResult['status'];
  language: string;
  pending?: { action: string; options: Array<{ value: 'yes' | 'no'; label: string }>; expiresAt?: string };
  documents: Array<{ documentId: string; fileName?: string }>;
  usage: { model: string; charge?: { amount: string; currency: string } };
  balanceAfter?: string;
  /** Only that something failed, and whether trying again later may help. */
  error?: { source: 'model' | 'app'; retryable?: boolean };
}

const COOKIE = 'm_ai_pilot';
const ConversationId = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'a conversation id of 6–64 letters, digits, - or _');
const TurnBody = z.object({
  conversationId: ConversationId,
  text: z.string().trim().min(1).max(2000),
  choice: z.enum(['yes', 'no']).optional(),
});
const SignInBody = z.object({
  tenantCode: z.string().trim().min(1).max(40).optional(),
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
});

interface PilotSession {
  erp: ErpSession;
  email: string;
  tenantCode: string;
  name: string;
  company: string;
  lastUsed: number;
}

export function view(r: TurnResult): TurnView {
  const v: TurnView = {
    turnId: r.turnId,
    reply: r.reply,
    status: r.status,
    language: r.language,
    documents: r.documents.map((d) => ({ documentId: d.documentId, ...(d.fileName ? { fileName: d.fileName } : {}) })),
    usage: { model: r.usage.model, ...(r.usage.charge ? { charge: r.usage.charge } : {}) },
  };
  if (r.pending) v.pending = { action: r.pending.action, options: r.pending.options, ...(r.pending.expiresAt ? { expiresAt: r.pending.expiresAt } : {}) };
  if (r.balanceAfter !== undefined) v.balanceAfter = r.balanceAfter;
  if (r.error) v.error = { source: r.error.source, ...(r.error.retryable !== undefined ? { retryable: r.error.retryable } : {}) };
  return v;
}

function cookieOf(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function bad(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ error });
}

export async function buildApp(options: ServiceOptions): Promise<FastifyInstance> {
  // Fastify's request log has the method and URL only: no headers, so no tokens or cookies.
  const app = Fastify({ logger: options.logger ?? false });
  const now = options.now ?? Date.now;
  const idleMs = options.sessionIdleMs ?? 8 * 3_600_000;
  const sessions = new Map<string, PilotSession>();
  const apps = options.apps ?? {};

  // One turn at a time per conversation: two at once would each change the same history.
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    queues.set(key, next);
    void next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    }).catch(() => undefined);
    return next;
  }

  function sessionOf(req: FastifyRequest): { id: string; s: PilotSession } | undefined {
    const id = cookieOf(req, COOKIE);
    const s = id ? sessions.get(id) : undefined;
    if (!id || !s) return undefined;
    if (now() - s.lastUsed > idleMs) {
      sessions.delete(id);
      return undefined;
    }
    s.lastUsed = now();
    return { id, s };
  }

  const securityHeaders = (reply: FastifyReply) =>
    reply
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");

  app.get('/', async (_req, reply) => securityHeaders(reply).type('text/html; charset=utf-8').send(CHAT_PAGE));
  app.get('/chat.js', async (_req, reply) => securityHeaders(reply).type('text/javascript; charset=utf-8').send(CHAT_SCRIPT));
  app.get('/health', async () => ({ ok: true }));
  app.get('/v1/info', async () => ({ pilot: options.pilot ? { tenantCode: options.pilot.tenantCode } : null, apps: Object.keys(apps) }));

  // ── The pilot's way ─────────────────────────────────────────────────────────
  app.post('/v1/pilot/sign-in', async (req, reply) => {
    if (!options.pilot) return bad(reply, 404, 'Pilot sign-in is off on this server.');
    const body = SignInBody.safeParse(req.body);
    if (!body.success) return bad(reply, 400, 'Company code, e-mail and password, please.');
    const tenantCode = body.data.tenantCode || options.pilot.tenantCode;
    try {
      const erp = await loginErp({ baseUrl: options.pilot.baseUrl, tenantCode, password: body.data.password }, body.data.email, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      const who = await erp.actions('pilot-who').execute({ action: 'core.context.get', input: {} });
      const ctx = who.ok ? (who.data as { user?: { displayName?: string }; company?: { name?: string } }) : {};
      const id = randomBytes(32).toString('base64url');
      const s: PilotSession = {
        erp,
        email: body.data.email,
        tenantCode,
        name: ctx.user?.displayName ?? body.data.email,
        company: ctx.company?.name ?? tenantCode,
        lastUsed: now(),
      };
      sessions.set(id, s);
      const secure = req.protocol === 'https' ? '; Secure' : '';
      reply.header('set-cookie', `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(idleMs / 1000)}${secure}`);
      return { name: s.name, company: s.company, email: s.email, assistant: who.ok ? 'on' : (who as { error: { code: string } }).error.code };
    } catch (e) {
      if (e instanceof ErpError) {
        req.log.warn({ step: e.step, status: e.status }, 'pilot sign-in refused');
        if (e.status === undefined) return bad(reply, 502, 'The app could not be reached. Is it running?');
        if (e.step === 'login' && e.status === 401) return bad(reply, 401, 'The company code, e-mail or password is not right.');
        if (e.step === 'login') return bad(reply, 502, `The app refused the sign-in (${e.status}).`);
        return bad(reply, 403, e.message);
      }
      req.log.error(e, 'pilot sign-in failed');
      return bad(reply, 502, 'The app could not be reached.');
    }
  });

  app.post('/v1/pilot/sign-out', async (req, reply) => {
    const id = cookieOf(req, COOKIE);
    if (id) sessions.delete(id);
    reply.header('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });

  app.get('/v1/pilot/me', async (req, reply) => {
    const found = sessionOf(req);
    if (!found) return bad(reply, 401, 'Not signed in.');
    return { name: found.s.name, company: found.s.company, email: found.s.email };
  });

  app.post('/v1/pilot/turn', async (req, reply) => {
    const found = sessionOf(req);
    if (!found) return bad(reply, 401, 'Not signed in.');
    const body = TurnBody.safeParse(req.body);
    if (!body.success) return bad(reply, 400, body.error.issues[0]?.message ?? 'Bad request.');
    const { conversationId, text, choice } = body.data;
    try {
      const claims = await found.s.erp.claims(conversationId);
      const actions = found.s.erp.actions(conversationId);
      const key = `pilot:${claims.tid}:${claims.sub}:${conversationId}`;
      const result = await serial(key, () =>
        options.assistant.handleTurn({ conversationId: key, tenantId: claims.tid, userId: claims.sub, text, actions, ...(choice ? { choice } : {}) }),
      );
      if (result.error) req.log.warn({ error: result.error }, 'turn ended unavailable');
      return view(result);
    } catch (e) {
      if (e instanceof ErpError) {
        req.log.warn({ step: e.step, status: e.status }, 'pilot token refused');
        return bad(reply, e.status === 403 ? 403 : 401, e.message);
      }
      req.log.error(e, 'pilot turn failed');
      return bad(reply, 502, 'The app could not be reached.');
    }
  });

  app.get<{ Params: { id: string } }>('/v1/pilot/documents/:id', async (req, reply) => {
    const found = sessionOf(req);
    if (!found) return bad(reply, 401, 'Not signed in.');
    return sendDocument(found.s.erp.actions('pilot-documents'), req.params.id, reply);
  });

  // ── The app's way ───────────────────────────────────────────────────────────
  function appClient(req: FastifyRequest<{ Params: { app: string } }>): HttpActionsClient | undefined {
    const baseUrl = apps[req.params.app];
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!baseUrl || !token) return undefined;
    return createHttpActionsClient({ baseUrl, token, ...(options.fetch ? { fetch: options.fetch } : {}) });
  }

  app.post<{ Params: { app: string } }>('/v1/apps/:app/turn', async (req, reply) => {
    if (!apps[req.params.app]) return bad(reply, 404, `No app "${req.params.app}" on this server.`);
    const actions = appClient(req);
    if (!actions) return bad(reply, 401, 'Send the person’s delegated token: Authorization: Bearer <token>.');
    const body = TurnBody.safeParse(req.body);
    if (!body.success) return bad(reply, 400, body.error.issues[0]?.message ?? 'Bad request.');
    const who = await identify(actions);
    if ('error' in who) return bad(reply, who.status, who.error);
    const { conversationId, text, choice } = body.data;
    const key = `${req.params.app}:${who.tenantId}:${who.userId}:${conversationId}`;
    const result = await serial(key, () =>
      options.assistant.handleTurn({ conversationId: key, tenantId: who.tenantId, userId: who.userId, text, actions, ...(choice ? { choice } : {}) }),
    );
    if (result.error) req.log.warn({ error: result.error }, 'turn ended unavailable');
    return view(result);
  });

  app.get<{ Params: { app: string; id: string } }>('/v1/apps/:app/documents/:id', async (req, reply) => {
    if (!apps[req.params.app]) return bad(reply, 404, `No app "${req.params.app}" on this server.`);
    const actions = appClient(req);
    if (!actions) return bad(reply, 401, 'Send the person’s delegated token: Authorization: Bearer <token>.');
    return sendDocument(actions, req.params.id, reply);
  });

  /** Who the token acts for, as the app itself says (core.context.get) — never the token's unchecked claims. */
  async function identify(actions: ActionsClient): Promise<{ userId: string; tenantId: string } | { status: number; error: string }> {
    try {
      const r = await actions.execute({ action: 'core.context.get', input: {} });
      if (!r.ok) {
        if (r.error.code === 'MODULE_NOT_LICENSED') return { status: 403, error: 'This company does not hold the assistant.' };
        if (r.error.code === 'ASSISTANT_POLICY_DENIED') return { status: 403, error: 'The assistant is switched off for this company.' };
        return { status: 401, error: `The app refused the token (${r.error.code}).` };
      }
      const data = r.data as { user?: { id?: string }; company?: { id?: string } };
      if (!data.user?.id || !data.company?.id) return { status: 502, error: 'The app did not say who this is.' };
      return { userId: data.user.id, tenantId: data.company.id };
    } catch (e) {
      if (e instanceof TransportError && e.status === 401) return { status: 401, error: 'The app refused the token.' };
      return { status: 502, error: 'The app could not be reached.' };
    }
  }

  async function sendDocument(actions: HttpActionsClient, id: string, reply: FastifyReply) {
    if (!/^[0-9a-zA-Z-]{1,64}$/.test(id)) return bad(reply, 400, 'Not a document id.');
    const file = await actions.document(id).catch(() => undefined);
    if (!file) return bad(reply, 502, 'The app could not be reached.');
    if (!file.ok) return bad(reply, file.status === 404 ? 404 : 403, file.message);
    const name = (file.fileName ?? `${id}.pdf`).replace(/["\\\r\n]/g, '_');
    return reply
      .header('content-type', file.contentType)
      .header('content-disposition', `inline; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(file.bytes));
  }

  // Idle pilot sessions are dropped.
  const sweep = setInterval(() => {
    for (const [id, s] of sessions) if (now() - s.lastUsed > idleMs) sessions.delete(id);
  }, 10 * 60_000);
  sweep.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweep);
    sessions.clear();
  });

  return app;
}
