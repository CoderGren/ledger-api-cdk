import type { Account, AccountEntry, Transaction } from '../domain/ledger.js';

/**
 * Idempotency records are scoped per caller (`scope` is the authenticated principal, or
 * `anon` for the unauthenticated demo), so two clients that pick the same key never collide.
 */
export interface IdempotencyRecord {
  scope: string;
  key: string;
  fingerprint: string;
  resourceType: 'transaction' | 'account';
  resourceId: string;
  /** Epoch seconds. After this the key is treated as unused (DynamoDB TTL deletes it lazily). */
  expiresAt: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * Persistence port. Writes are atomic: the idempotency record and everything it covers either
 * all land or none do. An existing idempotency record only blocks a write while unexpired.
 */
export interface LedgerRepository {
  createAccount(account: Account, idempotency?: IdempotencyRecord): Promise<void>;
  getAccount(id: string): Promise<Account | undefined>;
  getTransaction(id: string): Promise<(Transaction & { reversedBy?: string }) | undefined>;
  getIdempotencyRecord(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  commit(txn: Transaction, idempotency: IdempotencyRecord): Promise<void>;
  listEntries(accountId: string, opts: { limit: number; cursor?: string }): Promise<Page<AccountEntry>>;
}
