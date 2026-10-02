/**
 * Measure accuracy with a real model.
 *
 *   pnpm --filter @m-ai/assistant-core eval              # every scenario once
 *   pnpm --filter @m-ai/assistant-core eval -- --repeat 3 --only "order"
 *
 * Exit code 1 if any check fails. Settings come from .env.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './env.js';
import { runScenario } from './eval-runner.js';
import type { CheckResult, Scenario } from './eval-runner.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const repeat = Math.max(1, Number(flag('--repeat') ?? 1));
const only = flag('--only');
const verbose = args.includes('--verbose');

const config = loadConfig();
const file = flag('--file') ?? fileURLToPath(new URL('../evals/scenarios.json', import.meta.url));
const scenarios = (JSON.parse(readFileSync(file, 'utf8')) as Scenario[]).filter((s) => !only || s.name.includes(only));

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

console.log(`\nM.Ai evals — ${config.provider} / ${config.modelId} — ${scenarios.length} scenarios × ${repeat}\n`);
const all: CheckResult[] = [];
let scenarioPasses = 0;
let runs = 0;

for (const scenario of scenarios) {
  for (let n = 0; n < repeat; n++) {
    runs++;
    try {
      const { results, transcript } = await runScenario(scenario, {
        model: config.model,
        languages: config.languages,
        ...(config.pricing ? { pricing: config.pricing } : {}),
        ...(config.instructions ? { instructions: config.instructions } : {}),
        onError: () => {},
      });
      all.push(...results);
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) scenarioPasses++;
      console.log(`${failed.length === 0 ? green('PASS') : red('FAIL')} ${scenario.name}${repeat > 1 ? dim(` (run ${n + 1})`) : ''}`);
      for (const f of failed) console.log(red(`     ✗ turn ${f.turn}: ${f.check}`) + dim(f.detail ? ` — ${f.detail.slice(0, 200)}` : ''));
      if (verbose || failed.length > 0) for (const line of transcript) console.log(dim(`       ${line.replace(/\n/g, ' ')}`));
    } catch (e) {
      all.push({ scenario: scenario.name, turn: 0, check: 'ran without error', ok: false, detail: (e as Error).message });
      console.log(`${red('ERROR')} ${scenario.name}: ${(e as Error).message}`);
    }
  }
}

const checks = all.length;
const passed = all.filter((r) => r.ok).length;
console.log(`\n${scenarioPasses}/${runs} scenario runs passed · ${passed}/${checks} checks passed (${checks ? ((passed / checks) * 100).toFixed(1) : '0'}%)\n`);
process.exit(passed === checks ? 0 : 1);
