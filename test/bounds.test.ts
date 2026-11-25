import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_BALANCE_CENTS, MAX_TRANSFER_CENTS } from '../src/domain/money.js';
import { createRoutes } from '../src/handlers/routes.js';
import type { HttpEvent } from '../src/handlers/http.js';
import { makeService, newKey } from './helpers.js';

const post = (json: unknown, key: string) =>
  ({ headers: { 'idempotency-key': key }, body: JSON.stringify(json), isBase64Encoded: false }) as unknown as HttpEvent;

describe('L-M2: amount and balance bounds', () => {
  it('rejects transfers above MAX_TRANSFER_CENTS with 400, not 500 (9e15 repro)', async () => {
    const { service } = makeService();
    const routes = createRoutes(service);
    const funding = (await service.createFundingAccount({ name: 'F' })).id;
    const a = (await service.createAccount({ name: 'A' }, newKey())).account.id;
    for (const amountCents of [MAX_TRANSFER_CENTS + 1, 9_007_199_254_740_991, Number.MAX_SAFE_INTEGER]) {
      const res = await routes.postTransfer(post({ fromAccountId: funding, toAccountId: a, amountCents }, `big-${amountCents}`));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body!).error.code).toBe('VALIDATION');
    }
    const ok = await routes.postTransfer(post({ fromAccountId: funding, toAccountId: a, amountCents: MAX_TRANSFER_CENTS }, 'max-ok-1'));
    expect(ok.statusCode).toBe(201);
  });

  it('refuses to push any balance past MAX_BALANCE_CENTS, including funding accounts, with 400', async () => {
    const { service, repo } = makeService();
    const routes = createRoutes(service);
    const funding = (await service.createFundingAccount({ name: 'F' })).id;
    const a = (await service.createAccount({ name: 'A' }, newKey())).account.id;
    // Put both accounts right at the edge without 100k transfers.
    repo.accounts.get(funding)!.balanceCents = -(MAX_BALANCE_CENTS - 5);
    repo.accounts.get(a)!.balanceCents = MAX_BALANCE_CENTS - 5;

    const res = await routes.postTransfer(post({ fromAccountId: funding, toAccountId: a, amountCents: 6 }, 'edge-key-1'));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error.message).toMatch(/maximum balance/);
    // Balances untouched and reads still work (no BigInt serialization 500).
    const bal = await routes.getBalance({ pathParameters: { accountId: a } } as unknown as HttpEvent);
    expect(bal.statusCode).toBe(200);
    expect(JSON.parse(bal.body!).balanceCents).toBe(MAX_BALANCE_CENTS - 5);
    expect((await routes.postTransfer(post({ fromAccountId: funding, toAccountId: a, amountCents: 5 }, 'edge-key-2'))).statusCode).toBe(201);
  });

  it('property: near the bounds, every outcome is a 2xx/4xx and balances stay in range', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: MAX_TRANSFER_CENTS - 1000, max: MAX_TRANSFER_CENTS + 1000 }), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 50 }),
        async (amounts, headroom) => {
          const { service, repo } = makeService();
          const routes = createRoutes(service);
          const funding = (await service.createFundingAccount({ name: 'F' })).id;
          const a = (await service.createAccount({ name: 'A' }, newKey())).account.id;
          repo.accounts.get(funding)!.balanceCents = -(MAX_BALANCE_CENTS - headroom * MAX_TRANSFER_CENTS);
          repo.accounts.get(a)!.balanceCents = MAX_BALANCE_CENTS - headroom * MAX_TRANSFER_CENTS;
          for (const [i, amountCents] of amounts.entries()) {
            const res = await routes.postTransfer(post({ fromAccountId: funding, toAccountId: a, amountCents }, `prop-key-${i}`));
            expect(res.statusCode).toBeLessThan(500);
          }
          for (const acct of repo.accounts.values()) {
            expect(Math.abs(acct.balanceCents)).toBeLessThanOrEqual(MAX_BALANCE_CENTS);
            expect(Number.isSafeInteger(acct.balanceCents)).toBe(true);
          }
          expect([...repo.accounts.values()].reduce((s, x) => s + x.balanceCents, 0)).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
