import { randomUUID } from 'node:crypto';
import { LedgerError } from './errors.js';
import {
  buildAccount,
  buildReversal,
  buildTransfer,
  fingerprint,
  parseTransferInput,
  validateId,
  validateIdempotencyKey,
  type Account,
  type AccountEntry,
  parseCreateAccountInput,
  type CreateAccountInput,
  applyTransaction,
  type Transaction,
} from './ledger.js';
import type { LedgerRepository, Page } from '../store/repository.js';

export interface PostResult {
  transaction: Transaction;
  /** True when the idempotency key matched an earlier identical request. */
  replayed: boolean;
}

export interface AccountResult {
  account: Account;
  replayed: boolean;
}

/** Who is calling. `principal` scopes idempotency keys (and, with auth on, account ownership). */
export interface Caller {
  principal: string;
}

export const ANONYMOUS: Caller = { principal: 'anon' };

export interface ServiceDeps {
  repo: LedgerRepository;
  now?: () => string;
  newId?: () => string;
  /** Delay between retries of a contended write. Tests pass 0. */
  retryDelayMs?: (attempt: number) => number;
}

export const MAX_PAGE_SIZE = 100;
/** Idempotency keys are honored for 7 days from first use. */
export const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_COMMIT_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Application service: validation, idempotency and orchestration around the pure domain. */
export class LedgerService {
  private readonly repo: LedgerRepository;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly retryDelayMs: (attempt: number) => number;

  constructor(deps: ServiceDeps) {
    this.repo = deps.repo;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
    this.retryDelayMs = deps.retryDelayMs ?? ((attempt) => 20 * 2 ** attempt + Math.floor(Math.random() * 20));
  }

  private nowEpochSeconds(): number {
    return Math.floor(Date.parse(this.now()) / 1000);
  }

  private idempotencyRecord(caller: Caller, key: string, fp: string, resourceType: 'transaction' | 'account', resourceId: string) {
    return { scope: caller.principal, key, fingerprint: fp, resourceType, resourceId, expiresAt: this.nowEpochSeconds() + IDEMPOTENCY_TTL_SECONDS };
  }

  /** Public path (POST /accounts): always a customer account that can't go negative. Idempotent. */
  async createAccount(body: unknown, idempotencyKey: unknown, caller: Caller = ANONYMOUS): Promise<AccountResult> {
    const key = validateIdempotencyKey(idempotencyKey);
    const input = parseCreateAccountInput(body);
    const fp = fingerprint('createAccount', input);
    return this.withRetries(async () => {
      const prior = await this.findRecord(caller, key, fp);
      if (prior) {
        const account = await this.repo.getAccount(prior.resourceId); // scoped record, so owned by caller
        if (!account) throw new LedgerError('CONCURRENT_UPDATE', 'account for idempotency key not yet visible');
        return { account, replayed: true };
      }
      const account = buildAccount(input, this.newId(), this.now(), { ownerId: caller.principal });
      await this.repo.createAccount(account, this.idempotencyRecord(caller, key, fp, 'account', account.id));
      return { account, replayed: false };
    });
  }

  /**
   * Trusted path for funding/clearing accounts (money enters the ledger from them).
   * Not reachable over HTTP: used by `bin/seed.ts` with the operator's own IAM credentials.
   */
  async createFundingAccount(input: CreateAccountInput, ownerId = ANONYMOUS.principal): Promise<Account> {
    const account = buildAccount(input, this.newId(), this.now(), { allowNegative: true, ownerId });
    await this.repo.createAccount(account);
    return account;
  }

  /**
   * Reads are owner-only. Someone else's account is a 404, not a 403, so ids can't be probed.
   * In the unauthenticated demo every caller is `anon`, so the demo is single-tenant by design.
   */
  async getBalance(accountId: string, caller: Caller = ANONYMOUS): Promise<Account> {
    const account = await this.repo.getAccount(validateId(accountId, 'accountId'));
    if (!account || account.ownerId !== caller.principal) throw new LedgerError('NOT_FOUND', `account ${accountId} not found`);
    return account;
  }

