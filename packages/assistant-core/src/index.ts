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
export type { ActionsClient, DocumentResult, HttpActionsClient, HttpActionsClientOptions } from './actions-client.js';
export { createAnthropicModel, fromAnthropicResponse, listAnthropicModels, toAnthropicBody, ModelError } from './anthropic.js';
export type { AnthropicOptions } from './anthropic.js';
export type * from './model.js';
export { estimateTokens, fitRequest, withInputBudget } from './fit.js';
export { httpModelError, isDailyLimitMessage, tooLargeInfo, isNoCreditMessage, isRateLimitMessage, providerMessage, retryAfter, textOf, waitHintMs } from './model.js';
export { createOpenAICompatibleModel, fromChatResponse, listOpenAICompatibleModels, stripThinking, toChatBody } from './openai.js';
export type { OpenAICompatibleOptions } from './openai.js';
export { createOllamaModel, fromOllamaResponse, listOllamaModels, ollamaBase, toOllamaBody } from './ollama.js';
export type { OllamaOptions } from './ollama.js';
export { ConfigError, configFromEnv, loadEnvFile, loadLanguagePacks, preflight } from './config.js';
export type { M_AI_Config, PreflightResult, PreflightTarget } from './config.js';
export {
  PROVIDERS,
  PROVIDER_NAMES,
  buildModel,
  checkProviderSettings,
  createModel,
  defaultProvider,
  parseModelSpec,
  parsePrices,
  providerModels,
  withFallback,
} from './providers.js';
export type { FallbackOptions, ModelSetup, Provider, ProviderPreset, RouteEntry, ThinkingLevel } from './providers.js';
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
  OPTIONAL_PHRASES,
  parseConfirmation,
} from './languages.js';
export type { LanguagePack, Languages, PhraseKey } from './languages.js';
export { numbersIn, numbersInValue, normalizeNumber, unverifiedNumbers, westernDigits } from './numbers.js';
export { DEFAULT_SYNONYMS, HIDDEN_ACTIONS, HIDDEN_TAGS, runsWithoutAsking, fromToolName, modelSchema, selectTools, toToolName, toToolSpec } from './tools.js';
export { REMEMBER_TOOL, buildSystemPrompt } from './prompt.js';
export { dateRanges, isoDatesIn, weekday } from './dates.js';
export type { DateRange } from './dates.js';
export type { PromptInput } from './prompt.js';
export { MAX_NOTES, MAX_NOTE_LENGTH, createMemoryConversationStore, createMemoryNoteStore } from './store.js';
export type { ConversationState, ConversationStore, NoteStore, PendingAction } from './store.js';
export { addUsage, chargeFor, checkBilling, costUnits, costUsd, emptyUsage, formatCents, formatCost, groupThousands, toCents } from './usage.js';
export type { Billing, ModelPricing, TurnUsage } from './usage.js';
export { DEFAULT_ERP_USERS, ERP_CLIENT_ID, ErpError, decodeJwt, erpSettingsFromEnv, loginErp, userEmail } from './erp-live.js';
export type { DelegatedClaims, ErpSession, ErpSettings } from './erp-live.js';
