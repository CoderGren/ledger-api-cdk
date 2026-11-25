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
 * `jwt`: the API Gateway JWT authorizer is attached (the default for deployed stacks).
 * `none`: the explicit `allowUnauthenticated` demo mode, where every caller is `anon`.
 */
export type AuthMode = 'jwt' | 'none';

/** Reads AUTH_MODE (set by the stack). Anything other than exactly `jwt` or `none` fails closed. */
export function parseAuthMode(raw: string | undefined): AuthMode {
  if (raw === 'jwt' || raw === 'none') return raw;
  throw new Error(`AUTH_MODE must be "jwt" or "none", got ${JSON.stringify(raw)}`);
}

/**
 * The caller's principal, which scopes idempotency keys and owns accounts.
 * In `jwt` mode it is the token's `sub`; a token without one is rejected with 401 and NEVER
 * falls back to `anon` (fail closed). Only the explicit `none` demo mode uses `anon`.
 */
export function callerOf(event: HttpEvent, mode: AuthMode): Caller {
  if (mode === 'none') return ANONYMOUS;
  const ctx = event.requestContext as
    | (HttpEvent['requestContext'] & { authorizer?: { jwt?: { claims?: Record<string, unknown> } } })
    | undefined;
  const sub = ctx?.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || sub.trim() === '') {
    throw new LedgerError('UNAUTHENTICATED', 'token has no subject (sub) claim');
  }
  return { principal: `sub:${sub}` };
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
