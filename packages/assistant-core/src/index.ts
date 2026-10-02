/**
 * @m-ai/assistant-core — M.Ai's brain.
 *
 * Turns a person's message into answers and confirmed actions over any app
 * that speaks @m-ai/action-contract. It never touches a database, never
 * calculates a figure, and never changes anything without the person's
 * explicit "yes" to an exact preview.
 */
export { createAssistant, renderResult, trimHistory } from './assistant.js';
export type { Assistant, AssistantOptions, TurnInput, TurnResult, TurnStatus } from './assistant.js';
export { createHttpActionsClient, createInProcessActionsClient, TransportError } from './actions-client.js';
export type { ActionsClient, HttpActionsClientOptions } from './actions-client.js';
export { createAnthropicModel, fromAnthropicResponse, toAnthropicBody, ModelError } from './anthropic.js';
export type { AnthropicOptions } from './anthropic.js';
export type * from './model.js';
export { textOf } from './model.js';
export { detectLanguage, parseConfirmation } from './language.js';
export { PHRASES, phrase, pick, confirmationMessage } from './phrases.js';
export type { PhraseKey } from './phrases.js';
export { numbersIn, numbersInValue, normalizeNumber, unverifiedNumbers, westernDigits } from './numbers.js';
export { HIDDEN_ACTIONS, SYNONYMS, fromToolName, selectTools, toToolName, toToolSpec } from './tools.js';
export { REMEMBER_TOOL, buildSystemPrompt } from './prompt.js';
export type { PromptInput } from './prompt.js';
export { MAX_NOTES, MAX_NOTE_LENGTH, createMemoryConversationStore, createMemoryNoteStore } from './store.js';
export type { ConversationState, ConversationStore, NoteStore, PendingAction } from './store.js';
export { addUsage, costUsd, emptyUsage } from './usage.js';
export type { ModelPricing, TurnUsage } from './usage.js';
