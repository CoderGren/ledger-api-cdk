import { LedgerError } from '../domain/errors.js';
import { applyTransaction, toAccountEntries, type Account, type AccountEntry, type Transaction } from '../domain/ledger.js';
import type { IdempotencyRecord, LedgerRepository, Page } from './repository.js';

/**
 * In-memory adapter with the same atomic semantics as the DynamoDB adapter.
 * Used by unit and property-based tests, and handy for local development.
 */
export class InMemoryLedgerRepository implements LedgerRepository {
  readonly accounts = new Map<string, Account>();
  readonly transactions = new Map<string, Transaction>();
  readonly reversedBy = new Map<string, string>();
  readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly entries = new Map<string, AccountEntry[]>();

  constructor(private readonly nowEpochSeconds: () => number = () => Math.floor(Date.now() / 1000)) {}

  private claimKey(idem: IdempotencyRecord): void {
    const existing = this.idempotency.get(`${idem.scope}#${idem.key}`);
    if (existing && existing.expiresAt > this.nowEpochSeconds()) {
      throw new LedgerError('IDEMPOTENCY_CONFLICT', 'idempotency key already used');
    }
  }

  async createAccount(account: Account, idem?: IdempotencyRecord): Promise<void> {
    if (idem) this.claimKey(idem);
    if (this.accounts.has(account.id)) throw new LedgerError('CONCURRENT_UPDATE', 'account already exists');
    if (idem) this.idempotency.set(`${idem.scope}#${idem.key}`, idem);
    this.accounts.set(account.id, { ...account });
  }

  async getAccount(id: string): Promise<Account | undefined> {
    const a = this.accounts.get(id);
    return a ? { ...a } : undefined;
  }

  async getTransaction(id: string): Promise<(Transaction & { reversedBy?: string }) | undefined> {
    const txn = this.transactions.get(id);
    if (!txn) return undefined;
    const reversedBy = this.reversedBy.get(id);
    return reversedBy ? { ...txn, reversedBy } : txn;
  }

  async getIdempotencyRecord(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
    return this.idempotency.get(`${scope}#${key}`);
  }

  async commit(txn: Transaction, idem: IdempotencyRecord): Promise<void> {
    // All checks first, then all writes: mirrors a DynamoDB TransactWriteItems call.
    this.claimKey(idem);
    if (txn.reversesTransactionId && this.reversedBy.has(txn.reversesTransactionId)) {
      throw new LedgerError('ALREADY_REVERSED', `transaction ${txn.reversesTransactionId} is already reversed`);
    }
    const balances = applyTransaction(this.accounts, txn);

    this.idempotency.set(`${idem.scope}#${idem.key}`, idem);
    this.transactions.set(txn.id, txn);
    if (txn.reversesTransactionId) this.reversedBy.set(txn.reversesTransactionId, txn.id);
    for (const [id, balance] of balances) this.accounts.get(id)!.balanceCents = balance;
    for (const entry of toAccountEntries(txn)) {
      const list = this.entries.get(entry.accountId) ?? [];
      list.unshift(entry);
      this.entries.set(entry.accountId, list);
    }
  }

  async listEntries(accountId: string, opts: { limit: number; cursor?: string }): Promise<Page<AccountEntry>> {
    const all = this.entries.get(accountId) ?? [];
    const start = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    const items = all.slice(start, start + opts.limit);
    const next = start + opts.limit;
    return next < all.length ? { items, nextCursor: String(next) } : { items };
  }
}
