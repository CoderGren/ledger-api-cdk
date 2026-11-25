import { createHash } from 'node:crypto';
import { LedgerError } from './errors.js';
import {
  MAX_BALANCE_CENTS,
  assertPositiveCents,
  isCurrency,
  negateCents,
  sumCents,
  type Cents,
  type Currency,
} from './money.js';

export interface Account {
  id: string;
  name: string;
  currency: Currency;
  /** Sum of every entry ever posted to this account, in minor units. */
  balanceCents: Cents;
  /** Funding/clearing accounts may go negative; customer accounts may not. */
  allowNegative: boolean;
  /** Principal that owns the account (JWT `sub:<id>`, or `anon` in the unauthenticated demo). */
  ownerId: string;
  createdAt: string;
}

/** One leg of a double-entry transaction. Positive credits the account, negative debits it. */
export interface Entry {
  accountId: string;
  amountCents: Cents;
}

export type TransactionKind = 'transfer' | 'reversal';

export interface Transaction {
  id: string;
  kind: TransactionKind;
  currency: Currency;
  entries: Entry[];
  memo?: string;
  createdAt: string;
  idempotencyKey: string;
  /** Set on a reversal: the transaction it reverses. */
  reversesTransactionId?: string;
}

/** A row in an account's statement. */
export interface AccountEntry {
  transactionId: string;
  accountId: string;
  counterpartyAccountId: string;
  kind: TransactionKind;
  amountCents: Cents;
  currency: Currency;
  memo?: string;
  createdAt: string;
  /** On reversal rows: the transaction being reversed. */
  reversesTransactionId?: string;
}

/** Public account-creation input. Funding accounts are never created through the API. */
export interface CreateAccountInput {
  name: string;
  currency?: string;
}

const CREATE_ACCOUNT_FIELDS = new Set(['name', 'currency']);

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  memo?: string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
export const MAX_MEMO_LENGTH = 140;

export function validateId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new LedgerError('VALIDATION', `${field} must be 1-64 characters of [A-Za-z0-9_-]`);
  }
  return value;
}

export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new LedgerError('VALIDATION', 'Idempotency-Key header must be 8-128 characters of [A-Za-z0-9_.:-]');
  }
  return value;
}

function validateMemo(memo: unknown): string | undefined {
  if (memo === undefined || memo === null || memo === '') return undefined;
  if (typeof memo !== 'string' || memo.length > MAX_MEMO_LENGTH) {
    throw new LedgerError('VALIDATION', `memo must be a string of at most ${MAX_MEMO_LENGTH} characters`);
  }
  return memo;
}

/**
 * Validates a public POST /accounts body. Unknown fields are rejected, so a caller can't
 * smuggle in `allowNegative` and mint money from a self-made funding account.
 */
export function parseCreateAccountInput(body: unknown): CreateAccountInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new LedgerError('VALIDATION', 'request body must be a JSON object');
  }
  for (const key of Object.keys(body)) {
    if (key === 'allowNegative') {
      throw new LedgerError('VALIDATION', 'allowNegative cannot be set through the API; funding accounts are created out of band');
    }
    if (!CREATE_ACCOUNT_FIELDS.has(key)) throw new LedgerError('VALIDATION', `unknown field: ${key}`);
  }
  const b = body as Record<string, unknown>;
  return { name: b.name as string, ...(b.currency !== undefined ? { currency: b.currency as string } : {}) };
}

/**
 * Builds a new account. `allowNegative` is only for funding/clearing accounts created by
 * trusted code (the seed script), never from request input.
 */
export function buildAccount(
  input: CreateAccountInput,
  id: string,
  now: string,
  opts: { allowNegative?: boolean; ownerId?: string } = {},
): Account {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (name.length < 1 || name.length > 80) {
    throw new LedgerError('VALIDATION', 'name must be 1-80 characters');
  }
  const currency = input.currency ?? 'USD';
  if (!isCurrency(currency)) throw new LedgerError('VALIDATION', `unsupported currency: ${String(currency)}`);
  return { id, name, currency, balanceCents: 0, allowNegative: opts.allowNegative === true, ownerId: opts.ownerId ?? 'anon', createdAt: now };
}

/** Validates a transfer request body and returns it in normalized form. */
export function parseTransferInput(body: unknown): TransferInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const fromAccountId = validateId(b.fromAccountId, 'fromAccountId');
  const toAccountId = validateId(b.toAccountId, 'toAccountId');
  if (fromAccountId === toAccountId) {
    throw new LedgerError('VALIDATION', 'fromAccountId and toAccountId must differ');
  }
  try {
    assertPositiveCents(b.amountCents);
  } catch (e) {
    throw new LedgerError('VALIDATION', (e as Error).message);
  }
  const memo = validateMemo(b.memo);
  return { fromAccountId, toAccountId, amountCents: b.amountCents, ...(memo ? { memo } : {}) };
}

