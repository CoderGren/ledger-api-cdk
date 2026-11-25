import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/domain/errors.js';
import { centsToDecimalString } from '../src/domain/money.js';
import { makeService, newKey } from './helpers.js';

type Op =
  | { type: 'transfer'; from: number; to: number; amountCents: number; key: number }
  | { type: 'reverse'; txnIndex: number; key: number }
  | { type: 'replay'; opIndex: number };

const CUSTOMERS = 3;
// Index 0 is the funding account (may go negative); 1..CUSTOMERS are customer accounts.
const accountIndex = fc.integer({ min: 0, max: CUSTOMERS });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ type: fc.constant('transfer' as const), from: accountIndex, to: accountIndex, amountCents: fc.integer({ min: 1, max: 50_000 }), key: fc.nat({ max: 40 }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('reverse' as const), txnIndex: fc.nat({ max: 30 }), key: fc.nat({ max: 40 }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('replay' as const), opIndex: fc.nat({ max: 30 }) }) },
);

async function snapshot(service: ReturnType<typeof makeService>['service'], ids: string[]) {
  return Promise.all(ids.map(async (id) => (await service.getBalance(id)).balanceCents));
}

describe('ledger invariants (property-based)', () => {
  it('any sequence of transfers, reversals and replays keeps the books balanced', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 40 }), async (ops) => {
        const { service, repo } = makeService();
        const ids = [(await service.createFundingAccount({ name: 'Funding' })).id];
        for (let i = 0; i < CUSTOMERS; i++) ids.push((await service.createAccount({ name: `Customer ${i}` }, newKey())).account.id);

        const posted: string[] = [];
        const sent: Array<{ body: unknown; key: string; reverse?: string }> = [];

        for (const op of ops) {
          const before = await snapshot(service, ids);
          const txnCountBefore = repo.transactions.size;
          try {
            if (op.type === 'transfer') {
              const body = { fromAccountId: ids[op.from], toAccountId: ids[op.to], amountCents: op.amountCents };
              const key = `transfer-key-${op.key}`;
              const res = await service.postTransfer(body, key);
              // Only successful requests consume their key; a rejected request may be retried.
              sent.push({ body, key });
              if (!res.replayed) posted.push(res.transaction.id);
            } else if (op.type === 'reverse') {
              if (posted.length === 0) continue;
              const target = posted[op.txnIndex % posted.length]!;
              const key = `reverse-key-${op.key}`;
              await service.reverse(target, key);
              sent.push({ body: null, key, reverse: target });
            } else {
              if (sent.length === 0) continue;
              const prev = sent[op.opIndex % sent.length]!;
              const res = prev.reverse ? await service.reverse(prev.reverse, prev.key) : await service.postTransfer(prev.body, prev.key);
              // A successful replay must never post anything new.
              expect(res.replayed).toBe(true);
              expect(await snapshot(service, ids)).toEqual(before);
            }
          } catch (err) {
            // Only domain errors are acceptable, and a rejected request must leave no trace.
            expect(err).toBeInstanceOf(LedgerError);
            expect(await snapshot(service, ids)).toEqual(before);
            expect(repo.transactions.size).toBe(txnCountBefore);
          }

          const balances = await snapshot(service, ids);
          // 1. Double entry: money is only ever moved, never created or destroyed.
          expect(balances.reduce((a, b) => a + b, 0)).toBe(0);
          // 2. Customer accounts never go negative.
          for (const b of balances.slice(1)) expect(b).toBeGreaterThanOrEqual(0);
          // 3. Balances are always integers.
          for (const b of balances) expect(Number.isSafeInteger(b)).toBe(true);
        }

        // 4. Each stored balance equals the sum of its statement entries.
        for (const id of ids) {
          const { items, nextCursor } = await service.listTransactions(id, 100);
          expect(nextCursor).toBeUndefined();
          expect(items.reduce((s, e) => s + e.amountCents, 0)).toBe((await service.getBalance(id)).balanceCents);
        }
        // 5. Every transaction balances.
        for (const txn of repo.transactions.values()) {
          expect(txn.entries.reduce((s, e) => s + e.amountCents, 0)).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a transfer followed by its reversal restores every balance exactly', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 0, max: 1_000_000 }), async (amount, extra) => {
        const { service } = makeService();
        const funding = (await service.createFundingAccount({ name: 'F' })).id;
        const a = (await service.createAccount({ name: 'A' }, newKey())).account.id;
        const b = (await service.createAccount({ name: 'B' }, newKey())).account.id;
        await service.postTransfer({ fromAccountId: funding, toAccountId: a, amountCents: amount + extra }, 'seed-key-1');
        const before = await snapshot(service, [funding, a, b]);
        const { transaction } = await service.postTransfer({ fromAccountId: a, toAccountId: b, amountCents: amount }, 'xfer-key-1');
        await service.reverse(transaction.id, 'reverse-key-1');
        expect(await snapshot(service, [funding, a, b])).toEqual(before);
      }),
      { numRuns: 100 },
    );
  });

  it('cents always format to a decimal string that round-trips exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: -(2 ** 52), max: 2 ** 52 }), (cents) => {
        const s = centsToDecimalString(cents);
        expect(s).toMatch(/^-?\d+\.\d{2}$/);
        expect(BigInt(s.replace('.', ''))).toBe(BigInt(cents));
      }),
    );
  });
});
