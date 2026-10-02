import type {
  ActionResult,
  CatalogEntry,
  CoreContextOutput,
  ExecuteRequest,
  Locale,
  LocalizedText,
  PreviewResult,
} from '@m-ai/action-contract';
import { AssistantSettings, CoreContextOutput as CoreContextSchema, WELL_KNOWN_ACTIONS } from '@m-ai/action-contract';
import type { ActionsClient } from './actions-client.js';
import { TransportError } from './actions-client.js';
import { detectLanguage, parseConfirmation } from './language.js';
import type { ContentBlock, ModelClient, ModelMessage, ToolCallBlock, ToolSpec } from './model.js';
import { textOf } from './model.js';
import { unverifiedNumbers } from './numbers.js';
import type { PhraseKey } from './phrases.js';
import { confirmationMessage, phrase, pick } from './phrases.js';
import { REMEMBER_TOOL, buildSystemPrompt } from './prompt.js';
import type { ConversationState, ConversationStore, NoteStore, PendingAction } from './store.js';
import { MAX_NOTE_LENGTH, createMemoryConversationStore, createMemoryNoteStore } from './store.js';
import { selectTools, toToolName, toToolSpec } from './tools.js';
import type { ModelPricing, TurnUsage } from './usage.js';
import { addUsage, costUsd, emptyUsage } from './usage.js';

export interface AssistantOptions {
  model: ModelClient;
  conversations?: ConversationStore;
  notes?: NoteStore;
  /** For the cost reported with each turn. Without it the cost is "0.0000". */
  pricing?: ModelPricing;
  /** Model calls per turn. Default 6. */
  maxSteps?: number;
  /** Tools offered per turn. Default 24. */
  maxTools?: number;
  /** Messages kept per conversation. Default 40. */
  maxHistoryMessages?: number;
  /** Characters of one tool result shown to the model. Default 6000. */
  maxToolResultChars?: number;
  /** Output tokens per model call. Default 1024. */
  maxTokens?: number;
  now?: () => Date;
  newId?: () => string;
  /** Called for errors the person doesn't see (usage recording, transport). */
  onError?: (error: unknown, where: string) => void;
}

export interface TurnInput {
  /** Stable per chat (a WhatsApp number, a web chat session). */
  conversationId: string;
  tenantId: string;
  userId: string;
  text: string;
  /** Bound to this person's delegated token for this turn. */
  actions: ActionsClient;
  turnId?: string;
}

export type TurnStatus =
  | 'answered'
  | 'awaiting_confirmation'
  | 'awaiting_approval'
  | 'cancelled'
  | 'refused'
  | 'unavailable';

export interface TurnResult {
  turnId: string;
  reply: string;
  language: Locale;
  status: TurnStatus;
  /** What is waiting for the person, for channels that show buttons. */
  pending?: { action: string; summary: LocalizedText; expiresAt?: string; stage: PendingAction['stage'] };
  /** Changes executed in this turn. */
  executed: Array<{ action: string; ok: boolean; code?: string }>;
  usage: TurnUsage;
  /** Figures in the reply that no tool returned (after one corrective retry). Empty when all check out. */
  unverifiedNumbers: string[];
}

export interface Assistant {
  handleTurn(input: TurnInput): Promise<TurnResult>;
}

