import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/domain/errors.js';
import {
  applyTransaction,
  assertBalanced,
  buildAccount,
  buildReversal,
  buildTransfer,
  fingerprint,
  parseTransferInput,
  toAccountEntries,
  type Account,
} from '../src/domain/ledger.js';

const NOW = '2026-01-01T00:00:00.000Z';
const acct = (id: string, balanceCents: number, extra: Partial<Account> = {}): Account => ({
  id,
  name: id,
  currency: 'USD',
  balanceCents,
  allowNegative: false,
  ownerId: 'anon',
  createdAt: NOW,
  ...extra,
});
const ids = { id: 'txn-1', idempotencyKey: 'key-00001', now: NOW };

describe('buildAccount', () => {
  it('defaults to a USD account that cannot go negative', () => {
    expect(buildAccount({ name: ' Operating ' }, 'a1', NOW)).toEqual(acct('a1', 0, { name: 'Operating' }));
  });
  it('rejects bad names and currencies', () => {
    expect(() => buildAccount({ name: '' }, 'a1', NOW)).toThrow(LedgerError);
    expect(() => buildAccount({ name: 'x', currency: 'BTC' }, 'a1', NOW)).toThrow(/unsupported currency/);
  });
});

describe('parseTransferInput', () => {
  it('rejects float amounts, same-account transfers and long memos', () => {
    const base = { fromAccountId: 'a', toAccountId: 'b', amountCents: 100 };
    expect(parseTransferInput(base)).toEqual(base);
    expect(() => parseTransferInput({ ...base, amountCents: 1.5 })).toThrow(/safe integer/);
    expect(() => parseTransferInput({ ...base, amountCents: '100' })).toThrow(LedgerError);
    expect(() => parseTransferInput({ ...base, toAccountId: 'a' })).toThrow(/must differ/);
    expect(() => parseTransferInput({ ...base, memo: 'x'.repeat(141) })).toThrow(/memo/);
    expect(() => parseTransferInput({ ...base, fromAccountId: '../etc' })).toThrow(/fromAccountId/);
  });
});

describe('double-entry transactions', () => {
  it('a transfer debits the source and credits the destination by the same amount', () => {
    const txn = buildTransfer({ fromAccountId: 'a', toAccountId: 'b', amountCents: 2500 }, acct('a', 5000), acct('b', 0), ids);
    expect(txn.entries).toEqual([
      { accountId: 'a', amountCents: -2500 },
      { accountId: 'b', amountCents: 2500 },
    ]);
    expect(() => assertBalanced(txn)).not.toThrow();
  });

  it('refuses cross-currency transfers', () => {
    expect(() =>
      buildTransfer({ fromAccountId: 'a', toAccountId: 'b', amountCents: 1 }, acct('a', 10), acct('b', 0, { currency: 'EUR' }), ids),
    ).toThrow(expect.objectContaining({ code: 'CURRENCY_MISMATCH' }));
  });

  it('a reversal mirrors the original entries and cannot itself be reversed', () => {
    const original = buildTransfer({ fromAccountId: 'a', toAccountId: 'b', amountCents: 700 }, acct('a', 700), acct('b', 0), ids);
    const reversal = buildReversal(original, { ...ids, id: 'txn-2' });
    expect(reversal.entries).toEqual([
      { accountId: 'a', amountCents: 700 },
      { accountId: 'b', amountCents: -700 },
    ]);
    expect(reversal.reversesTransactionId).toBe('txn-1');
    expect(toAccountEntries(reversal).every((e) => e.reversesTransactionId === 'txn-1')).toBe(true);
    expect(() => buildReversal(reversal, { ...ids, id: 'txn-3' })).toThrow(/cannot itself be reversed/);
  });

  it('rejects unbalanced or single-entry transactions', () => {
    expect(() => assertBalanced({ entries: [{ accountId: 'a', amountCents: 1 }, { accountId: 'b', amountCents: 0 }] })).toThrow(/sum to zero/);
    expect(() => assertBalanced({ entries: [{ accountId: 'a', amountCents: 0 }] })).toThrow(/at least two/);
  });

  it('applyTransaction enforces non-negative balances except for funding accounts', () => {
    const accounts = new Map([
      ['a', acct('a', 100)],
      ['b', acct('b', 0)],
      ['funding', acct('funding', 0, { allowNegative: true })],
    ]);
    const tooMuch = buildTransfer({ fromAccountId: 'a', toAccountId: 'b', amountCents: 101 }, accounts.get('a')!, accounts.get('b')!, ids);
    expect(() => applyTransaction(accounts, tooMuch)).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }));

    const fund = buildTransfer({ fromAccountId: 'funding', toAccountId: 'b', amountCents: 10_000 }, accounts.get('funding')!, accounts.get('b')!, ids);
    expect(Object.fromEntries(applyTransaction(accounts, fund))).toEqual({ funding: -10_000, b: 10_000 });
  });

  it('produces one statement row per leg with its counterparty', () => {
    const txn = buildTransfer({ fromAccountId: 'a', toAccountId: 'b', amountCents: 5, memo: 'Coffee' }, acct('a', 5), acct('b', 0), ids);
    expect(toAccountEntries(txn).map((e) => [e.accountId, e.counterpartyAccountId, e.amountCents, e.memo])).toEqual([
      ['a', 'b', -5, 'Coffee'],
      ['b', 'a', 5, 'Coffee'],
    ]);
  });
});

describe('fingerprint', () => {
  it('is independent of key order but sensitive to values', () => {
    expect(fingerprint('t', { a: 1, b: 2 })).toBe(fingerprint('t', { b: 2, a: 1 }));
    expect(fingerprint('t', { a: 1 })).not.toBe(fingerprint('t', { a: 2 }));
    expect(fingerprint('t', { a: 1 })).not.toBe(fingerprint('u', { a: 1 }));
  });
});
