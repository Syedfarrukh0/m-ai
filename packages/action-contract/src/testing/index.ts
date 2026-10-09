/**
 * @m-ai/action-contract/testing
 *
 * Test helpers: an in-memory host with real rollback, and the contract-check
 * harness every app runs over its commands.
 */
export { InMemoryHost } from './in-memory-host.js';
export type { InMemoryHostOptions, LicenceState, OutboxRow, StepUpRow } from './in-memory-host.js';
export { runContractChecks } from './contract-checks.js';
export { createFakeWallet } from './fake-wallet.js';
export type { FakeWallet, FakeWalletOptions, FakeWalletRequest } from './fake-wallet.js';
export type {
  CommandFixture,
  ContractCheckHost,
  ContractCheckName,
  ContractCheckReport,
  ContractCheckResult,
} from './contract-checks.js';
