import type {
  ActionContext,
  ActionRegistry,
  ActionResult,
  ExecuteRequest,
  ListRequest,
  ListResponse,
  PreviewRequest,
  PreviewResult,
} from '@m-ai/action-contract';
import { HTTP_HEADERS, HTTP_ROUTES } from '@m-ai/action-contract';

/**
 * How the assistant reaches an app — always as ONE person, through that
 * person's delegated token (HTTP) or context (in-process). The channel layer
 * builds a fresh client for every turn; the assistant never holds a
 * credential of its own.
 */
export interface ActionsClient {
  list(request?: ListRequest): Promise<ListResponse>;
  preview(request: PreviewRequest): Promise<ActionResult<PreviewResult>>;
  execute(request: ExecuteRequest): Promise<ActionResult<unknown>>;
}

/** Thrown when the app could not be reached or answered with something that is not an ActionResult. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** An in-process client over a registry — for the mock ERP, tests and apps that embed the assistant. */
export function createInProcessActionsClient(registry: ActionRegistry, ctx: () => ActionContext): ActionsClient {
  return {
    list: (request) => registry.list(ctx(), request),
    preview: (request) => registry.preview(ctx(), request),
    execute: (request) => {
      const c = ctx();
      return registry.execute(request.idempotencyKey ? { ...c, idempotencyKey: request.idempotencyKey } : c, request);
    },
  };
}

export interface HttpActionsClientOptions {
  /** The app's base URL, e.g. https://erp.example.com/api. */
  baseUrl: string;
  /** The delegated token for this person (5 minutes at most). */
  token: string | (() => string | Promise<string>);
  fetch?: typeof globalThis.fetch;
  /** Echoed by the app in meta.requestId. */
  requestId?: () => string;
  timeoutMs?: number;
}

/**
 * A client for an app's `/actions/*` routes. The body is always an
 * ActionResult whatever the HTTP status. An execute carrying an idempotency
 * key is retried once if the connection fails, which is safe by contract.
 */
export function createHttpActionsClient(options: HttpActionsClientOptions): ActionsClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/$/, '');

  async function post<T>(route: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const token = typeof options.token === 'function' ? await options.token() : options.token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await doFetch(`${base}${route}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(options.requestId ? { [HTTP_HEADERS.requestId]: options.requestId() } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      throw new TransportError(`could not reach ${route}: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new TransportError(`${route} answered ${res.status} without JSON`, res.status);
    }
    if (res.status === 401) throw new TransportError(`${route}: token rejected`, 401);
    if (typeof parsed !== 'object' || parsed === null) throw new TransportError(`${route}: unexpected body`, res.status);
    return parsed as T;
  }

  return {
    list: (request = {}) => post<ListResponse>(HTTP_ROUTES.list, request),
    preview: (request) => post<ActionResult<PreviewResult>>(HTTP_ROUTES.preview, request),
    execute: async (request) => {
      const headers: Record<string, string> = request.idempotencyKey ? { [HTTP_HEADERS.idempotencyKey]: request.idempotencyKey } : {};
      try {
        return await post<ActionResult<unknown>>(HTTP_ROUTES.execute, request, headers);
      } catch (e) {
        if (e instanceof TransportError && e.status === undefined && request.idempotencyKey) {
          return post<ActionResult<unknown>>(HTTP_ROUTES.execute, request, headers);
        }
        throw e;
      }
    },
  };
}
