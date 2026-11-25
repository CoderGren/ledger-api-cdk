import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutes } from '../src/handlers/routes.js';
import type { HttpEvent } from '../src/handlers/http.js';
import { makeService } from './helpers.js';

let eventKeys = 0;
function event(partial: Partial<HttpEvent> & { json?: unknown }): HttpEvent {
  const { json, ...rest } = partial;
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/',
    rawQueryString: '',
    // Every POST needs an Idempotency-Key; tests that care pass their own headers.
    headers: { 'idempotency-key': `event-key-${++eventKeys}` },
    isBase64Encoded: false,
    requestContext: {} as HttpEvent['requestContext'],
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    ...rest,
  };
}

const body = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

let routes: ReturnType<typeof createRoutes>;
let service: ReturnType<typeof makeService>['service'];
beforeEach(() => {
  service = makeService().service;
  routes = createRoutes(service);
});

async function account(name: string): Promise<string> {
  const res = await routes.createAccount(event({ json: { name } }));
  expect(res.statusCode).toBe(201);
  return body(res).id;
}

/** Funding accounts only come from the trusted seed path, never from HTTP. */
const fundingAccount = async () => (await service.createFundingAccount({ name: 'Funding' })).id;

describe('HTTP routes', () => {
  it('creates accounts, moves money and reports balances', async () => {
    const funding = await fundingAccount();
    const checking = await account('Checking');
    const res = await routes.postTransfer(
      event({ headers: { 'Idempotency-Key': 'abcdefgh-1' }, json: { fromAccountId: funding, toAccountId: checking, amountCents: 12_345 } }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.headers?.['idempotent-replayed']).toBe('false');

    const replay = await routes.postTransfer(
      event({ headers: { 'idempotency-key': 'abcdefgh-1' }, json: { fromAccountId: funding, toAccountId: checking, amountCents: 12_345 } }),
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.headers?.['idempotent-replayed']).toBe('true');

    const balance = await routes.getBalance(event({ pathParameters: { accountId: checking } }));
    expect(body(balance)).toMatchObject({ accountId: checking, balanceCents: 12_345, currency: 'USD' });

    const list = await routes.listTransactions(event({ pathParameters: { accountId: checking }, queryStringParameters: { limit: '10' } }));
    expect(body(list).items).toHaveLength(1);

    const reversal = await routes.reverseTransaction(
      event({ headers: { 'idempotency-key': 'reverse-0001' }, pathParameters: { transactionId: body(res).id } }),
    );
    expect(reversal.statusCode).toBe(201);
    expect(body(reversal).reversesTransactionId).toBe(body(res).id);
  });

  it('L-M1: POST /accounts rejects allowNegative, so callers cannot mint money (9e15 repro)', async () => {
    const res = await routes.createAccount(event({ json: { name: 'Mint', allowNegative: true } }));
    expect(res.statusCode).toBe(400);
    expect(body(res).error.message).toMatch(/allowNegative/);
    const sneaky = await routes.createAccount(event({ json: { name: 'Mint', allowNegative: false } }));
    expect(sneaky.statusCode).toBe(400);
    const unknown = await routes.createAccount(event({ json: { name: 'X', role: 'admin' } }));
    expect(unknown.statusCode).toBe(400);

    // Hanna's probe: move MAX_SAFE_INTEGER cents out of a self-created account. It must not succeed.
    const mine = await account('Mine');
    const victim = await account('Other');
    const mint = await routes.postTransfer(
      event({
        headers: { 'idempotency-key': 'mint-repro-1' },
        json: { fromAccountId: mine, toAccountId: victim, amountCents: 9_007_199_254_740_991 },
      }),
    );
    expect(mint.statusCode).toBe(400);
    expect(body(await routes.getBalance(event({ pathParameters: { accountId: victim } }))).balanceCents).toBe(0);
  });

  it('maps domain errors to status codes with a JSON error body', async () => {
    const a = await account('A');
    const b = await account('B');
    const cases: Array<[Promise<{ statusCode?: number; body?: string }>, number, string]> = [
      [routes.postTransfer(event({ headers: {}, json: { fromAccountId: a, toAccountId: b, amountCents: 1 } })), 400, 'VALIDATION'],
      [routes.postTransfer(event({ headers: { 'idempotency-key': 'k-12345678' }, json: { fromAccountId: a, toAccountId: b, amountCents: 1 } })), 422, 'INSUFFICIENT_FUNDS'],
      [routes.postTransfer(event({ headers: { 'idempotency-key': 'k-12345679' }, body: '{not json' })), 400, 'VALIDATION'],
      [routes.getBalance(event({ pathParameters: { accountId: 'missing' } })), 404, 'NOT_FOUND'],
      [routes.listTransactions(event({ pathParameters: { accountId: a }, queryStringParameters: { limit: 'abc' } })), 400, 'VALIDATION'],
    ];
    for (const [promise, status, code] of cases) {
      const res = await promise;
      expect(res.statusCode).toBe(status);
      expect(body(res).error.code).toBe(code);
    }
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = createRoutes({ getBalance: async () => { throw new Error('secret internals'); } } as never);
    const res = await broken.getBalance(event({ pathParameters: { accountId: 'a' } }));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internals');
    spy.mockRestore();
  });

  it('rejects oversized bodies', async () => {
    const res = await routes.createAccount(event({ body: JSON.stringify({ name: 'x'.repeat(20_000) }) }));
    expect(res.statusCode).toBe(400);
  });
});
