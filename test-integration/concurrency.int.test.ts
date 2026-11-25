import { PutCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/domain/errors.js';
import { MAX_BALANCE_CENTS } from '../src/domain/money.js';
import { client, endpoint, freshLedger, key } from './local.js';

const settle = <T>(ps: Array<Promise<T>>) => Promise.allSettled(ps);
const codes = (rs: PromiseSettledResult<unknown>[]) =>
  rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => (r.reason instanceof LedgerError ? r.reason.code : String(r.reason)));

describe.skipIf(!endpoint)('DynamoDB Local: concurrency and conditions', () => {
  it('same key, 10 parallel transfers: money moves exactly once and every success is the same transaction', async () => {
    const { service } = await freshLedger();
    const funding = (await service.createFundingAccount({ name: 'F' })).id;
    const a = (await service.createAccount({ name: 'A' }, key())).account.id;
    const k = key();
    const body = { fromAccountId: funding, toAccountId: a, amountCents: 700 };
    const results = await settle(Array.from({ length: 10 }, () => service.postTransfer(body, k)));
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.transaction.id);
    expect(new Set(ok).size).toBe(1);
    // Losers either replay the winner or report a retryable race; never a second posting.
    expect(codes(results).every((c) => c === 'CONCURRENT_UPDATE')).toBe(true);
    expect((await service.getBalance(a)).balanceCents).toBe(700);
    expect((await service.listTransactions(a, 100)).items).toHaveLength(1);
  });

  it('different keys, 20 parallel debits against 1000 cents: never overdrawn, books balance', async () => {
    const { service } = await freshLedger();
    const funding = (await service.createFundingAccount({ name: 'F' })).id;
    const a = (await service.createAccount({ name: 'A' }, key())).account.id;
    const b = (await service.createAccount({ name: 'B' }, key())).account.id;
    await service.postTransfer({ fromAccountId: funding, toAccountId: a, amountCents: 1000 }, key());
    const results = await settle(
      Array.from({ length: 20 }, () => service.postTransfer({ fromAccountId: a, toAccountId: b, amountCents: 100 }, key())),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    expect(succeeded).toBeLessThanOrEqual(10);
    expect(codes(results).every((c) => c === 'INSUFFICIENT_FUNDS' || c === 'CONCURRENT_UPDATE')).toBe(true);
    const [fa, ab, bb] = await Promise.all([funding, a, b].map(async (id) => (await service.getBalance(id)).balanceCents));
    expect(ab).toBeGreaterThanOrEqual(0);
    expect(ab).toBe(1000 - succeeded * 100);
    expect(bb).toBe(succeeded * 100);
    expect(fa! + ab! + bb!).toBe(0);
  });

  it('parallel reversals of one transaction: exactly one succeeds', async () => {
    const { service } = await freshLedger();
    const funding = (await service.createFundingAccount({ name: 'F' })).id;
    const a = (await service.createAccount({ name: 'A' }, key())).account.id;
    const t = await service.postTransfer({ fromAccountId: funding, toAccountId: a, amountCents: 300 }, key());
    const results = await settle(Array.from({ length: 8 }, () => service.reverse(t.transaction.id, key())));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(codes(results).every((c) => c === 'ALREADY_REVERSED' || c === 'CONCURRENT_UPDATE' || c === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect((await service.getBalance(a)).balanceCents).toBe(0);
    expect((await service.getBalance(funding)).balanceCents).toBe(0);
  });

  it('same key, parallel POST /accounts: one account', async () => {
    const { service } = await freshLedger();
    const k = key();
    const results = await settle(Array.from({ length: 8 }, () => service.createAccount({ name: 'Once' }, k)));
    const ids = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.account.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(1);
  });

  it('the balance ceiling is enforced by DynamoDB itself (bypassing the service pre-check)', async () => {
    const { service, repo } = await freshLedger();
    const funding = (await service.createFundingAccount({ name: 'F' })).id;
    const a = (await service.createAccount({ name: 'A' }, key())).account.id;
    // Put the account right at the ceiling, then commit a credit directly through the repository.
    const doc = DynamoDBDocumentClient.from(client);
    const acct = (await repo.getAccount(a))!;
    const tableName = (repo as unknown as { tableName: string }).tableName;
    await doc.send(new PutCommand({ TableName: tableName, Item: { PK: `ACCOUNT#${a}`, SK: 'PROFILE', type: 'Account', ...acct, balanceCents: MAX_BALANCE_CENTS } }));
    const txn = {
      id: 'over',
      kind: 'transfer' as const,
      currency: 'USD' as const,
      entries: [
        { accountId: funding, amountCents: -1 },
        { accountId: a, amountCents: 1 },
      ],
      createdAt: new Date().toISOString(),
      idempotencyKey: 'over-key-1',
    };
    const idem = { scope: 'anon', key: 'over-key-1', fingerprint: 'fp', resourceType: 'transaction' as const, resourceId: 'over', expiresAt: 4_000_000_000 };
    await expect(repo.commit(txn, idem)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await repo.getAccount(a))!.balanceCents).toBe(MAX_BALANCE_CENTS);
  });

  it('an expired idempotency record is overwritten rather than replayed', async () => {
    const { service, repo, tableName } = await freshLedger();
    const funding = (await service.createFundingAccount({ name: 'F' })).id;
    const a = (await service.createAccount({ name: 'A' }, key())).account.id;
    const k = key();
    const doc = DynamoDBDocumentClient.from(client);
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: { PK: `IDEMPOTENCY#anon#${k}`, SK: 'IDEMPOTENCY', fingerprint: 'old', resourceType: 'transaction', resourceId: 'gone', expiresAt: 1 },
      }),
    );
    const res = await service.postTransfer({ fromAccountId: funding, toAccountId: a, amountCents: 5 }, k);
    expect(res.replayed).toBe(false);
    expect((await repo.getIdempotencyRecord('anon', k))!.resourceId).toBe(res.transaction.id);
  });

  it('property: random parallel batches keep the books balanced and customers non-negative', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.record({ from: fc.nat({ max: 3 }), to: fc.nat({ max: 3 }), amountCents: fc.integer({ min: 1, max: 2_000 }), sameKeyAs: fc.option(fc.nat({ max: 5 })) }), {
            minLength: 1,
            maxLength: 8,
          }),
          { minLength: 1, maxLength: 4 },
        ),
        async (batches) => {
          const { service } = await freshLedger();
          const ids = [(await service.createFundingAccount({ name: 'F' })).id];
          for (let i = 0; i < 3; i++) ids.push((await service.createAccount({ name: `C${i}` }, key())).account.id);
          for (const batch of batches) {
            const keys = batch.map(() => key());
            await settle(
              batch.map((op, i) =>
                service.postTransfer(
                  { fromAccountId: ids[op.from]!, toAccountId: ids[op.to]!, amountCents: op.amountCents },
                  op.sameKeyAs !== null && op.sameKeyAs < i && batch[op.sameKeyAs] ? keys[op.sameKeyAs]! : keys[i]!,
                ),
              ),
            );
          }
          const balances = await Promise.all(ids.map(async (id) => (await service.getBalance(id)).balanceCents));
          expect(balances.reduce((x, y) => x + y, 0)).toBe(0);
          for (const b of balances.slice(1)) expect(b).toBeGreaterThanOrEqual(0);
          // Each account's statement rows sum to its balance.
          for (const [i, id] of ids.entries()) {
            const rows = (await service.listTransactions(id, 100)).items;
            expect(rows.reduce((s, r) => s + r.amountCents, 0)).toBe(balances[i]);
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});
