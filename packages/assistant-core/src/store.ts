import type { ActionPreview, LocalizedText } from '@m-ai/action-contract';
import type { ModelMessage } from './model.js';

/** A change waiting for the person: their "yes", or their approval in the app. */
export interface PendingAction {
  stage: 'confirm' | 'step-up';
  /** The open tool call this change answers; closed with a tool result on the next turn. */
  toolCallId: string;
  action: string;
  version: number;
  input: unknown;
  /** Absent for commands without a preview (the person confirms the request itself). */
  confirmation?: { id: string; fingerprint: string; expiresAt: string };
  idempotencyKey: string;
  summary: LocalizedText;
  preview?: ActionPreview;
  createdAt: string;
}

export interface ConversationState {
  id: string;
  /** A conversation belongs to one person in one company. */
  tenantId: string;
  userId: string;
  messages: ModelMessage[];
  pending?: PendingAction;
  /** Language pack code of the last reply. */
  language?: string;
  updatedAt: string;
}

export interface ConversationStore {
  get(id: string): Promise<ConversationState | undefined>;
  put(state: ConversationState): Promise<void>;
  delete(id: string): Promise<void>;
}

export function createMemoryConversationStore(): ConversationStore & { readonly size: number } {
  const map = new Map<string, ConversationState>();
  return {
    get: async (id) => {
      const s = map.get(id);
      return s ? structuredClone(s) : undefined;
    },
    put: async (state) => {
      map.set(state.id, structuredClone(state));
    },
    delete: async (id) => {
      map.delete(id);
    },
    get size() {
      return map.size;
    },
  };
}

/** Things a person explicitly asked the assistant to remember. Per person, per company. */
export interface NoteStore {
  list(tenantId: string, userId: string): Promise<string[]>;
  add(tenantId: string, userId: string, note: string): Promise<void>;
}

export const MAX_NOTES = 20;
export const MAX_NOTE_LENGTH = 200;

export function createMemoryNoteStore(): NoteStore {
  const map = new Map<string, string[]>();
  return {
    list: async (t, u) => [...(map.get(`${t}:${u}`) ?? [])],
    add: async (t, u, note) => {
      const key = `${t}:${u}`;
      const notes = (map.get(key) ?? []).filter((n) => n !== note);
      notes.push(note.slice(0, MAX_NOTE_LENGTH));
      map.set(key, notes.slice(-MAX_NOTES));
    },
  };
}
