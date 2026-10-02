import type { ModelUsage } from './model.js';

/** USD per million tokens, as decimal strings ("3", "0.30"). Set from your provider's price list. */
export interface ModelPricing {
  inputPerMTok: string;
  cachedInputPerMTok: string;
  outputPerMTok: string;
}

export interface TurnUsage extends ModelUsage {
  modelCalls: number;
  /** USD, 4 decimal places, rounded up. "0.0000" without pricing. */
  costUsd: string;
  model: string;
}

const SCALE = 10_000n; // 4 decimal places of a dollar

function scaled(price: string): bigint {
  if (!/^\d{1,6}(?:\.\d{1,4})?$/.test(price)) throw new TypeError(`bad price ${price}`);
  const [whole = '0', fraction = ''] = price.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));
}

/** Exact cost: tokens × price per million, rounded UP to 1/10000 of a dollar. */
export function costUsd(usage: ModelUsage, pricing: ModelPricing | undefined): string {
  if (!pricing) return '0.0000';
  const total =
    BigInt(usage.inputTokens) * scaled(pricing.inputPerMTok) +
    BigInt(usage.cachedInputTokens) * scaled(pricing.cachedInputPerMTok) +
    BigInt(usage.outputTokens) * scaled(pricing.outputPerMTok);
  const million = 1_000_000n;
  const units = (total + million - 1n) / million;
  return `${units / SCALE}.${(units % SCALE).toString().padStart(4, '0')}`;
}

export function emptyUsage(): TurnUsage {
  return { modelCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: '0.0000', model: '' };
}

export function addUsage(into: TurnUsage, usage: ModelUsage, model: string): void {
  into.modelCalls += 1;
  into.inputTokens += usage.inputTokens;
  into.cachedInputTokens += usage.cachedInputTokens;
  into.outputTokens += usage.outputTokens;
  into.model = model;
}
