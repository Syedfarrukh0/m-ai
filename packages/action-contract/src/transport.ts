import { httpStatusFor } from './errors.js';
import type { ActionResult } from './results.js';

/**
 * The HTTP face of a registry (the in-process face is the registry itself).
 *
 *   POST /actions/list      ListRequest      → ListResponse
 *   POST /actions/preview   PreviewRequest   → ActionResult<PreviewResult>
 *   POST /actions/execute   ExecuteRequest   → ActionResult<unknown>
 *        header Idempotency-Key  (wins over body.idempotencyKey; put it in ctx.idempotencyKey)
 *        header X-Request-Id     (echoed in meta.requestId)
 *
 * The body is always the ActionResult; the status mirrors it: `error.http`, which the registry sets
 * from STANDARD_ERRORS or from the app's registered module errors (default 422).
 * 401 for a missing/expired token is the app's auth layer, before the registry.
 */
export const HTTP_ROUTES = {
  list: '/actions/list',
  preview: '/actions/preview',
  execute: '/actions/execute',
} as const;

export const HTTP_HEADERS = {
  idempotencyKey: 'idempotency-key',
  requestId: 'x-request-id',
} as const;

export function httpStatusOf(result: ActionResult<unknown>): number {
  if (result.ok) return 200;
  return result.error.http ?? httpStatusFor(result.error.code);
}
