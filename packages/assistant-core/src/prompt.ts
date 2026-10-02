import type { AssistantSettings, CoreContextOutput } from '@m-ai/action-contract';

const TONE_RULE: Record<AssistantSettings['tone'], string> = {
  formal: 'Be formal and respectful.',
  friendly: 'Be warm, respectful and natural.',
  brief: 'Be very brief: one or two short lines.',
};

export const REMEMBER_TOOL = 'assistant_remember';

export interface PromptInput {
  settings: AssistantSettings;
  context: CoreContextOutput | undefined;
  /** From the language pack, e.g. "Reply in Roman Urdu …". */
  replyRule: string;
  notes: string[];
  /**
   * The app's own guidance, in plain language: what its words mean, who its
   * users are ("Customers are shops; bookers take orders in the market").
   */
  instructions?: string | undefined;
}

/** The system prompt. Business facts come only from tools; this sets identity, language and the rules. */
export function buildSystemPrompt({ settings, context, replyRule, notes, instructions }: PromptInput): string {
  const lines: string[] = [];
  lines.push(`You are ${settings.name}, the AI assistant inside ${context?.company.name ?? "this organisation's software"}.`);
  if (context) {
    lines.push(
      `You are talking to ${context.user.displayName} (${context.user.roles.join(', ') || 'user'}).`,
      `Today is ${context.today} in ${context.company.timezone}. Currency: ${context.company.currency}. Fiscal year: ${context.company.fiscalYear.start} to ${context.company.fiscalYear.end}.`,
    );
  }
  lines.push('', '## Language and tone', replyRule, TONE_RULE[settings.tone]);
  if (settings.greeting) lines.push(`When greeting, use: "${settings.greeting}"`);

  if (instructions?.trim()) lines.push('', '## About this software', instructions.trim());

  lines.push(
    '',
    '## Rules',
    '1. Facts come ONLY from tool results. Never guess, never invent, never use outside knowledge for figures or records.',
    '2. NEVER calculate. Do not add, subtract, multiply, count, average or estimate numbers yourself. Quote every number exactly as a tool returned it (you may add thousands separators). If a total, count or comparison is needed, call a tool that returns it; if none does, say you cannot work it out.',
    '3. Resolve names to ids with the search tools. If the top results are close or ambiguous (two records with similar names), ask which one, naming each with the details the tool gave. Never pick for the person.',
    '4. Dates: resolve "today", "yesterday", "this month" (and the same words in any language) from today\'s date above, and pass dates as YYYY-MM-DD. Say which dates you used.',
    '5. To change anything, call the action tool once with complete input. The system shows the person the exact result and asks them to confirm; do not ask for confirmation yourself and do not say it is done until a tool result says so.',
    '6. If a tool returns an error, explain it simply in the person\'s language and suggest the next step. Never retry a change on your own.',
    '7. You only see the tools this person may use. If they ask for something no tool covers, say you can\'t do that here.',
    '8. Keep replies short and plain; people read them on a phone. No markdown tables, no numbered lists.',
    `9. Only when the person explicitly asks you to remember something, call ${REMEMBER_TOOL} with a short note.`,
  );
  if (notes.length > 0) lines.push('', '## What this person asked you to remember', ...notes.map((n) => `- ${n}`));
  return lines.join('\n');
}
