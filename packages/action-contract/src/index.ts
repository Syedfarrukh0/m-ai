/**
 * @m-ai/action-contract
 *
 * The one surface through which anything — an app's own web, mobile and
 * desktop clients, its public API, and the M.Ai assistant — discovers,
 * previews and executes the app's operations.
 *
 * Pure TypeScript + zod. No app, framework, database, network or AI
 * dependency. Semver: a breaking change to anything exported here is a major
 * version (a minor while in 0.x).
 */

export * from './vocabulary.js';
export * from './schemas.js';
export * from './errors.js';
export type * from './context.js';
export * from './definition.js';
export * from './results.js';
export * from './catalog.js';
export type * from './host.js';
export * from './confirmation.js';
export * from './assistant.js';
export * from './delegation.js';
export * from './webhooks.js';
export * from './transport.js';
export { createActionRegistry, redact } from './registry.js';
export type { ActionRegistry, RegistryOptions } from './registry.js';
export { canonicalJson, sha256Hex } from './crypto.js';
