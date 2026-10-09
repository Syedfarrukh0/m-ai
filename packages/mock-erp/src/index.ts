/**
 * @m-ai/mock-erp — a small distributor ERP on @m-ai/action-contract.
 *
 * Same shape as the real ERP (modules CORE / FBR / ASSISTANT, the well-known
 * actions, per-kind render, module errors with their own status), on an
 * in-memory host with real rollback. Used to build and test M.Ai without the
 * real ERP.
 */
import { AssistantSettings, createActionRegistry } from '@m-ai/action-contract';
import type { ActionContext, ActionRegistry, AssistantQuota } from '@m-ai/action-contract';
import { InMemoryHost } from '@m-ai/action-contract/testing';
import { ACTIONS, EVENTS, MODULE_ERRORS, createRuntime } from './actions.js';
import type { Events, Runtime } from './actions.js';
import { DEMO_TENANT, IDS, OTHER_TENANT, seed } from './data.js';
import type { MockData } from './data.js';

export * from './data.js';
export { ACTIONS, EVENTS, MODULE_ERRORS, similarity } from './actions.js';
export type { Events, Runtime } from './actions.js';

export const ASSISTANT_CLIENT_ID = 'm-ai';

export interface MockErpOptions {
  /** Raw assistant settings per tenant. Default: enabled, with consent, for the demo company. */
  settings?: Record<string, unknown>;
  quota?: (tenantId: string) => AssistantQuota;
  licence?: (tenantId: string, module: string) => 'active' | 'read-only' | 'none';
  /** The company's "today". Default 2026-10-02. */
  today?: string;
  data?: MockData;
}

export interface MockErp {
  host: InMemoryHost<MockData, Runtime, Events>;
  registry: ActionRegistry;
  data: MockData;
  /** An ActionContext for a user, as the assistant would call with a delegated token. */
  assistantCtx(userId?: string, overrides?: Partial<ActionContext>): ActionContext;
  /** An ActionContext for a user in the web workbench. */
  webCtx(userId?: string, overrides?: Partial<ActionContext>): ActionContext;
  setSettings(tenantId: string, settings: unknown): void;
  setQuota(quota: AssistantQuota): void;
}

export const ENABLED_SETTINGS = {
  enabled: true,
  name: 'Munshi',
  language: 'auto',
  tone: 'friendly',
  consent: { termsVersion: '2026-10', acceptedAt: '2026-10-01T10:00:00Z', acceptedBy: IDS.owner },
};

export function createMockErp(options: MockErpOptions = {}): MockErp {
  const settings: Record<string, unknown> = options.settings ?? { [DEMO_TENANT]: { ...ENABLED_SETTINGS }, [OTHER_TENANT]: {} };
  let quota: AssistantQuota = { included: 1000, used: 120, packsRemaining: 0, state: 'ok' };
  const quotaFor = options.quota ?? (() => quota);
  const today = options.today ?? '2026-10-02';
  const data = options.data ?? seed();

  const host = new InMemoryHost<MockData, Runtime, Events>({
    data,
    runtime: (d, ctx) =>
      createRuntime(d, ctx, {
        settings: (tenantId) => AssistantSettings.parse(settings[tenantId] ?? {}),
        quota: quotaFor,
        today: () => today,
      }),
    assistantSettings: settings,
    quota: quotaFor,
    startTime: new Date(`${today}T05:00:00Z`),
    ...(options.licence ? { licence: options.licence } : {}),
  });
  const registry = createActionRegistry<Runtime, Events>({ host, producer: { name: 'm-ai-mock-erp', version: '0.1.0' } });
  registry.register(...ACTIONS);
  registry.registerEvents(...EVENTS);
  registry.registerErrors(MODULE_ERRORS);
  registry.validate();

  let seq = 0;
  const ctxFor = (userId: string, base: Partial<ActionContext>, overrides: Partial<ActionContext>): ActionContext => {
    const user = host.data.users.find((u) => u.id === userId);
    if (!user) throw new Error(`no such user ${userId}`);
    return {
      tenantId: user.tenantId,
      userId: user.id,
      roles: user.roles,
      permissions: user.permissions,
      locale: user.locale,
      source: 'web',
      requestId: `mock-${++seq}`,
      ...base,
      ...overrides,
    };
  };

  return {
    host,
    registry,
    get data() {
      return host.data;
    },
    assistantCtx: (userId = IDS.owner, overrides = {}) =>
      ctxFor(userId, { source: 'assistant', actor: { clientId: ASSISTANT_CLIENT_ID } }, overrides),
    webCtx: (userId = IDS.owner, overrides = {}) => ctxFor(userId, { source: 'web' }, overrides),
    setSettings: (tenantId, s) => host.setAssistantSettings(tenantId, s),
    setQuota: (q) => {
      quota = q;
    },
  };
}
