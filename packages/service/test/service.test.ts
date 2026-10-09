/**
 * The service over the mock ERP behind a fake of the ERP's door
 * (sign-in, delegated tokens, /actions/*, /documents/{id}), with a scripted model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAssistant, loginErp } from '@m-ai/assistant-core';
import type { Assistant, TurnInput, TurnResult } from '@m-ai/assistant-core';
import { createScriptedModel } from '@m-ai/assistant-core/testing';
import type { ScriptStep } from '@m-ai/assistant-core/testing';
import { createFakeErpHttp } from '../../assistant-core/test/fake-erp-http.js';
import { buildApp } from '../src/app.js';

const ERP = 'http://erp.test';
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(steps: ScriptStep[] = [], extra: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const fake = createFakeErpHttp();
  const model = createScriptedModel(steps);
  app = await buildApp({ assistant: createAssistant({ model }), pilot: { baseUrl: ERP, tenantCode: 'DEMO' }, apps: { erp: ERP }, fetch: fake.fetch, ...extra });
  return { app, fake, model };
}

async function signIn(a: FastifyInstance, password = 'demo-password-1') {
  const r = await a.inject({ method: 'POST', url: '/v1/pilot/sign-in', payload: { tenantCode: 'DEMO', email: 'owner@demo.pk', password } });
  const cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  return { r, cookie };
}

describe('the page', () => {
  it('serves the chat with a strict content policy, and says whether pilot sign-in is on', async () => {
    const { app } = await start();
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>M.Ai</title>');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    const js = await app.inject({ method: 'GET', url: '/chat.js' });
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.body).not.toContain('innerHTML');
    expect((await app.inject({ method: 'GET', url: '/v1/info' })).json()).toEqual({ pilot: { tenantCode: 'DEMO' }, apps: ['erp'] });
  });
});

describe('pilot sign-in', () => {
  it('refuses a wrong password plainly, and keeps nothing', async () => {
    const { app } = await start();
    const { r } = await signIn(app, 'wrong');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'The company code, e-mail or password is not right.' });
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('signs in, with an HttpOnly, SameSite=Strict cookie, and says who it is', async () => {
    const { app } = await start();
    const { r, cookie } = await signIn(app);
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict; Path=\//);
    expect(r.json()).toMatchObject({ company: 'Demo Distributors', email: 'owner@demo.pk' });
    expect((await app.inject({ method: 'GET', url: '/v1/pilot/me', headers: { cookie } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/v1/pilot/sign-out', headers: { cookie } });
    expect((await app.inject({ method: 'GET', url: '/v1/pilot/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('ends a session left unused for 8 hours', async () => {
    let t = 0;
    const { app } = await start([], { now: () => t });
    const { cookie } = await signIn(app);
    t += 8 * 3_600_000 + 1;
    expect((await app.inject({ method: 'GET', url: '/v1/pilot/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('is off without an app to sign in to', async () => {
    const { app } = await start([], { pilot: undefined } as never);
    expect((await app.inject({ method: 'POST', url: '/v1/pilot/sign-in', payload: { email: 'a@b.c', password: 'x' } })).statusCode).toBe(404);
  });
});

describe('pilot turns', () => {
  it('needs a session and a proper message', async () => {
    const { app } = await start();
    expect((await app.inject({ method: 'POST', url: '/v1/pilot/turn', payload: { conversationId: 'abc123', text: 'salam' } })).statusCode).toBe(401);
    const { cookie } = await signIn(app);
    const bad = await app.inject({ method: 'POST', url: '/v1/pilot/turn', headers: { cookie }, payload: { conversationId: 'x', text: 'salam' } });
    expect(bad.statusCode).toBe(400);
  });

  it('a whole confirmed change, through the door', async () => {
    const fake = createFakeErpHttp();
    const customer = fake.erp.data.customers[0]!;
    const model = createScriptedModel([{ call: { name: 'masters.customer.update', input: { customerId: customer.id, phone: '03001234567' } } }, 'Number badal diya.']);
    app = await buildApp({ assistant: createAssistant({ model }), pilot: { baseUrl: ERP, tenantCode: 'DEMO' }, fetch: fake.fetch });
    const { cookie } = await signIn(app);
    const r1 = (await app.inject({ method: 'POST', url: '/v1/pilot/turn', headers: { cookie }, payload: { conversationId: 'conv-002', text: 'number badal do' } })).json();
    expect(r1.status).toBe('awaiting_confirmation');
    expect(r1.pending.options.map((o: { value: string }) => o.value)).toEqual(['yes', 'no']);
    const r2 = (await app.inject({ method: 'POST', url: '/v1/pilot/turn', headers: { cookie }, payload: { conversationId: 'conv-002', text: 'haan', choice: 'yes' } })).json();
    expect(r2.status).toBe('answered');
    expect(fake.erp.data.customers[0]!.phone).toBe('03001234567');
    // The page gets no internal details.
    expect(r2).not.toHaveProperty('executed');
    expect(r2).not.toHaveProperty('usage.costUsd');
  });

  it('a PDF: the turn hands back the file, and the page fetches it through the same door', async () => {
    const fake = createFakeErpHttp();
    const model = createScriptedModel([{ call: { name: 'documents.invoice.render', input: { invoiceNo: 'INV-0001' } } }, 'PDF tayyar hai.']);
    app = await buildApp({ assistant: createAssistant({ model }), pilot: { baseUrl: ERP, tenantCode: 'DEMO' }, fetch: fake.fetch });
    const { cookie } = await signIn(app);
    const r = (await app.inject({ method: 'POST', url: '/v1/pilot/turn', headers: { cookie }, payload: { conversationId: 'conv-003', text: 'INV-0001 ka pdf bhejo' } })).json();
    expect(r.documents).toEqual([{ documentId: expect.any(String), fileName: 'INV-0001.pdf' }]);
    const file = await app.inject({ method: 'GET', url: `/v1/pilot/documents/${r.documents[0].documentId}`, headers: { cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toContain('INV-0001.pdf');
    expect(file.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await app.inject({ method: 'GET', url: '/v1/pilot/documents/nope-0000', headers: { cookie } })).statusCode).toBe(404);
  });
});

describe('turns for an app that hands over a delegated token', () => {
  it('takes who the person is from the app, not from the token', async () => {
    const fake = createFakeErpHttp();
    const seen: TurnInput[] = [];
    const assistant: Assistant = {
      handleTurn: async (input) => {
        seen.push(input);
        return { turnId: 't', reply: 'Ji.', language: 'ur-Latn', status: 'answered', executed: [], documents: [], usage: { model: 'm', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: '0.0000', modelCalls: 1 }, unverifiedNumbers: [] } as unknown as TurnResult;
      },
    };
    app = await buildApp({ assistant, apps: { erp: ERP }, fetch: fake.fetch });
    const session = await loginErp({ baseUrl: ERP, tenantCode: 'DEMO', password: 'demo-password-1' }, 'owner@demo.pk', { fetch: fake.fetch });
    const token = await session.token('w-1');
    const r = await app.inject({ method: 'POST', url: '/v1/apps/erp/turn', headers: { authorization: `Bearer ${token}` }, payload: { conversationId: 'chat-01', text: 'salam' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ reply: 'Ji.', status: 'answered' });
    const ctx = fake.erp.assistantCtx();
    expect(seen[0]).toMatchObject({ tenantId: ctx.tenantId, conversationId: expect.stringMatching(/^erp:.+:.+:chat-01$/) });
  });

  it('refuses no token, a bad token, and an unknown app', async () => {
    const fake = createFakeErpHttp();
    app = await buildApp({ assistant: createAssistant({ model: createScriptedModel([]) }), apps: { erp: ERP }, fetch: fake.fetch });
    const body = { conversationId: 'chat-01', text: 'salam' };
    expect((await app.inject({ method: 'POST', url: '/v1/apps/erp/turn', payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/apps/erp/turn', headers: { authorization: 'Bearer forged.e30.x' }, payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/apps/other/turn', headers: { authorization: 'Bearer x' }, payload: body })).statusCode).toBe(404);
  });
});

describe('one turn at a time per conversation', () => {
  it('a second message waits for the first to finish', async () => {
    const fake = createFakeErpHttp();
    let running = 0;
    let most = 0;
    const assistant: Assistant = {
      handleTurn: async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        return { turnId: 't', reply: 'ok', language: 'en', status: 'answered', executed: [], documents: [], usage: { model: 'm' }, unverifiedNumbers: [] } as unknown as TurnResult;
      },
    };
    app = await buildApp({ assistant, pilot: { baseUrl: ERP, tenantCode: 'DEMO' }, fetch: fake.fetch });
    const { cookie } = await signIn(app);
    const turn = (cid: string) => app!.inject({ method: 'POST', url: '/v1/pilot/turn', headers: { cookie }, payload: { conversationId: cid, text: 'hi' } });
    await Promise.all([turn('same-01'), turn('same-01')]);
    expect(most).toBe(1);
    await Promise.all([turn('one-0001'), turn('two-0002')]);
    expect(most).toBe(2);
  });
});

describe('when the app is down', () => {
  it('says the app could not be reached, not that the password is wrong', async () => {
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    app = await buildApp({ assistant: createAssistant({ model: createScriptedModel([]) }), pilot: { baseUrl: ERP, tenantCode: 'DEMO' }, fetch: down });
    const r = await app.inject({ method: 'POST', url: '/v1/pilot/sign-in', payload: { email: 'owner@demo.pk', password: 'x' } });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/could not be reached/);
  });
});
