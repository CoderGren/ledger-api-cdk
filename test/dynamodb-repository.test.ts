import { DynamoDBClient, IdempotentParameterMismatchException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { LedgerError } from '../src/domain/errors.js';
import { MAX_BALANCE_CENTS } from '../src/domain/money.js';
import type { Transaction } from '../src/domain/ledger.js';
import { decodeCursor, DynamoDbLedgerRepository, encodeCursor, mapCancellation } from '../src/store/dynamodb-repository.js';

const ddb = mockClient(DynamoDBDocumentClient);
const repo = new DynamoDbLedgerRepository(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), 'Ledger');

const transfer: Transaction = {
  id: 't1',
  kind: 'transfer',
  currency: 'USD',
  entries: [
    { accountId: 'a', amountCents: -500 },
    { accountId: 'b', amountCents: 500 },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  idempotencyKey: 'key-00001',
};
const reversal: Transaction = {
  ...transfer,
  id: 't2',
  kind: 'reversal',
  entries: [
    { accountId: 'a', amountCents: 500 },
    { accountId: 'b', amountCents: -500 },
  ],
  reversesTransactionId: 't1',
};
const idem = { scope: 'anon', key: 'key-00001', fingerprint: 'fp', resourceType: 'transaction' as const, resourceId: 't1', expiresAt: 2_000_000_000 };

const cancelled = (codes: string[]) =>
  new TransactionCanceledException({ message: 'cancelled', $metadata: {}, CancellationReasons: codes.map((Code) => ({ Code })) });

beforeEach(() => ddb.reset());

describe('DynamoDbLedgerRepository', () => {
  it('commits a transfer as one TransactWriteItems call with guarded balance updates', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await repo.commit(transfer, idem);
    const calls = ddb.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    const items = calls[0]!.args[0].input.TransactItems!;
    // idempotency + transaction + 2 balance updates + 2 statement entries
    expect(items).toHaveLength(6);
    // Should-fix: keys are scoped per caller, and an expired record no longer blocks reuse.
    expect(items[0]!.Put!.Item).toMatchObject({ PK: 'IDEMPOTENCY#anon#key-00001', expiresAt: 2_000_000_000, resourceId: 't1' });
    expect(items[0]!.Put!.ConditionExpression).toBe('attribute_not_exists(PK) OR expiresAt <= :now');
    expect(calls[0]!.args[0].input.ClientRequestToken).toMatch(/^[0-9a-f]{36}$/);
    const debit = items[2]!.Update!;
    expect(debit.Key).toEqual({ PK: 'ACCOUNT#a', SK: 'PROFILE' });
    expect(debit.UpdateExpression).toBe('ADD balanceCents :delta');
    expect(debit.ConditionExpression).toContain('balanceCents >= :required');
    expect(debit.ExpressionAttributeValues).toMatchObject({ ':delta': -500, ':required': 500, ':fundingFloor': -MAX_BALANCE_CENTS + 500 });
    const credit = items[3]!.Update!;
    expect(credit.ConditionExpression).not.toContain(':required');
    // L-M2: a server-side ADD can never push a balance past the bound (and so never past 2^53).
    expect(credit.ConditionExpression).toContain('balanceCents <= :ceiling');
    expect(credit.ExpressionAttributeValues).toMatchObject({ ':ceiling': MAX_BALANCE_CENTS - 500 });
    expect(MAX_BALANCE_CENTS + 10_000_000_000).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('records a reversal as an insert-only marker item, never mutating the original', () => {
    const items = repo.buildCommitItems(reversal, { ...idem, resourceId: 't2' }, 0);
    expect(items.some((i) => i.Update && i.Update.Key!.PK === 'TXN#t1')).toBe(false);
    const marker = items.at(-1)!.Put!;
    expect(marker.Item).toMatchObject({ PK: 'TXN#t1', SK: 'REVERSAL', reversedBy: 't2' });
    expect(marker.ConditionExpression).toBe('attribute_not_exists(PK)');
    // Statement rows go to STMT#, and the only Updates are balance updates on ACCOUNT#.
    expect(items.filter((i) => i.Update).every((i) => String(i.Update!.Key!.PK).startsWith('ACCOUNT#'))).toBe(true);
    expect(items.filter((i) => i.Put?.Item?.type === 'Entry').map((i) => String(i.Put!.Item!.PK))).toEqual(['STMT#a', 'STMT#b']);
  });

  it('reads a transaction and its reversal marker with one consistent Query', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { PK: 'TXN#t1', SK: 'REVERSAL', type: 'Reversal', reversedBy: 't2', createdAt: 'y' },
        { PK: 'TXN#t1', SK: 'TXN', type: 'Transaction', ...transfer },
      ],
    });
    expect(await repo.getTransaction('t1')).toEqual({ ...transfer, reversedBy: 't2' });
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
    ddb.on(QueryCommand).resolves({ Items: [] });
    expect(await repo.getTransaction('nope')).toBeUndefined();
  });

  it('maps cancellation reasons to domain errors', () => {
    const none = 'None';
    const ccf = 'ConditionalCheckFailed';
    expect(mapCancellation(cancelled([ccf, none, none, none, none, none]), transfer)).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(mapCancellation(cancelled([none, none, ccf, none, none, none]), transfer)).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(mapCancellation(cancelled([none, none, none, ccf, none, none]), transfer)).toMatchObject({ code: 'VALIDATION' });
    expect(mapCancellation(cancelled([none, none, none, none, none, none, ccf]), reversal)).toMatchObject({ code: 'ALREADY_REVERSED' });
    expect(mapCancellation(cancelled([none, 'TransactionConflict']), transfer)).toMatchObject({ code: 'CONCURRENT_UPDATE' });
    const other = new Error('boom');
    expect(mapCancellation(other, transfer)).toBe(other);
  });

  it('creates an account and its idempotency record in one atomic write', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const account = { id: 'a', name: 'A', currency: 'USD' as const, balanceCents: 0, allowNegative: false, ownerId: 'sub:u1', createdAt: 'x' };
    await repo.createAccount(account, { ...idem, scope: 'sub:u1', resourceType: 'account', resourceId: 'a' });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items.map((i) => i.Put!.Item!.PK)).toEqual(['IDEMPOTENCY#sub:u1#key-00001', 'ACCOUNT#a']);
    expect(mapCancellation(cancelled(['ConditionalCheckFailed', 'None']))).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(mapCancellation(cancelled(['None', 'TransactionConflict']))).toMatchObject({ code: 'CONCURRENT_UPDATE' });
  });

  it('treats a same-token mismatch from DynamoDB as a retryable same-key race', () => {
    const err = new IdempotentParameterMismatchException({ message: 'mismatch', $metadata: {} });
    expect(mapCancellation(err, transfer)).toMatchObject({ code: 'CONCURRENT_UPDATE' });
  });

  it('surfaces insufficient funds from DynamoDB as a LedgerError', async () => {
    ddb.on(TransactWriteCommand).rejects(cancelled(['None', 'None', 'ConditionalCheckFailed', 'None', 'None', 'None']));
    await expect(repo.commit(transfer, idem)).rejects.toBeInstanceOf(LedgerError);
  });

  it('reads accounts with strongly consistent reads and strips key attributes', async () => {
    ddb.on(GetCommand).resolves({
      Item: { PK: 'ACCOUNT#a', SK: 'PROFILE', type: 'Account', id: 'a', name: 'A', currency: 'USD', balanceCents: 5, allowNegative: false, createdAt: 'x' },
    });
    // Items written before ownership existed read back as owned by `anon`.
    expect(await repo.getAccount('a')).toEqual({ id: 'a', name: 'A', currency: 'USD', balanceCents: 5, allowNegative: false, ownerId: 'anon', createdAt: 'x' });
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
  });

  it('paginates statements newest-first with an opaque cursor', async () => {
    const lastKey = { PK: 'STMT#a', SK: 'ENTRY#2026#t1#0' };
    ddb.on(QueryCommand).resolves({ Items: [{ PK: 'STMT#a', SK: 'ENTRY#x', type: 'Entry', transactionId: 't1', amountCents: 5 }], LastEvaluatedKey: lastKey });
    const page = await repo.listEntries('a', { limit: 1 });
    expect(page.items[0]).toEqual({ transactionId: 't1', amountCents: 5 });
    const q = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(q.ScanIndexForward).toBe(false);
    // Statement rows have their own partition (STMT#), separate from the ACCOUNT# profile item.
    expect(q.ExpressionAttributeValues).toMatchObject({ ':pk': 'STMT#a' });
    expect(decodeCursor(page.nextCursor!, 'STMT#a')).toEqual(lastKey);
  });

  it('refuses a cursor that points at another account', () => {
    const forged = encodeCursor({ PK: 'STMT#someone-else', SK: 'ENTRY#x' });
    expect(() => decodeCursor(forged, 'STMT#a')).toThrow(/invalid cursor/);
    expect(() => decodeCursor('not-base64-json', 'STMT#a')).toThrow(/invalid cursor/);
  });
});
