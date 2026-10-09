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

/** A file the app made (a PDF), fetched with the same delegated token. */
export type DocumentResult =
  | { ok: true; bytes: Uint8Array; contentType: string; fileName?: string }
  | { ok: false; status: number; code: string; message: string };

export interface HttpActionsClient extends ActionsClient {
  /**
   * `GET /documents/{documentId}` with the person's delegated token: the file
   * a render made, for the channel to attach. It never passes through the model.
   */
  document(documentId: string, options?: { download?: boolean }): Promise<DocumentResult>;
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
export function createHttpActionsClient(options: HttpActionsClientOptions): HttpActionsClient {
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
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TransportError(`${route} answered ${res.status} without JSON: ${text.slice(0, 200)}`, res.status);
    }
    if (res.status === 401) throw new TransportError(`${route}: token rejected (401) ${text.slice(0, 200)}`, 401);
    if (typeof parsed !== 'object' || parsed === null) throw new TransportError(`${route}: unexpected body ${text.slice(0, 200)}`, res.status);
    return parsed as T;
  }

  async function list(request: ListRequest = {}): Promise<ListResponse> {
    const body = await post<Record<string, unknown>>(HTTP_ROUTES.list, request);
    if (Array.isArray(body['actions'])) return body as unknown as ListResponse;
    // Some hosts wrap the list in an ActionResult.
    const data = body['data'] as Record<string, unknown> | undefined;
    if (body['ok'] === true && data && Array.isArray(data['actions'])) return data as unknown as ListResponse;
    const error = body['error'] as { code?: unknown } | string | undefined;
    const code = typeof error === 'string' ? error : typeof error?.code === 'string' ? error.code : 'unexpected body';
    throw new TransportError(`${HTTP_ROUTES.list}: ${code}`);
  }

  async function document(documentId: string, opts: { download?: boolean } = {}): Promise<DocumentResult> {
    const token = typeof options.token === 'function' ? await options.token() : options.token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    const url = `${base}/documents/${encodeURIComponent(documentId)}${opts.download ? '?download=1' : ''}`;
    let res: Response;
    try {
      res = await doFetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      throw new TransportError(`could not reach /documents: ${(e as Error).message}`);
    }
    try {
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const disposition = res.headers.get('content-disposition') ?? '';
        const name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? /filename="?([^";]+)"?/i.exec(disposition)?.[1];
        return {
          ok: true,
          bytes,
          contentType: res.headers.get('content-type') ?? 'application/octet-stream',
          ...(name ? { fileName: decodeURIComponent(name) } : {}),
        };
      }
      // A refusal comes in the app's REST shape: { code, message, messages, details }.
      const text = await res.text();
      let body: { code?: unknown; message?: unknown; error?: unknown } = {};
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        body = {};
      }
      const code = typeof body.code === 'string' ? body.code : typeof body.error === 'string' ? body.error : `HTTP_${res.status}`;
      const message = typeof body.message === 'string' ? body.message : text.slice(0, 200);
      return { ok: false, status: res.status, code, message };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    document,
    list,
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
