/**
 * Argument parsing for bin/seed.ts, kept separate so it can be unit-tested without AWS.
 *
 * The owner of a funding account is the only principal that can move money out of it, so it is
 * never defaulted: pass `--owner sub:<JWT sub>` (or set LEDGER_SEED_OWNER). `anon` (the
 * unauthenticated demo principal) is refused unless `--allow-anon-owner` is also passed.
 */
import { parseArgs } from 'node:util';

export interface SeedArgs {
  table: string;
  name: string;
  currency: string;
  owner: string;
  endpoint?: string;
}

export const SEED_USAGE =
  'usage: npx tsx bin/seed.ts --table <TableName> --name <account name> --owner sub:<jwt-sub> ' +
  '[--currency USD] [--endpoint http://localhost:8000] [--allow-anon-owner (local unauthenticated demo only)]\n' +
  '       --owner may also come from LEDGER_SEED_OWNER';

export class SeedArgsError extends Error {}

export function parseSeedArgs(argv: string[], env: Record<string, string | undefined> = {}): SeedArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      table: { type: 'string' },
      name: { type: 'string' },
      currency: { type: 'string', default: 'USD' },
      endpoint: { type: 'string' },
      owner: { type: 'string' },
      'allow-anon-owner': { type: 'boolean', default: false },
    },
  });
  if (!values.table || !values.name) throw new SeedArgsError('--table and --name are required');
  const owner = (values.owner ?? env.LEDGER_SEED_OWNER ?? '').trim();
  if (owner === '') throw new SeedArgsError('--owner (or LEDGER_SEED_OWNER) is required; there is no default owner');
  if (owner === 'anon') {
    if (!values['allow-anon-owner']) {
      throw new SeedArgsError('refusing to make "anon" the owner without --allow-anon-owner (local unauthenticated demo only)');
    }
  } else if (!/^sub:.+$/.test(owner)) {
    throw new SeedArgsError('--owner must be "sub:<JWT sub>" (or "anon" with --allow-anon-owner)');
  }
  return {
    table: values.table,
    name: values.name,
    currency: values.currency ?? 'USD',
    owner,
    ...(values.endpoint ? { endpoint: values.endpoint } : {}),
  };
}
