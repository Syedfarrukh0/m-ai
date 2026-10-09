/**
 * 0.1.2 — the assistant's wallet (agreed with the ERP on 7 Oct 2026):
 * `assistant.usage.record` may carry what the company was charged for the turn
 * and its balance after, as money strings with an ISO currency code.
 */
import { describe, expect, it } from 'vitest';
import { AssistantUsageRecordInput, CONTRACT_VERSION, CurrencyCode } from '../src/index.js';
import { makeApp } from './fixtures/app.js';

const BASE = {
  turnId: 't-1',
  kind: 'reply' as const,
  model: 'openai/gpt-oss-120b',
  inputTokens: 5000,
  cachedInputTokens: 0,
  outputTokens: 300,
  costUsd: '0.0010',
  occurredAt: '2026-10-07T10:00:00+05:00',
};

describe('0.1.2 wallet fields on assistant.usage.record', () => {
  it('is version 0.1.2 or later', () => {
    expect(CONTRACT_VERSION >= '0.1.2').toBe(true);
  });

  it('a 0.1.1 record is still valid', () => {
    expect(AssistantUsageRecordInput.safeParse(BASE).success).toBe(true);
  });

  it('takes the charge and the balance after, as money strings', () => {
    const r = AssistantUsageRecordInput.safeParse({ ...BASE, charge: { amount: '0.31', currency: 'PKR' }, balanceAfter: '1999.69' });
    expect(r.success).toBe(true);
  });

  it('a balance may dip below zero on the reply that crosses it', () => {
    expect(AssistantUsageRecordInput.safeParse({ ...BASE, charge: { amount: '0.31', currency: 'PKR' }, balanceAfter: '-0.21' }).success).toBe(true);
  });

  it('never a float, never a lower-case or unknown-shaped currency', () => {
    expect(AssistantUsageRecordInput.safeParse({ ...BASE, charge: { amount: 0.31, currency: 'PKR' } }).success).toBe(false);
    expect(AssistantUsageRecordInput.safeParse({ ...BASE, charge: { amount: '0.31', currency: 'pkr' } }).success).toBe(false);
    expect(CurrencyCode.safeParse('Rs').success).toBe(false);
    expect(AssistantUsageRecordInput.safeParse({ ...BASE, balanceAfter: 1999.69 }).success).toBe(false);
  });

  it('a balance needs a charge, for its currency', () => {
    const r = AssistantUsageRecordInput.safeParse({ ...BASE, balanceAfter: '1999.69' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['balanceAfter']);
  });

  it('the catalog describes the new fields', () => {
    const { registry } = makeApp();
    const entry = registry.catalog().actions.find((a) => a.name === 'assistant.usage.record');
    const props = (entry?.input as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['charge', 'balanceAfter']));
  });
});
