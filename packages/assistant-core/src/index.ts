/**
 * @m-ai/assistant-core — M.Ai's brain.
 *
 * Turns a person's message into answers and confirmed actions over any app
 * that speaks @m-ai/action-contract. It never touches a database, never
 * calculates a figure, and never changes anything without the person's
 * explicit "yes" to an exact preview.
 */
export { createAssistant, renderResult, trimHistory } from './assistant.js';
export type { Assistant, AssistantEvent, AssistantOptions, TurnInput, TurnResult, TurnStatus } from './assistant.js';
export { createHttpActionsClient, createInProcessActionsClient, TransportError } from './actions-client.js';
export type { ActionsClient, HttpActionsClientOptions } from './actions-client.js';
export { createAnthropicModel, fromAnthropicResponse, toAnthropicBody, ModelError } from './anthropic.js';
export type { AnthropicOptions } from './anthropic.js';
export type * from './model.js';
export { textOf } from './model.js';
export { createOpenAICompatibleModel, fromChatResponse, toChatBody } from './openai.js';
export type { OpenAICompatibleOptions } from './openai.js';
export { ConfigError, configFromEnv, loadEnvFile, loadLanguagePacks } from './config.js';
export type { M_AI_Config, Provider } from './config.js';
export {
  BUILTIN_LANGUAGES,
  ENGLISH,
  LanguagePackSchema,
  PHRASES,
  PHRASE_KEYS,
  ROMAN_URDU,
  URDU,
  createLanguages,
  detectLanguage,
  normalizeText,
  parseConfirmation,
} from './languages.js';
export type { LanguagePack, Languages, PhraseKey } from './languages.js';
export { numbersIn, numbersInValue, normalizeNumber, unverifiedNumbers, westernDigits } from './numbers.js';
export { DEFAULT_SYNONYMS, HIDDEN_ACTIONS, fromToolName, selectTools, toToolName, toToolSpec } from './tools.js';
export { REMEMBER_TOOL, buildSystemPrompt } from './prompt.js';
export type { PromptInput } from './prompt.js';
export { MAX_NOTES, MAX_NOTE_LENGTH, createMemoryConversationStore, createMemoryNoteStore } from './store.js';
export type { ConversationState, ConversationStore, NoteStore, PendingAction } from './store.js';
export { addUsage, costUsd, emptyUsage } from './usage.js';
export type { ModelPricing, TurnUsage } from './usage.js';
