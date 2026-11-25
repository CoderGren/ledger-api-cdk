#!/usr/bin/env node
/**
 * Creates a funding/clearing account (allowNegative) directly in the table.
 *
 * This is deliberately NOT an API route: only an operator with IAM write access to the table
 * (their own short-lived credentials) can create accounts that are allowed to go negative.
 *
 *   npx tsx bin/seed.ts --table <TableName output> --name "Incoming wires" --owner sub:<jwt-sub> [--currency USD]
 *
 * `--owner` is required (see bin/seed-args.ts): it is the only principal that can move money
 * out of the account. `anon` needs --allow-anon-owner and is for a local unauthenticated demo.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LedgerService } from '../src/domain/service.js';
import { DynamoDbLedgerRepository } from '../src/store/dynamodb-repository.js';
import { parseSeedArgs, SEED_USAGE, SeedArgsError } from './seed-args.js';

let args;
try {
  args = parseSeedArgs(process.argv.slice(2), process.env);
} catch (err) {
  console.error(`${err instanceof SeedArgsError ? err.message : String(err)}\n${SEED_USAGE}`);
  process.exit(2);
}

const client = new DynamoDBClient(args.endpoint ? { endpoint: args.endpoint } : {});
const service = new LedgerService({ repo: new DynamoDbLedgerRepository(client, args.table) });
const account = await service.createFundingAccount({ name: args.name, currency: args.currency }, args.owner);
console.error(JSON.stringify(account));
