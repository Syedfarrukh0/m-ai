/**
 * A provider-neutral view of a chat model with tools. Adapters (Anthropic,
 * others later) translate to and from it; the rest of the assistant never
 * sees a provider's wire format.
 */

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  /** JSON or plain text the model reads. */
  content: string;
  isError?: boolean;
}

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolSpec {
  /** ^[a-zA-Z0-9_-]{1,64}$ — see toToolName(). */
  name: string;
  description: string;
  /** JSON Schema, type "object". */
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  maxTokens: number;
}

export interface ModelUsage {
  /** Uncached input tokens, including tokens written to a cache. */
  inputTokens: number;
  /** Input tokens read from a cache (billed cheaper). */
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  /** Text and tool calls only. */
  content: Array<TextBlock | ToolCallBlock>;
  stopReason: 'end' | 'tool_call' | 'max_tokens' | 'other';
  usage: ModelUsage;
  /** The model that answered, as the provider names it. */
  model: string;
}

/**
 * One call to a model. Implementations must ask the provider for at most one
 * tool call per response (no parallel tool use) — the assistant handles one
 * step at a time so a change can always stop for confirmation.
 */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** A model call that failed. `retryable` for rate limits, overload and network errors. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

/** The provider's own error message, when the body is {"error":{"message":…}}. */
export function providerMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof body.error === 'object' && typeof body.error?.message === 'string') return body.error.message;
    if (typeof body.error === 'string') return body.error;
    if (typeof body.message === 'string') return body.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 300);
}

export function textOf(content: ReadonlyArray<ContentBlock>): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