  async listTransactions(accountId: string, limit = 25, cursor?: string, caller: Caller = ANONYMOUS): Promise<Page<AccountEntry>> {
    await this.getBalance(accountId, caller);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new LedgerError('VALIDATION', `limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    }
    return this.repo.listEntries(accountId, { limit, ...(cursor ? { cursor } : {}) });
  }

  async postTransfer(body: unknown, idempotencyKey: unknown, caller: Caller = ANONYMOUS): Promise<PostResult> {
    const key = validateIdempotencyKey(idempotencyKey);
    const input = parseTransferInput(body);
    const fp = fingerprint('transfer', input);
    return this.withRetries(async () => {
      const replay = await this.replay(caller, key, fp);
      if (replay) return replay;

      const [from, to] = await Promise.all([this.repo.getAccount(input.fromAccountId), this.repo.getAccount(input.toAccountId)]);
      // Only the owner can debit an account; anyone can be paid by id.
      if (!from || from.ownerId !== caller.principal) throw new LedgerError('NOT_FOUND', `account ${input.fromAccountId} not found`);
      if (!to) throw new LedgerError('NOT_FOUND', `account ${input.toAccountId} not found`);

      const txn = buildTransfer(input, from, to, { id: this.newId(), idempotencyKey: key, now: this.now() });
      applyTransaction(new Map([[from.id, from], [to.id, to]]), txn); // friendly pre-check; commit re-checks atomically
      return this.commit(caller, txn, key, fp);
    });
  }

  async reverse(transactionId: string, idempotencyKey: unknown, caller: Caller = ANONYMOUS): Promise<PostResult> {
    const key = validateIdempotencyKey(idempotencyKey);
    const id = validateId(transactionId, 'transactionId');
    const fp = fingerprint('reversal', { transactionId: id });
    return this.withRetries(async () => {
      const replay = await this.replay(caller, key, fp);
      if (replay) return replay;

      const original = await this.repo.getTransaction(id);
      if (!original) throw new LedgerError('NOT_FOUND', `transaction ${id} not found`);
      // Only the owner of the account that was debited can reverse a transfer.
      const debited = original.entries.find((e) => e.amountCents < 0);
      const debitedAccount = debited && (await this.repo.getAccount(debited.accountId));
      if (!debitedAccount || debitedAccount.ownerId !== caller.principal) {
        throw new LedgerError('NOT_FOUND', `transaction ${id} not found`);
      }
      if (original.reversedBy) throw new LedgerError('ALREADY_REVERSED', `transaction ${id} is already reversed`);
      const { reversedBy: _r, ...plain } = original;
      const txn = buildReversal(plain, { id: this.newId(), idempotencyKey: key, now: this.now() });
      return this.commit(caller, txn, key, fp);
    });
  }

  private async commit(caller: Caller, txn: Transaction, key: string, fp: string): Promise<PostResult> {
    try {
      await this.repo.commit(txn, this.idempotencyRecord(caller, key, fp, 'transaction', txn.id));
      return { transaction: txn, replayed: false };
    } catch (err) {
      // Two identical requests raced: the loser replays the winner's result.
      if (err instanceof LedgerError && err.code === 'IDEMPOTENCY_CONFLICT') {
        const replay = await this.replay(caller, key, fp);
        if (replay) return replay;
      }
      throw err;
    }
  }

  /**
   * Contended writes (DynamoDB TransactionConflict) are retried server-side with backoff.
   * That is safe because every attempt carries the same idempotency key.
   */
  private async withRetries<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const retryable = err instanceof LedgerError && err.code === 'CONCURRENT_UPDATE';
        if (!retryable || attempt + 1 >= MAX_COMMIT_ATTEMPTS) throw err;
        const delay = this.retryDelayMs(attempt);
        if (delay > 0) await sleep(delay);
      }
    }
  }

  /** Returns the caller's unexpired record for this key, or throws if it belongs to a different request. */
  private async findRecord(caller: Caller, key: string, fp: string) {
    const record = await this.repo.getIdempotencyRecord(caller.principal, key);
    // Expired records are ignored deterministically, even before DynamoDB TTL deletes them.
    if (!record || record.expiresAt <= this.nowEpochSeconds()) return undefined;
    if (record.fingerprint !== fp) {
      throw new LedgerError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request');
    }
    return record;
  }

  private async replay(caller: Caller, key: string, fp: string): Promise<PostResult | undefined> {
    const record = await this.findRecord(caller, key, fp);
    if (!record) return undefined;
    const found = await this.repo.getTransaction(record.resourceId);
    if (!found) throw new LedgerError('CONCURRENT_UPDATE', 'transaction for idempotency key not yet visible');
    const { reversedBy: _r, ...transaction } = found;
    return { transaction, replayed: true };
  }
}
