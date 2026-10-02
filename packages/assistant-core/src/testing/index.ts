/**
 * @m-ai/assistant-core/testing — a scripted model for tests and demos.
 */
import type { ModelClient, ModelRequest, ModelResponse, TextBlock, ToolCallBlock } from '../model.js';

export type ScriptStep =
  | string
  | { text?: string; call?: { name: string; input: unknown } }
  | ((request: ModelRequest) => ScriptStep);

export interface ScriptedModel extends ModelClient {
  /** Every request the assistant sent, in order. */
  readonly requests: ModelRequest[];
  /** Steps not yet used. */
  readonly remaining: number;
  push(...steps: ScriptStep[]): void;
}

/**
 * A model that answers from a script, one step per call: a string is a final
 * text reply; `{ call }` is a tool call (action names may be given with dots);
 * a function decides from the request. Throws when the script runs out.
 */
export function createScriptedModel(steps: ScriptStep[] = [], usage = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 }): ScriptedModel {
  const queue = [...steps];
  const requests: ModelRequest[] = [];
  let seq = 0;
  return {
    requests,
    get remaining() {
      return queue.length;
    },
    push: (...more) => void queue.push(...more),
    async complete(request) {
      requests.push(structuredClone(request));
      let step = queue.shift();
      if (step === undefined) throw new Error('scripted model: no more steps');
      while (typeof step === 'function') step = step(request);
      const content: Array<TextBlock | ToolCallBlock> = [];
      if (typeof step === 'string') content.push({ type: 'text', text: step });
      else {
        if (step.text) content.push({ type: 'text', text: step.text });
        if (step.call) content.push({ type: 'tool_call', id: `call_${++seq}`, name: step.call.name.replace(/\./g, '__'), input: step.call.input });
      }
      const response: ModelResponse = {
        content,
        stopReason: content.some((b) => b.type === 'tool_call') ? 'tool_call' : 'end',
        usage: { ...usage },
        model: 'scripted-model',
      };
      return response;
    },
  };
}
