/**
 * Money is represented as an integer number of minor units (cents).
 * Floats never enter the ledger: every amount is validated as a safe integer,
 * and arithmetic that could overflow Number.MAX_SAFE_INTEGER is rejected.
 */
export type Cents = number & { readonly __brand?: 'Cents' };

export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'JPY'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Largest single transfer: 10,000,000,000 minor units ($100,000,000.00 for USD).
 * Bounding inputs keeps every intermediate value far from 2^53.
 */
export const MAX_TRANSFER_CENTS = 10_000_000_000;

/**
 * Largest absolute balance any account may hold: 10^15 minor units ($10 trillion for USD).
 * Enforced in the domain and in the DynamoDB update conditions, so a stored balance can never
 * pass Number.MAX_SAFE_INTEGER (~9.007 * 10^15) and come back from DynamoDB as a BigInt.
 */
export const MAX_BALANCE_CENTS = 1_000_000_000_000_000;

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

/** Asserts that a value is a safe integer number of cents. */
export function assertCents(value: unknown, field = 'amountCents'): asserts value is Cents {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MoneyError(`${field} must be a safe integer number of minor units (cents)`);
  }
}

/** Asserts a strictly positive amount, as required for transfers. */
export function assertPositiveCents(value: unknown, field = 'amountCents'): asserts value is Cents {
  assertCents(value, field);
  if (value <= 0) throw new MoneyError(`${field} must be greater than zero`);
  if (value > MAX_TRANSFER_CENTS) throw new MoneyError(`${field} must be at most ${MAX_TRANSFER_CENTS}`);
}

/** Overflow-checked addition. */
export function addCents(a: Cents, b: Cents): Cents {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new MoneyError('amount overflow');
  return sum;
}

export function negateCents(a: Cents): Cents {
  return a === 0 ? 0 : -a;
}

/** Sums a list of amounts with overflow checks. */
export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce<Cents>((acc, v) => addCents(acc, v), 0);
}

/** Formats cents as a decimal string without floating point (e.g. -1234 -> "-12.34"). */
export function centsToDecimalString(cents: Cents, fractionDigits = 2): string {
  assertCents(cents, 'cents');
  const negative = cents < 0;
  const digits = String(Math.abs(cents)).padStart(fractionDigits + 1, '0');
  const major = fractionDigits === 0 ? digits : digits.slice(0, -fractionDigits);
  const minor = fractionDigits === 0 ? '' : `.${digits.slice(-fractionDigits)}`;
  return `${negative ? '-' : ''}${major}${minor}`;
}