export function buildTransfer(
  input: TransferInput,
  from: Account,
  to: Account,
  ids: { id: string; idempotencyKey: string; now: string },
): Transaction {
  if (from.currency !== to.currency) {
    throw new LedgerError('CURRENCY_MISMATCH', `cannot transfer ${from.currency} to a ${to.currency} account`);
  }
  const txn: Transaction = {
    id: ids.id,
    kind: 'transfer',
    currency: from.currency,
    entries: [
      { accountId: from.id, amountCents: negateCents(input.amountCents) },
      { accountId: to.id, amountCents: input.amountCents },
    ],
    createdAt: ids.now,
    idempotencyKey: ids.idempotencyKey,
    ...(input.memo ? { memo: input.memo } : {}),
  };
  assertBalanced(txn);
  return txn;
}

/** A reversal posts the exact opposite entries of the original transaction. */
export function buildReversal(
  original: Transaction,
  ids: { id: string; idempotencyKey: string; now: string },
): Transaction {
  if (original.kind === 'reversal') {
    throw new LedgerError('VALIDATION', 'a reversal cannot itself be reversed');
  }
  const txn: Transaction = {
    id: ids.id,
    kind: 'reversal',
    currency: original.currency,
    entries: original.entries.map((e) => ({ accountId: e.accountId, amountCents: negateCents(e.amountCents) })),
    memo: `Reversal of ${original.id}`,
    createdAt: ids.now,
    idempotencyKey: ids.idempotencyKey,
    reversesTransactionId: original.id,
  };
  assertBalanced(txn);
  return txn;
}

/** The core double-entry invariant: every transaction's entries sum to exactly zero. */
export function assertBalanced(txn: Pick<Transaction, 'entries'>): void {
  if (txn.entries.length < 2) throw new LedgerError('VALIDATION', 'a transaction needs at least two entries');
  if (sumCents(txn.entries.map((e) => e.amountCents)) !== 0) {
    throw new LedgerError('VALIDATION', 'transaction entries must sum to zero');
  }
}

/**
 * Applies a transaction to a set of accounts and returns the new balances.
 * Pure: throws instead of producing an invalid state.
 */
export function applyTransaction(
  accounts: ReadonlyMap<string, Account>,
  txn: Transaction,
): Map<string, Cents> {
  assertBalanced(txn);
  const next = new Map<string, Cents>();
  for (const entry of txn.entries) {
    const account = accounts.get(entry.accountId);
    if (!account) throw new LedgerError('NOT_FOUND', `account ${entry.accountId} not found`);
    if (account.currency !== txn.currency) {
      throw new LedgerError('CURRENCY_MISMATCH', `account ${account.id} is ${account.currency}`);
    }
    const current = next.get(account.id) ?? account.balanceCents;
    let updated: Cents;
    try {
      updated = sumCents([current, entry.amountCents]);
    } catch {
      throw new LedgerError('VALIDATION', `account ${account.id} would exceed the maximum balance`);
    }
    if (updated < 0 && !account.allowNegative) {
      throw new LedgerError('INSUFFICIENT_FUNDS', `account ${account.id} has insufficient funds`);
    }
    if (Math.abs(updated) > MAX_BALANCE_CENTS) {
      throw new LedgerError('VALIDATION', `account ${account.id} would exceed the maximum balance of ${MAX_BALANCE_CENTS}`);
    }
    next.set(account.id, updated);
  }
  return next;
}

/** Statement rows for a transaction, one per leg. */
export function toAccountEntries(txn: Transaction): AccountEntry[] {
  return txn.entries.map((entry, i) => ({
    transactionId: txn.id,
    accountId: entry.accountId,
    counterpartyAccountId: txn.entries[(i + 1) % txn.entries.length]!.accountId,
    kind: txn.kind,
    amountCents: entry.amountCents,
    currency: txn.currency,
    createdAt: txn.createdAt,
    ...(txn.memo ? { memo: txn.memo } : {}),
    ...(txn.reversesTransactionId ? { reversesTransactionId: txn.reversesTransactionId } : {}),
  }));
}

/** Stable fingerprint of a request, so an idempotency key cannot be reused for a different request. */
export function fingerprint(operation: string, payload: unknown): string {
  return createHash('sha256').update(`${operation}:${stableStringify(payload)}`).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}
