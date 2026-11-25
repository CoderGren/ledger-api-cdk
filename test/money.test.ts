import { describe, expect, it } from 'vitest';
import { MAX_TRANSFER_CENTS, addCents, assertCents, assertPositiveCents, centsToDecimalString, MoneyError, sumCents } from '../src/domain/money.js';

describe('money', () => {
  it('accepts safe integers and rejects floats, NaN, strings and unsafe integers', () => {
    expect(() => assertCents(1234)).not.toThrow();
    expect(() => assertCents(-5)).not.toThrow();
    for (const bad of [12.5, Number.NaN, Infinity, '100', null, 2 ** 53]) {
      expect(() => assertCents(bad)).toThrow(MoneyError);
    }
  });

  it('requires transfer amounts to be positive', () => {
    expect(() => assertPositiveCents(0)).toThrow(/greater than zero/);
    expect(() => assertPositiveCents(-1)).toThrow(MoneyError);
    expect(() => assertPositiveCents(1)).not.toThrow();
    expect(() => assertPositiveCents(MAX_TRANSFER_CENTS)).not.toThrow();
    expect(() => assertPositiveCents(MAX_TRANSFER_CENTS + 1)).toThrow(/at most/);
  });

  it('detects overflow instead of silently losing precision', () => {
    expect(() => addCents(Number.MAX_SAFE_INTEGER, 1)).toThrow(/overflow/);
    expect(sumCents([10, 20, -5])).toBe(25);
  });

  it('formats cents as an exact decimal string', () => {
    expect(centsToDecimalString(0)).toBe('0.00');
    expect(centsToDecimalString(5)).toBe('0.05');
    expect(centsToDecimalString(-123456)).toBe('-1234.56');
    expect(centsToDecimalString(1500, 0)).toBe('1500');
    // 0.1 + 0.2 style float errors cannot happen in integer cents
    expect(centsToDecimalString(10 + 20)).toBe('0.30');
  });
});
