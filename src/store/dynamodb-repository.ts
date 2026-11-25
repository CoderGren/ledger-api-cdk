import { createHash } from 'node:crypto';
import { IdempotentParameterMismatchException, TransactionCanceledException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { LedgerError } from '../domain/errors.js';
import { MAX_BALANCE_CENTS } from '../domain/money.js';
import { toAccountEntries, type Account, type AccountEntry, type Transaction } from '../domain/ledger.js';
import type { IdempotencyRecord, LedgerRepository, Page } from './repository.js';

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** Single-table key design. */
export const keys = {
  account: (id: string) => ({ PK: `ACCOUNT#${id}`, SK: 'PROFILE' }),
  /** Statement rows live in their own partition so IAM can keep writes to ACCOUNT# as UpdateItem only. */
  statement: (accountId: string) => `STMT#${accountId}`,
  entry: (e: AccountEntry, leg: number) => ({ PK: `STMT#${e.accountId}`, SK: `ENTRY#${e.createdAt}#${e.transactionId}#${leg}` }),
  transaction: (id: string) => ({ PK: `TXN#${id}`, SK: 'TXN' }),
  /** Marker written when a transaction is reversed; the original transaction item is never mutated. */
  reversal: (originalId: string) => ({ PK: `TXN#${originalId}`, SK: 'REVERSAL' }),
  /** Scoped per caller: two clients using the same key never collide. */
  idempotency: (scope: string, key: string) => ({ PK: `IDEMPOTENCY#${scope}#${key}`, SK: 'IDEMPOTENCY' }),
};

/** An idempotency record blocks a new write only while it is unexpired. */
const CLAIM_KEY_CONDITION = 'attribute_not_exists(PK) OR expiresAt <= :now';

/** DynamoDB's own 10-minute request idempotency, derived from the caller-scoped key and request. */
function clientRequestToken(idem: IdempotencyRecord): string {
  return createHash('sha256').update(`${idem.scope}|${idem.key}|${idem.fingerprint}`).digest('hex').slice(0, 36);
}

function idempotencyPut(tableName: string, idem: IdempotencyRecord, nowEpochSeconds: number): TransactItem {
  return {
    Put: {
      TableName: tableName,
      Item: {
        ...keys.idempotency(idem.scope, idem.key),
        type: 'Idempotency',
        scope: idem.scope,
        fingerprint: idem.fingerprint,
        resourceType: idem.resourceType,
        resourceId: idem.resourceId,
        expiresAt: idem.expiresAt,
      },
      ConditionExpression: CLAIM_KEY_CONDITION,
      ExpressionAttributeValues: { ':now': nowEpochSeconds },
    },
  };
}

export class DynamoDbLedgerRepository implements LedgerRepository {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    client: DynamoDBClient | DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    this.doc = client instanceof DynamoDBDocumentClient ? client : DynamoDBDocumentClient.from(client);
  }

  async createAccount(account: Account, idem?: IdempotencyRecord): Promise<void> {
    const put = {
      TableName: this.tableName,
      Item: { ...keys.account(account.id), type: 'Account', ...account },
      ConditionExpression: 'attribute_not_exists(PK)',
    };
    if (!idem) {
      await this.doc.send(new PutCommand(put));
      return;
    }
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [idempotencyPut(this.tableName, idem, Math.floor(Date.now() / 1000)), { Put: put }],
          ClientRequestToken: clientRequestToken(idem),
        }),
      );
    } catch (err) {
      throw mapCancellation(err);
    }
  }

  async getAccount(id: string): Promise<Account | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: keys.account(id), ConsistentRead: true }));
    if (!res.Item) return undefined;
    const { id: accountId, name, currency, balanceCents, allowNegative, ownerId, createdAt } = res.Item as Account;
    return { id: accountId, name, currency, balanceCents, allowNegative, ownerId: ownerId ?? 'anon', createdAt };
  }

  /** One strongly consistent Query returns the transaction and, if present, its reversal marker. */
  async getTransaction(id: string): Promise<(Transaction & { reversedBy?: string }) | undefined> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': keys.transaction(id).PK },
        ConsistentRead: true,
      }),
    );
    const items = res.Items ?? [];
    const txnItem = items.find((i) => i.SK === 'TXN');
    if (!txnItem) return undefined;
    const { PK: _pk, SK: _sk, type: _type, ...txn } = txnItem;
    const marker = items.find((i) => i.SK === 'REVERSAL');
    return marker ? { ...(txn as Transaction), reversedBy: marker.reversedBy as string } : (txn as Transaction);
  }

  async getIdempotencyRecord(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: keys.idempotency(scope, key), ConsistentRead: true }));
    if (!res.Item) return undefined;
    return {
      scope,
      key,
      fingerprint: res.Item.fingerprint as string,
      resourceType: res.Item.resourceType as IdempotencyRecord['resourceType'],
      resourceId: res.Item.resourceId as string,
      expiresAt: Number(res.Item.expiresAt),
    };
  }

  /** Builds the single atomic TransactWriteItems request for a transaction. Exposed for tests. */
  buildCommitItems(txn: Transaction, idem: IdempotencyRecord, nowEpochSeconds: number): TransactItem[] {
    const items: TransactItem[] = [
      idempotencyPut(this.tableName, idem, nowEpochSeconds),
      {
        Put: {
          TableName: this.tableName,
          Item: { ...keys.transaction(txn.id), type: 'Transaction', ...txn },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ];

    for (const entry of txn.entries) {
      const isDebit = entry.amountCents < 0;
      // `ADD` runs server-side, so the bounds must live in the condition: customer accounts
      // stay >= 0, and every balance stays within +/- MAX_BALANCE_CENTS (far below 2^53).
      items.push({
        Update: {
          TableName: this.tableName,
          Key: keys.account(entry.accountId),
          UpdateExpression: 'ADD balanceCents :delta',
          ConditionExpression: isDebit
            ? 'attribute_exists(PK) AND currency = :currency AND (balanceCents >= :required OR (allowNegative = :true AND balanceCents >= :fundingFloor))'
            : 'attribute_exists(PK) AND currency = :currency AND balanceCents <= :ceiling',
          ExpressionAttributeValues: {
            ':delta': entry.amountCents,
            ':currency': txn.currency,
            ...(isDebit
              ? { ':true': true, ':required': -entry.amountCents, ':fundingFloor': -MAX_BALANCE_CENTS - entry.amountCents }
              : { ':ceiling': MAX_BALANCE_CENTS - entry.amountCents }),
          },
        },
      });
    }

    toAccountEntries(txn).forEach((entry, leg) => {
      items.push({ Put: { TableName: this.tableName, Item: { ...keys.entry(entry, leg), type: 'Entry', ...entry } } });
    });

    if (txn.reversesTransactionId) {
      // A separate marker item (insert-only), so the original transaction stays immutable.
      items.push({
        Put: {
          TableName: this.tableName,
          Item: { ...keys.reversal(txn.reversesTransactionId), type: 'Reversal', reversedBy: txn.id, createdAt: txn.createdAt },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      });
    }
    return items;
  }

  async commit(txn: Transaction, idem: IdempotencyRecord): Promise<void> {
    const items = this.buildCommitItems(txn, idem, Math.floor(Date.now() / 1000));
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: items, ClientRequestToken: clientRequestToken(idem) }));
    } catch (err) {
      throw mapCancellation(err, txn);
    }
  }

  async listEntries(accountId: string, opts: { limit: number; cursor?: string }): Promise<Page<AccountEntry>> {
    const pk = keys.statement(accountId);
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :entry)',
        ExpressionAttributeValues: { ':pk': pk, ':entry': 'ENTRY#' },
        ScanIndexForward: false,
        Limit: opts.limit,
        ...(opts.cursor ? { ExclusiveStartKey: decodeCursor(opts.cursor, pk) } : {}),
      }),
    );
    const items = (res.Items ?? []).map(({ PK: _pk, SK: _sk, type: _t, ...rest }) => rest as AccountEntry);
    return res.LastEvaluatedKey ? { items, nextCursor: encodeCursor(res.LastEvaluatedKey) } : { items };
  }
}

