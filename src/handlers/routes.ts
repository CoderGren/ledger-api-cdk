import type { LedgerService } from '../domain/service.js';
import { LedgerError } from '../domain/errors.js';
import { callerOf, header, json, parseJsonBody, route, type AuthMode, type HttpEvent, type HttpHandler } from './http.js';

/** Route handlers, built around an injected service so they can be unit-tested without AWS. */
/**
 * `authMode` defaults to `jwt` so a missing configuration fails closed.
 */
export function createRoutes(service: LedgerService, opts: { authMode?: AuthMode } = {}): Record<
  'createAccount' | 'getBalance' | 'listTransactions' | 'postTransfer' | 'reverseTransaction',
  HttpHandler
> {
  const authMode = opts.authMode ?? 'jwt';
  const caller = (event: HttpEvent) => callerOf(event, authMode);
  return {
    createAccount: route(async (event) => {
      const { account, replayed } = await service.createAccount(parseJsonBody(event), header(event, 'idempotency-key'), caller(event));
      return json(replayed ? 200 : 201, account, { location: `/accounts/${account.id}`, 'idempotent-replayed': String(replayed) });
    }),

    getBalance: route(async (event) => {
      const account = await service.getBalance(event.pathParameters?.accountId ?? '', caller(event));
      return json(200, {
        accountId: account.id,
        name: account.name,
        currency: account.currency,
        balanceCents: account.balanceCents,
      });
    }),

    listTransactions: route(async (event) => {
      const q = event.queryStringParameters ?? {};
      const limit = q.limit === undefined ? 25 : Number(q.limit);
      if (!Number.isInteger(limit)) throw new LedgerError('VALIDATION', 'limit must be an integer');
      const page = await service.listTransactions(event.pathParameters?.accountId ?? '', limit, q.cursor, caller(event));
      return json(200, page);
    }),

    postTransfer: route(async (event) => {
      const result = await service.postTransfer(parseJsonBody(event), header(event, 'idempotency-key'), caller(event));
      return json(result.replayed ? 200 : 201, result.transaction, { 'idempotent-replayed': String(result.replayed) });
    }),

    reverseTransaction: route(async (event) => {
      const result = await service.reverse(event.pathParameters?.transactionId ?? '', header(event, 'idempotency-key'), caller(event));
      return json(result.replayed ? 200 : 201, result.transaction, { 'idempotent-replayed': String(result.replayed) });
    }),
  };
}
