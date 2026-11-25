import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { LedgerError } from '../domain/errors.js';
import { MoneyError } from '../domain/money.js';
import { ANONYMOUS, type Caller } from '../domain/service.js';

export type HttpEvent = APIGatewayProxyEventV2;
export type HttpResult = APIGatewayProxyStructuredResultV2;
export type HttpHandler = (event: HttpEvent) => Promise<HttpResult>;

const MAX_BODY_BYTES = 16 * 1024;

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(body),
  };
}

export function parseJsonBody(event: HttpEvent): unknown {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new LedgerError('VALIDATION', 'request body too large');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new LedgerError('VALIDATION', 'request body must be valid JSON');
  }
}

export function header(event: HttpEvent, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/**
 * The authenticated principal (JWT `sub`) when an authorizer is attached, else `anon`.
 * Scopes idempotency keys (and, with auth on, account ownership) per caller.
 */
export function callerOf(event: HttpEvent): Caller {
  const ctx = event.requestContext as
    | (HttpEvent['requestContext'] & { authorizer?: { jwt?: { claims?: Record<string, unknown> } } })
    | undefined;
  const sub = ctx?.authorizer?.jwt?.claims?.sub;
  return typeof sub === 'string' && sub.length > 0 ? { principal: `sub:${sub}` } : ANONYMOUS;
}

/** Wraps a route so domain errors become JSON problem responses and nothing else leaks. */
export function route(fn: HttpHandler): HttpHandler {
  return async (event) => {
    try {
      return await fn(event);
    } catch (err) {
      if (err instanceof LedgerError) {
        return json(err.status, { error: { code: err.code, message: err.message } });
      }
      // Any money-arithmetic guard that trips is a bad request, never a 500.
      if (err instanceof MoneyError) {
        return json(400, { error: { code: 'VALIDATION', message: err.message } });
      }
      const e = err as Error;
      console.error(JSON.stringify({ level: 'error', message: 'unhandled error', error: e?.message, stack: e?.stack }));
      return json(500, { error: { code: 'INTERNAL', message: 'internal error' } });
    }
  };
}
