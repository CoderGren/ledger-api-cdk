import { beforeEach, describe, expect, it } from 'vitest';
import { makeService, newKey } from './helpers.js';
import type { LedgerService } from '../src/domain/service.js';
import type { InMemoryLedgerRepository } from '../src/store/memory-repository.js';

let service: LedgerService;
let repo: InMemoryLedgerRepository;
let funding: string;
let alice: string;
let bob: string;

beforeEach(async () => {
  ({ service, repo } = makeService());
  funding = (await service.createFundingAccount({ name: 'Funding' })).id;
  alice = (await service.createAccount({ name: 'Alice' }, newKey())).account.id;
  bob = (await service.createAccount({ name: 'Bob' }, newKey())).account.id;
  await service.postTransfer({ fromAccountId: funding, toAccountId: alice, amountCents: 10_000 }, newKey());
});

describe('LedgerService', () => {
  it('posts a transfer and updates both balances', async () => {
    const { transaction, replayed } = await service.postTransfer(
      { fromAccountId: alice, toAccountId: bob, amountCents: 2_550, memo: 'Rent split' },
      newKey(),
    );
    expect(replayed).toBe(false);
    expect(transaction.kind).toBe('transfer');
    expect((await service.getBalance(alice)).balanceCents).toBe(7_450);
    expect((await service.getBalance(bob)).balanceCents).toBe(2_550);
  });

  it('replays an identical request with the same idempotency key without double-posting', async () => {
    const key = newKey();
    const body = { fromAccountId: alice, toAccountId: bob, amountCents: 1_000 };
    const first = await service.postTransfer(body, key);
    const second = await service.postTransfer({ ...body }, key);
    expect(second.replayed).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect((await service.getBalance(bob)).balanceCents).toBe(1_000);
  });

  it('rejects reuse of an idempotency key for a different request', async () => {
    const key = newKey();
    await service.postTransfer({ fromAccountId: alice, toAccountId: bob, amountCents: 1 }, key);
    await expect(service.postTransfer({ fromAccountId: alice, toAccountId: bob, amountCents: 2 }, key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    });
  });

  it('requires an idempotency key', async () => {
    await expect(service.postTransfer({ fromAccountId: alice, toAccountId: bob, amountCents: 1 }, undefined)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('refuses overdrafts atomically', async () => {
    await expect(service.postTransfer({ fromAccountId: alice, toAccountId: bob, amountCents: 10_001 }, newKey())).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      status: 422,
    });
    expect((await service.getBalance(alice)).balanceCents).toBe(10_000);
    expect((await service.getBalance(bob)).balanceCents).toBe(0);
  });

  it('returns 404 for unknown accounts', async () => {
    await expect(service.postTransfer({ fromAccountId: alice, toAccountId: 'nope', amountCents: 1 }, newKey())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.getBalance('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('reverses a transfer exactly once', async () => {
    const { transaction } = await service.postTransfer({ fromAccountId: alice, toAccountId: bob, amountCents: 4_000 }, newKey());
    const reversal = await service.reverse(transaction.id, newKey());
    expect(reversal.transaction.reversesTransactionId).toBe(transaction.id);
    expect((await service.getBalance(alice)).balanceCents).toBe(10_000);
    expect((await service.getBalance(bob)).balanceCents).toBe(0);
    await expect(service.reverse(transaction.id, newKey())).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
  });

  it('cannot reverse a transfer when the recipient already spent the money', async () => {
    const { transaction } = await service.postTransfer({ fromAccountId: alice, toAccountId: bob, amountCents: 4_000 }, newKey());
    await service.postTransfer({ fromAccountId: bob, toAccountId: alice, amountCents: 3_000 }, newKey());
    await expect(service.reverse(transaction.id, newKey())).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(repo.reversedBy.has(transaction.id)).toBe(false);
  });

  it('lists an account statement newest-first with cursor pagination', async () => {
    for (const amountCents of [100, 200, 300]) {
      await service.postTransfer({ fromAccountId: alice, toAccountId: bob, amountCents }, newKey());
    }
    const page1 = await service.listTransactions(bob, 2);
    expect(page1.items.map((e) => e.amountCents)).toEqual([300, 200]);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await service.listTransactions(bob, 2, page1.nextCursor);
    expect(page2.items.map((e) => e.amountCents)).toEqual([100]);
    expect(page2.nextCursor).toBeUndefined();
    await expect(service.listTransactions(bob, 0)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
