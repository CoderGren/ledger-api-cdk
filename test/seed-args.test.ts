import { describe, expect, it } from 'vitest';
import { parseSeedArgs } from '../bin/seed-args.js';

const base = ['--table', 'T', '--name', 'Incoming wires'];

describe('L-N1: seed.ts never defaults the funding-account owner', () => {
  it('requires an owner', () => {
    expect(() => parseSeedArgs(base)).toThrow(/--owner .* is required/);
  });

  it('refuses anon unless --allow-anon-owner is passed', () => {
    expect(() => parseSeedArgs([...base, '--owner', 'anon'])).toThrow(/allow-anon-owner/);
    expect(() => parseSeedArgs(base, { LEDGER_SEED_OWNER: 'anon' })).toThrow(/allow-anon-owner/);
    expect(parseSeedArgs([...base, '--owner', 'anon', '--allow-anon-owner']).owner).toBe('anon');
  });

  it('accepts sub:<id> from the flag or LEDGER_SEED_OWNER, flag first', () => {
    expect(parseSeedArgs([...base, '--owner', 'sub:ops-1']).owner).toBe('sub:ops-1');
    expect(parseSeedArgs(base, { LEDGER_SEED_OWNER: 'sub:ops-2' }).owner).toBe('sub:ops-2');
    expect(parseSeedArgs([...base, '--owner', 'sub:ops-1'], { LEDGER_SEED_OWNER: 'sub:ops-2' }).owner).toBe('sub:ops-1');
  });

  it('rejects owners that no caller could ever match', () => {
    for (const bad of ['alice', 'sub:', ' ']) expect(() => parseSeedArgs([...base, '--owner', bad])).toThrow();
  });
});
