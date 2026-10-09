/**
 * Measure accuracy with a real model.
 *
 *   pnpm --filter @m-ai/assistant-core eval              # every scenario once, the model in .env
 *   pnpm --filter @m-ai/assistant-core eval -- --repeat 3 --only "order"
 *   pnpm --filter @m-ai/assistant-core eval -- --model zai:glm-4.5-flash   # another model, same .env keys
 *   pnpm --filter @m-ai/assistant-core eval -- --pause 90   # wait longer after a rate limit (default 60 s)
 *   pnpm --filter @m-ai/assistant-core eval -- --erp        # the real ERP in M_AI_ERP_URL (evals/live.json)
 *   pnpm --filter @m-ai/assistant-core eval -- --erp --from officer   # carry on from a scenario (after a daily limit)
 *
 * With --erp, the conversations use real records found in the ERP first.
 * They post ONE receipt of 100 on that company and may leave one approval
 * waiting; everything else is only previewed and declined.
 *
 * One model is measured at a time: fallbacks are not used here.
 * Exit code 1 if any check fails. Settings come from .env.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError, createModel, isDailyLimitMessage, isNoCreditMessage, waitHintMs } from '../src/index.js';
import type { ModelSetup } from '../src/index.js';
import { checkOne, loadConfig } from './env.js';
import { runScenario } from './eval-runner.js';
import type { CheckResult, LiveTarget, Scenario } from './eval-runner.js';
import { discoverVars } from './erp-discover.js';
import { ErpError, erpSettingsFromEnv, loginErp, userEmail } from '../src/erp-live.js';
import type { ErpSession } from '../src/erp-live.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const repeat = Math.max(1, Number(flag('--repeat') ?? 1));
const only = flag('--only');
/** Start at this scenario: to finish a run that a provider's daily limit stopped, without paying again for the rest. */
const from = flag('--from');
const verbose = args.includes('--verbose');
/** Seconds to wait after a rate-limited scenario (free plans count tokens per minute). */
const pauseSeconds = Math.max(0, Number(flag('--pause') ?? 60));

const config = loadConfig();
let target: ModelSetup = config.primary;
const spec = flag('--model');
if (spec) {
  try {
    target = createModel(spec, process.env);
  } catch (e) {
    console.error(`\x1b[31m${e instanceof ConfigError ? e.problems.join('\n') : (e as Error).message}\x1b[0m`);
    process.exit(1);
  }
}
if (!(await checkOne(target))) process.exit(1);

// ── A real ERP (--erp): sign in, find records to talk about ─────────────────
let live: LiveTarget | undefined;
if (args.includes('--erp')) {
  const next = flag('--erp');
  const settings = erpSettingsFromEnv(process.env, next && !next.startsWith('--') ? next : undefined);
  if ('missing' in settings) {
    console.error(`\x1b[31mMissing in .env: ${settings.missing.join(', ')}\x1b[0m`);
    process.exit(1);
  }
  const sessions = new Map<string, ErpSession>();
  const sessionFor = async (role: string) => {
    const email = userEmail(settings, role);
    if (!email) throw new Error(`no e-mail for "${role}" (set M_AI_ERP_${role.toUpperCase()})`);
    let s = sessions.get(email);
    if (!s) {
      s = await loginErp(settings, email);
      sessions.set(email, s);
    }
    return s;
  };
  try {
    const owner = await sessionFor('owner');
    const { vars, notes } = await discoverVars(owner.actions(`eval-discover-${Date.now()}`));
    console.log(`\nThe ERP at ${settings.baseUrl}, company ${settings.tenantCode}. Found: ${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(', ') || 'nothing'}`);
    for (const n of notes) console.log(`\x1b[33m  ${n}\x1b[0m`);
    live = {
      vars,
      connect: async (role, conversationId) => {
        const s = await sessionFor(role);
        const claims = await s.claims(conversationId);
        return { actions: s.actions(conversationId), tenantId: claims.tid, userId: claims.sub };
      },
    };
  } catch (e) {
    console.error(`\x1b[31mERP: ${(e as Error).message}\x1b[0m`);
    if (e instanceof ErpError && e.status !== undefined) console.error(`  ${e.step} → HTTP ${e.status} ${e.body ?? ''}`);
    process.exit(1);
  }
}

const defaultFile = live ? '../evals/live.json' : '../evals/scenarios.json';
const file = flag('--file') ?? fileURLToPath(new URL(defaultFile, import.meta.url));
const allScenarios = (JSON.parse(readFileSync(file, 'utf8')) as Scenario[]).filter((s) => !only || s.name.includes(only));
const start = from ? allScenarios.findIndex((s) => s.name.includes(from)) : 0;
if (start < 0) {
  console.error(`\x1b[31mNo scenario matches --from ${from}\x1b[0m`);
  process.exit(1);
}
const scenarios = allScenarios.slice(start);

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const tty = process.stdout.isTTY;

console.log(`\nM.Ai evals — ${target.spec}${target.thinking ? ' (thinking on)' : ''} — ${scenarios.length} scenarios × ${repeat}${live ? ' — real ERP' : ''}\n`);
const measured: CheckResult[] = [];
let totalCost = 0n; // 1/10000 of a dollar
const times: number[] = [];
let passes = 0;
let fails = 0;
let notRun = 0;
let notRunInARow = 0;
/** Scenarios whose records weren't found in the ERP: not run, and not the model's or provider's fault. */
let skipped = 0;
/** Model calls retried after a rate limit or overload: on free plans most of the reply time is this waiting. */
let retries = 0;
let stopped = '';