export function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

/** Decodes a pagination cursor and refuses one that points at another partition. */
export function decodeCursor(cursor: string, expectedPk: string): Record<string, unknown> {
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (key.PK === expectedPk && typeof key.SK === 'string' && key.SK.startsWith('ENTRY#') && Object.keys(key).length === 2) {
      return key;
    }
  } catch {
    // fall through
  }
  throw new LedgerError('VALIDATION', 'invalid cursor');
}

/** Maps a cancelled DynamoDB transaction to a domain error using the per-item cancellation reasons. */
export function mapCancellation(err: unknown, txn?: Transaction): unknown {
  // Same token, different request inside DynamoDB's 10-minute window: a same-key race. Retryable.
  if (err instanceof IdempotentParameterMismatchException) {
    return new LedgerError('CONCURRENT_UPDATE', 'concurrent request with the same Idempotency-Key');
  }
  if (!(err instanceof TransactionCanceledException)) return err;
  const reasons = err.CancellationReasons ?? [];
  const failed = reasons.findIndex((r) => r.Code === 'ConditionalCheckFailed');
  if (failed === 0) return new LedgerError('IDEMPOTENCY_CONFLICT', 'idempotency key already used');
  if (!txn) {
    return reasons.some((r) => r.Code === 'TransactionConflict')
      ? new LedgerError('CONCURRENT_UPDATE', 'concurrent update, retry with the same Idempotency-Key')
      : err;
  }
  const accountUpdatesStart = 2;
  const accountUpdatesEnd = accountUpdatesStart + txn.entries.length;
  if (failed >= accountUpdatesStart && failed < accountUpdatesEnd) {
    const entry = txn.entries[failed - accountUpdatesStart]!;
    // Existence and currency are checked before commit, so a failed credit here means the
    // balance ceiling was hit by a concurrent write.
    return entry.amountCents < 0
      ? new LedgerError('INSUFFICIENT_FUNDS', `account ${entry.accountId} has insufficient funds`)
      : new LedgerError('VALIDATION', `account ${entry.accountId} would exceed the maximum balance`);
  }
  if (failed === reasons.length - 1 && txn.reversesTransactionId) {
    return new LedgerError('ALREADY_REVERSED', `transaction ${txn.reversesTransactionId} is already reversed`);
  }
  if (reasons.some((r) => r.Code === 'TransactionConflict')) {
    return new LedgerError('CONCURRENT_UPDATE', 'concurrent update, retry with the same Idempotency-Key');
  }
  return err;
}