const REMEMBER_SPEC: ToolSpec = {
  name: REMEMBER_TOOL,
  description: 'Save a short note the person explicitly asked you to remember, for future conversations.',
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string', minLength: 1, maxLength: MAX_NOTE_LENGTH } },
    required: ['note'],
    additionalProperties: false,
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAssistant(options: AssistantOptions): Assistant {
  const model = options.model;
  const conversations = options.conversations ?? createMemoryConversationStore();
  const notes = options.notes ?? createMemoryNoteStore();
  const maxSteps = options.maxSteps ?? 6;
  const maxTools = options.maxTools ?? 24;
  const maxHistory = options.maxHistoryMessages ?? 40;
  const maxResult = options.maxToolResultChars ?? 6000;
  const maxTokens = options.maxTokens ?? 1024;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const onError = options.onError ?? (() => {});

  async function handleTurn(input: TurnInput): Promise<TurnResult> {
    const turnId = input.turnId ?? newId();
    const usage = emptyUsage();
    const executed: TurnResult['executed'] = [];
    const actions = input.actions;

    let state = await conversations.get(input.conversationId);
    if (!state || state.tenantId !== input.tenantId || state.userId !== input.userId) {
      state = { id: input.conversationId, tenantId: input.tenantId, userId: input.userId, messages: [], updatedAt: now().toISOString() };
    }
    const conv: ConversationState = state;

    const finish = async (
      reply: string,
      status: TurnStatus,
      language: Locale,
      extra: { unverified?: string[]; record?: boolean } = {},
    ): Promise<TurnResult> => {
      conv.language = language;
      conv.updatedAt = now().toISOString();
      conv.messages = trimHistory(conv.messages, maxHistory);
      await conversations.put(conv);
      usage.costUsd = costUsd(usage, options.pricing);
      if (extra.record !== false) await recordUsage(actions, turnId, conv.id, usage);
      const result: TurnResult = {
        turnId,
        reply,
        language,
        status,
        executed,
        usage,
        unverifiedNumbers: extra.unverified ?? [],
      };
      if (conv.pending) {
        const p: NonNullable<TurnResult['pending']> = { action: conv.pending.action, summary: conv.pending.summary, stage: conv.pending.stage };
        if (conv.pending.confirmation) p.expiresAt = conv.pending.confirmation.expiresAt;
        result.pending = p;
      }
      return result;
    };

    // ── 1. Who, where, and is the assistant allowed at all ──────────────────
    let context: CoreContextOutput | undefined;
    try {
      const r = await actions.execute({ action: WELL_KNOWN_ACTIONS.contextGet, input: {} });
      if (r.ok) {
        const parsed = CoreContextSchema.safeParse(r.data);
        if (parsed.success) context = parsed.data;
      } else if (r.error.code === 'ASSISTANT_POLICY_DENIED') {
        const language = detectLanguage(input.text, conv.language ?? 'en');
        return finish(phrase('disabled', language), 'refused', language, { record: false });
      }
    } catch (e) {
      onError(e, 'context');
      const language = detectLanguage(input.text, conv.language ?? 'en');
      return finish(phrase('unavailable', language), 'unavailable', language, { record: false });
    }

    const settings = context?.assistant?.settings ?? { ...AssistantSettings.parse({}), enabled: true };
    const language: Locale =
      settings.language === 'auto' ? detectLanguage(input.text, conv.language ?? context?.user.locale ?? 'en') : settings.language;

    if (!settings.enabled) return finish(phrase('disabled', language), 'refused', language, { record: false });
    if (context?.assistant?.quota.state === 'exhausted') return finish(phrase('quota', language), 'refused', language, { record: false });

    // ── 2. A change waiting for this person ─────────────────────────────────
    const prefix: ContentBlock[] = [];
    if (conv.pending) {
      const p = conv.pending;
      const answer = parseConfirmation(input.text);

      if (answer === 'no') {
        conv.messages.push({
          role: 'user',
          content: [toolResult(p.toolCallId, 'The person declined. Nothing was executed.'), { type: 'text', text: input.text }],
        });
        const reply = phrase('cancelled', language);
        conv.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
        delete conv.pending;
        return finish(reply, 'cancelled', language);
      }

      if (p.stage === 'confirm' && answer === 'other') {
        prefix.push(toolResult(p.toolCallId, 'The person did not confirm and wrote something else instead. NOTHING was executed. Treat their message as a new request.'));
        delete conv.pending;
      } else {
        // "yes" to a confirmation, or anything but "no" while waiting for approval in the app.
        const outcome = await executePending(actions, p);
        if (outcome.kind === 'reconfirm') {
          conv.pending = {
            ...p,
            stage: 'confirm',
            confirmation: { id: outcome.preview.confirmationId, fingerprint: outcome.preview.fingerprint, expiresAt: outcome.preview.expiresAt },
            summary: outcome.preview.preview.summary,
            preview: outcome.preview.preview,
          };
          const reply = confirmationMessage(outcome.preview.preview, language, { stepUp: outcome.preview.stepUp.required, lead: outcome.lead });
          return finish(reply, 'awaiting_confirmation', language);
        }
        if (outcome.kind === 'step-up') {
          const lead: PhraseKey = p.stage === 'step-up' ? 'stepUpStillWaiting' : 'stepUpWaiting';
          conv.pending = { ...p, stage: 'step-up' };
          return finish(phrase(lead, language), 'awaiting_approval', language);
        }
        if (outcome.kind === 'unavailable') return finish(phrase('unavailable', language), 'unavailable', language, { record: false });
        executed.push(outcome.result.ok ? { action: p.action, ok: true } : { action: p.action, ok: false, code: outcome.result.error.code });
        prefix.push(toolResult(p.toolCallId, renderResult(outcome.result, maxResult), !outcome.result.ok));
        delete conv.pending;
      }
    }

    // ── 3. Think, with tools ────────────────────────────────────────────────
    let catalog: CatalogEntry[];
    try {
      catalog = (await actions.list()).actions;
    } catch (e) {
      onError(e, 'list');
      return finish(phrase('unavailable', language), 'unavailable', language, { record: false });
    }
    const recentText = [input.text, ...recentUserTexts(conv.messages, 3)].join(' ');
    const tools = selectTools(catalog, recentText, maxTools);
    const byTool = new Map(tools.map((e) => [toToolName(e.name), e]));
    const toolSpecs = [...tools.map(toToolSpec), REMEMBER_SPEC];
    const system = buildSystemPrompt({
      settings,
      context,
      language,
      notes: await notes.list(input.tenantId, input.userId),
    });

    conv.messages.push({ role: 'user', content: [...prefix, { type: 'text', text: input.text }] });
    const sources: string[] = [input.text, context?.today ?? '', ...toolResultTexts(conv.messages)];

    let reply = '';
    let unverified: string[] = [];
    let checkAt: number | undefined;

    for (let step = 0; step < maxSteps; step++) {
      const res = await model.complete({ system, messages: trimHistory(conv.messages, maxHistory), tools: toolSpecs, maxTokens });
      addUsage(usage, res.usage, res.model);
      const content = res.content.filter((b) => b.type !== 'text' || b.text.trim() !== '');
      if (content.length === 0) break;
      conv.messages.push({ role: 'assistant', content });
      const call = content.find((b): b is ToolCallBlock => b.type === 'tool_call');

      if (!call) {
        reply = textOf(content);
        const bad = unverifiedNumbers(reply, sources);
        if (bad.length > 0 && checkAt === undefined) {
          checkAt = conv.messages.length - 1;
          conv.messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `[system check — not from the person] Your reply contains figures that no tool returned: ${bad.join(', ')}. Rewrite it using only figures exactly as tools returned them, or call a tool that returns the figure. Do not mention this check.`,
              },
            ],
          });
          continue;
        }
        unverified = bad;
        break;
      }

      if (call.name === REMEMBER_TOOL) {
        const note = typeof (call.input as { note?: unknown })?.note === 'string' ? ((call.input as { note: string }).note) : '';
        if (note.trim()) await notes.add(input.tenantId, input.userId, note.trim());
        conv.messages.push({ role: 'user', content: [toolResult(call.id, note.trim() ? 'Saved.' : 'Nothing to save.')] });
        continue;
      }

      const entry = byTool.get(call.name);
      if (!entry) {
        conv.messages.push({ role: 'user', content: [toolResult(call.id, `No tool named ${call.name}.`, true)] });
        continue;
      }

      if (entry.kind === 'query') {
        let result: ActionResult<unknown>;
        try {
          result = await actions.execute({ action: entry.name, version: entry.version, input: call.input ?? {} });
        } catch (e) {
          onError(e, `execute ${entry.name}`);
          return finish(phrase('unavailable', language), 'unavailable', language);
        }
        if (!result.ok && result.error.code === 'ASSISTANT_QUOTA_EXCEEDED') {
          conv.messages.push({ role: 'user', content: [toolResult(call.id, renderResult(result, maxResult), true)] });
          const msg = phrase('quota', language);
          conv.messages.push({ role: 'assistant', content: [{ type: 'text', text: msg }] });
          return finish(msg, 'refused', language);
        }
        const content = renderResult(result, maxResult);
        sources.push(content);
        conv.messages.push({ role: 'user', content: [toolResult(call.id, content, !result.ok)] });
        continue;
      }

      // A change: never executed here. Preview it and ask the person.
      const proposal = await propose(actions, entry, call);
      if (proposal.kind === 'error') {
        const content = renderResult(proposal.result, maxResult);
        sources.push(content);
        conv.messages.push({ role: 'user', content: [toolResult(call.id, content, true)] });
        continue;
      }
      if (proposal.kind === 'unavailable') return finish(phrase('unavailable', language), 'unavailable', language);
      conv.pending = proposal.pending;
      const replyText =
        proposal.preview !== undefined
          ? confirmationMessage(proposal.preview.preview, language, { stepUp: proposal.preview.stepUp.required })
          : [phrase('confirmIntro', language), pick(proposal.pending.summary, language), phrase('confirmQuestion', language)].join('\n');
      return finish(replyText, 'awaiting_confirmation', language);
    }

    if (checkAt !== undefined) conv.messages.splice(checkAt, 2); // drop the flawed draft and the check
    if (!reply) {
      reply = phrase('noAnswer', language);
      const last = conv.messages[conv.messages.length - 1];
      if (last?.role === 'user') conv.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
    }
    if (unverified.length > 0) reply = `${reply}\n${phrase('unverified', language)}`;
    return finish(reply, 'answered', language, { unverified });
  }

  // ── helpers bound to options ──────────────────────────────────────────────

  async function executePending(
    actions: ActionsClient,
    p: PendingAction,
  ): Promise<
    | { kind: 'done'; result: ActionResult<unknown> }
    | { kind: 'reconfirm'; preview: PreviewResult; lead: PhraseKey }
    | { kind: 'step-up' }
    | { kind: 'unavailable' }
  > {
    const req: ExecuteRequest = { action: p.action, version: p.version, input: p.input, idempotencyKey: p.idempotencyKey };
    if (p.confirmation) req.confirmation = { id: p.confirmation.id, fingerprint: p.confirmation.fingerprint };
    let result: ActionResult<unknown>;
    try {
      result = await actions.execute(req);
    } catch (e) {
      onError(e, `execute ${p.action}`);
      return { kind: 'unavailable' };
    }
    if (result.ok) return { kind: 'done', result };
    switch (result.error.code) {
      case 'PREVIEW_STALE':
        if (isPreviewResult(result.error.details)) return { kind: 'reconfirm', preview: result.error.details, lead: 'changed' };
        break;
      case 'PREVIEW_EXPIRED': {
        try {
          const again = await actions.preview({ action: p.action, version: p.version, input: p.input });
          if (again.ok) return { kind: 'reconfirm', preview: again.data, lead: 'expired' };
          return { kind: 'done', result: again };
        } catch (e) {
          onError(e, `preview ${p.action}`);
          return { kind: 'unavailable' };
        }
      }
      case 'STEP_UP_REQUIRED':
        return { kind: 'step-up' };
    }
    return { kind: 'done', result };
  }

  async function propose(
    actions: ActionsClient,
    entry: CatalogEntry,
    call: ToolCallBlock,
  ): Promise<
    | { kind: 'pending'; pending: PendingAction; preview?: PreviewResult }
    | { kind: 'error'; result: ActionResult<unknown> }
    | { kind: 'unavailable' }
  > {
    const base = {
      stage: 'confirm' as const,
      toolCallId: call.id,
      action: entry.name,
      version: entry.version,
      input: call.input ?? {},
      idempotencyKey: newId(),
      createdAt: now().toISOString(),
    };
    if (!entry.hasPreview) {
      const summary = describeRequest(entry, call.input);
      return { kind: 'pending', pending: { ...base, summary } };
    }
    let p: ActionResult<PreviewResult>;
    try {
      p = await actions.preview({ action: entry.name, version: entry.version, input: call.input ?? {} });
    } catch (e) {
      onError(e, `preview ${entry.name}`);
      return { kind: 'unavailable' };
    }
    if (!p.ok) return { kind: 'error', result: p };
    return {
      kind: 'pending',
      preview: p.data,
      pending: {
        ...base,
        confirmation: { id: p.data.confirmationId, fingerprint: p.data.fingerprint, expiresAt: p.data.expiresAt },
        summary: p.data.preview.summary,
        preview: p.data.preview,
      },
    };
  }

  async function recordUsage(actions: ActionsClient, turnId: string, conversationId: string, usage: TurnUsage): Promise<void> {
    try {
      const r = await actions.execute({
        action: WELL_KNOWN_ACTIONS.usageRecord,
        idempotencyKey: `usage:${turnId}`,
        input: {
          turnId,
          kind: 'reply',
          conversationId: conversationId.slice(0, 100),
          model: usage.model || 'none',
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          costUsd: usage.costUsd,
          occurredAt: now().toISOString(),
        },
      });
      if (!r.ok && r.error.code !== 'UNKNOWN_ACTION') onError(new Error(`usage not recorded: ${r.error.code}`), 'usage');
    } catch (e) {
      onError(e, 'usage');
    }
  }

  return { handleTurn };
}