run: for (const scenario of scenarios) {
  for (let n = 0; n < repeat; n++) {
    const label = `${scenario.name}${repeat > 1 ? dim(` (run ${n + 1})`) : ''}`;
    // Show what is running: free and local models can take a while.
    const lacking = (scenario.requires ?? []).filter((k) => !live?.vars[k]);
    if (live && lacking.length > 0) {
      skipped++;
      console.log(`${yellow('NOT RUN')} ${label} ${dim(`— nothing found in the ERP for ${lacking.map((k) => `{${k}}`).join(', ')}`)}`);
      continue;
    }
    if (tty) process.stdout.write(dim(`  … ${scenario.name}`));
    const clear = () => tty && process.stdout.write('\r\x1b[K');
    try {
      const { results, transcript, turns } = await runScenario(scenario, {
        model: target.model,
        languages: config.languages,
        // Evals are not in a hurry: wait out rate limits (free models have tight ones).
        modelRetries: 4,
        retryDelayMs: 2000,
        ...(config.instructions ? { instructions: config.instructions } : {}),
        onError: (_e, where) => {
          if (where.startsWith('model (retry')) retries++;
        },
      }, live);
      clear();
      for (const t of turns) {
        times.push(t.ms);
        totalCost += BigInt(t.result.usage.costUsd.replace('.', ''));
      }
      // The model's provider failed: nothing about accuracy was measured.
      const providerError = turns.map((t) => t.result.error).find((e) => e?.source === 'model');
      if (providerError) {
        notRun++;
        notRunInARow++;
        console.log(`${yellow('NOT RUN')} ${label} ${dim(`— ${providerError.message.slice(0, 320)}`)}`);
        // A daily limit: nothing more will run today on this model.
        if (isDailyLimitMessage(providerError.message)) {
          const wait = waitHintMs(providerError.message);
          stopped = `the provider's DAILY limit for this model is used up${wait ? ` (it says: try again in ${Math.ceil(wait / 60_000)} min)` : ''}. Carry on later with --from ${scenario.name}, or now with another model (--model), or on a paid plan.`;
          break run;
        }
        // Stop only when nothing can work: a refused key, no credit, an unknown model.
        const fatal =
          providerError.retryable === false &&
          ([401, 402, 403, 404].includes(providerError.status ?? 0) || isNoCreditMessage(providerError.message, providerError.status));
        if (fatal) {
          stopped = 'the provider refused the model (no credit, wrong key or wrong model) — waiting will not help.';
          break run;
        }
        if (providerError.retryable === false) {
          notRunInARow = 0; // a one-off rejection (e.g. a malformed request): carry on with the next scenario
          continue;
        }
        if (notRunInARow >= 3) {
          stopped = 'the provider failed 3 scenarios in a row (busy or rate-limited). Try later, or another model with --model.';
          break run;
        }
        // Rate-limited: give the provider's per-minute window time to reset before the next scenario.
        console.log(dim(`  waiting ${pauseSeconds} s for the provider's limit…`));
        await new Promise((r) => setTimeout(r, pauseSeconds * 1000));
        continue;
      }
      notRunInARow = 0;
      measured.push(...results);
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) passes++;
      else fails++;
      console.log(`${failed.length === 0 ? green('PASS') : red('FAIL')} ${label}`);
      for (const f of failed) console.log(red(`     ✗ turn ${f.turn}: ${f.check}`) + dim(f.detail ? ` — ${f.detail.slice(0, 200)}` : ''));
      // On the real ERP, every error code it answered is worth reporting back.
      if (live) for (const t of turns) for (const x of t.result.executed.filter((x) => !x.ok)) console.log(yellow(`     ! ${x.action} answered ${x.code}`));
      if (verbose || failed.length > 0) for (const line of transcript) console.log(dim(`       ${line.replace(/\n/g, ' ')}`));
    } catch (e) {
      clear();
      fails++;
      measured.push({ scenario: scenario.name, turn: 0, check: 'ran without error', ok: false, detail: (e as Error).message });
      console.log(`${red('ERROR')} ${label}: ${(e as Error).message}`);
    }
  }
}

if (stopped) console.log(yellow(`\nStopped early: ${stopped}`));
const checks = measured.length;
const passed = measured.filter((r) => r.ok).length;
const cost = totalCost > 0n ? ` · cost $${totalCost / 10_000n}.${(totalCost % 10_000n).toString().padStart(4, '0')}` : '';
const sorted = [...times].sort((a, b) => a - b);
const speed = sorted.length
  ? ` · reply time avg ${(sorted.reduce((a, b) => a + b, 0) / sorted.length / 1000).toFixed(1)}s, slowest ${(sorted.at(-1)! / 1000).toFixed(1)}s`
  : '';
const measuredLine = passes + fails > 0
  ? `${passes}/${passes + fails} scenarios passed · ${passed}/${checks} checks (${((passed / Math.max(1, checks)) * 100).toFixed(1)}%)`
  : 'nothing was measured';
console.log(
  `\n${measuredLine}${notRun ? yellow(` · ${notRun} not run (provider errors — not counted)`) : ''}${skipped ? yellow(` · ${skipped} skipped (records not found in the ERP)`) : ''}${speed}${cost}`,
);
if (retries > 0)
  console.log(dim(`${retries} model call(s) waited out a rate limit or a busy provider — that waiting is part of the reply times above (free plans allow few tokens a minute).`));
console.log('');
process.exit(fails === 0 && notRun === 0 && !stopped ? 0 : 1);
