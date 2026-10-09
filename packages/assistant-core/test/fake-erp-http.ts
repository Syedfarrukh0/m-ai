/**
 * The mock ERP behind the real ERP's door, as a `fetch`: sign-in, refresh,
 * delegated tokens (300 s, aud erp:actions) and `/actions/*` over JSON.
 * It follows what the ERP described in its Phase D message, so the scripts
 * that talk to the real ERP can be tested here.
 */
import { httpStatusOf } from '@m-ai/action-contract';
import { DEMO_TENANT, IDS, createMockErp } from '@m-ai/mock-erp';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sig`;

export interface FakeErpHttpOptions {
  password?: string;
  licensed?: () => boolean;
  now?: () => number;
  /** Wrap /actions/list in an ActionResult, as some hosts do. */
  wrapList?: boolean;
}

export function createFakeErpHttp(options: FakeErpHttpOptions = {}) {
  const erp = createMockErp();
  const password = options.password ?? 'demo-password-1';
  const now = options.now ?? Date.now;
  const users: Record<string, string> = { 'owner@demo.pk': IDS.owner, 'zahid@demo.pk': IDS.booker };
  const access = new Map<string, { userId: string; exp: number }>();
  const refreshTokens = new Map<string, string>();
  const delegated = new Map<string, { userId: string; cnv: string; exp: number }>();
  const calls: Array<{ path: string; status: number; headers: Record<string, string>; body: unknown }> = [];
  let seq = 0;

  function issueAccess(userId: string) {
    const iat = Math.floor(now() / 1000);
    const token = jwt({ sub: userId, tid: DEMO_TENANT, iat, exp: iat + 900, n: ++seq });
    access.set(token, { userId, exp: (iat + 900) * 1000 });
    const refreshToken = `r-${++seq}`;
    refreshTokens.set(refreshToken, userId);
    return { accessToken: token, refreshToken };
  }

  const fetch: typeof globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = init?.body ? JSON.parse(String(init.body)) : {};
    const reply = (status: number, json: unknown) => {
      calls.push({ path, status, headers, body });
      return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    };
    const bearer = headers['authorization']?.replace(/^Bearer /, '') ?? '';

    if (path === '/auth/login') {
      const userId = users[body.email];
      if (body.tenantCode !== 'DEMO' || !userId || body.password !== password) return reply(401, { error: 'invalid_credentials' });
      return reply(200, issueAccess(userId));
    }
    if (path === '/auth/refresh') {
      const userId = refreshTokens.get(body.refreshToken);
      if (!userId) return reply(401, { error: 'invalid_refresh' });
      refreshTokens.delete(body.refreshToken);
      return reply(200, issueAccess(userId));
    }
    if (path === '/auth/delegate') {
      const session = access.get(bearer);
      if (!session || session.exp <= now()) return reply(401, { error: 'unauthenticated' });
      if (options.licensed && !options.licensed()) return reply(403, { error: 'module_not_licensed', moduleCode: 'ASSISTANT' });
      if (body.clientId !== 'm-ai') return reply(400, { error: 'unknown_client' });
      const iat = Math.floor(now() / 1000);
      const claims = { typ: 'delegated', sub: session.userId, tid: DEMO_TENANT, act: { sub: 'm-ai' }, aud: 'erp:actions', cnv: body.conversationId, iat, exp: iat + 300, n: ++seq };
      const token = jwt(claims);
      delegated.set(token, { userId: session.userId, cnv: body.conversationId, exp: (iat + 300) * 1000 });
      return reply(200, { token, expiresAt: new Date((iat + 300) * 1000).toISOString() });
    }
    if (path.startsWith('/documents/') && (init?.method ?? 'GET') === 'GET') {
      // The one route outside /actions/* a delegated token may use: the file a render made.
      const d = delegated.get(bearer);
      if (!d || d.exp <= now()) return reply(401, { error: 'unauthenticated' });
      const id = decodeURIComponent(path.slice('/documents/'.length));
      const file = erp.data.files.find((f) => f.id === id && f.tenantId === DEMO_TENANT);
      if (!file) return reply(404, { code: 'NOT_FOUND', message: 'The record was not found.', messages: { en: 'The record was not found.', ur: 'ریکارڈ نہیں ملا۔' } });
      calls.push({ path, status: 200, headers, body: undefined });
      return new Response(new TextEncoder().encode(`%PDF-1.7 ${file.fileName}`), {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${file.fileName}"` },
      });
    }
    if (path.startsWith('/actions/')) {
      const d = delegated.get(bearer);
      if (!d || d.exp <= now()) return reply(401, { error: 'unauthenticated' });
      if (headers['x-erp-source']) return reply(400, { error: 'source_not_allowed' });
      const ctx = erp.assistantCtx(d.userId, { actor: { clientId: 'm-ai', conversationId: d.cnv } });
      if (path === '/actions/list') {
        const list = await erp.registry.list(ctx, body);
        return reply(200, options.wrapList ? { ok: true, data: list } : list);
      }
      if (path === '/actions/preview') {
        const r = await erp.registry.preview(ctx, body);
        return reply(httpStatusOf(r), r);
      }
      if (path === '/actions/execute') {
        const key = headers['idempotency-key'];
        const r = await erp.registry.execute(key ? { ...ctx, idempotencyKey: key } : ctx, body);
        return reply(httpStatusOf(r), r);
      }
    }
    return reply(404, { error: 'not_found' });
  };

  return { fetch, erp, calls };
}