// ─────────────────────────────────────────────────────────────────────────────

function toolResult(toolCallId: string, content: string, isError = false): ContentBlock {
  return isError ? { type: 'tool_result', toolCallId, content, isError: true } : { type: 'tool_result', toolCallId, content };
}

/** What the model reads from an action result: the data, or the error in both languages. */
export function renderResult(result: ActionResult<unknown>, max: number): string {
  const body = result.ok
    ? result.data
    : {
        error: {
          code: result.error.code,
          message: result.error.messages.en,
          messageUr: result.error.messages.ur,
          retryable: result.error.retryable ?? false,
          ...(result.error.details !== undefined ? { details: result.error.details } : {}),
        },
      };
  const text = JSON.stringify(body);
  return text.length <= max ? text : `${text.slice(0, max)}…(truncated)`;
}

function isPreviewResult(v: unknown): v is PreviewResult {
  return typeof v === 'object' && v !== null && 'confirmationId' in v && 'fingerprint' in v && 'preview' in v;
}

/** For a change without a preview: the action's description and the readable parts of the request. */
function describeRequest(entry: CatalogEntry, input: unknown): LocalizedText {
  const parts =
    input && typeof input === 'object'
      ? Object.entries(input as Record<string, unknown>)
          .filter(([, v]) => !(typeof v === 'string' && UUID.test(v)) && (typeof v !== 'object' || v === null))
          .map(([k, v]) => `${k}: ${String(v)}`)
      : [];
  const text = parts.length > 0 ? `${entry.description} (${parts.join(', ')})` : entry.description;
  return { en: text, ur: text };
}

/** Everything the app returned in this conversation — results and errors alike — for the numbers guard. */
function toolResultTexts(messages: readonly ModelMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) for (const b of m.content) if (b.type === 'tool_result') out.push(b.content);
  return out;
}

function recentUserTexts(messages: readonly ModelMessage[], n: number): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < n; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    const t = textOf(m.content);
    if (t && !t.startsWith('[system check')) out.push(t);
  }
  return out;
}

/**
 * Keep the last `max` messages, cut only where a person's own message starts
 * (never between a tool call and its result).
 */
export function trimHistory(messages: ModelMessage[], max: number): ModelMessage[] {
  if (messages.length <= max) return messages;
  for (let i = messages.length - max; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'user' && !m.content.some((b) => b.type === 'tool_result')) return messages.slice(i);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !m.content.some((b) => b.type === 'tool_result')) return messages.slice(i);
  }
  return messages.slice(-1);
}
