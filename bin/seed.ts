#!/usr/bin/env node
/**
 * Creates a funding/clearing account (allowNegative) directly in the table.
 *
 * This is deliberately NOT an API route: only an operator with IAM write access to the table
 * (their own short-lived credentials) can create accounts that are allowed to go negative.
 *
 *   npx tsx bin/seed.ts --table <TableName output> --name "Incoming wires" [--currency USD] [--owner sub:<user-id>]
 *
 * `--owner` is the principal allowed to move money out of it: `sub:<JWT sub>` with the authorizer
 * on, or `anon` (default) for a local/unauthenticated demo.
 */
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LedgerService } from '../src/domain/service.js';
import { DynamoDbLedgerRepository } from '../src/store/dynamodb-repository.js';

const { values } = parseArgs({
  options: {
    table: { type: 'string' },
    name: { type: 'string' },
    currency: { type: 'string', default: 'USD' },
    endpoint: { type: 'string' },
    owner: { type: 'string', default: 'anon' },
  },
});

if (!values.table || !values.name) {
  console.error('usage: npx tsx bin/seed.ts --table <TableName> --name <account name> [--currency USD] [--owner sub:<id>|anon] [--endpoint http://localhost:8000]');
  process.exit(2);
}

const client = new DynamoDBClient(values.endpoint ? { endpoint: values.endpoint } : {});
const service = new LedgerService({ repo: new DynamoDbLedgerRepository(client, values.table) });
const account = await service.createFundingAccount({ name: values.name, currency: values.currency }, values.owner);
console.error(JSON.stringify(account));
