import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LedgerService } from '../src/domain/service.js';
import { DynamoDbLedgerRepository } from '../src/store/dynamodb-repository.js';

export const endpoint = process.env.DYNAMODB_ENDPOINT;

/** DynamoDB Local ignores credentials; these are fixed placeholders, not real keys. */
export const client = endpoint
  ? new DynamoDBClient({ endpoint, region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } })
  : (undefined as unknown as DynamoDBClient);

/** A fresh table per test, with the same key schema as the CDK stack. */
export async function freshLedger() {
  const tableName = `ledger-it-${randomUUID()}`;
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    }),
  );
  const repo = new DynamoDbLedgerRepository(client, tableName);
  const service = new LedgerService({ repo });
  return { repo, service, tableName };
}

let n = 0;
export const key = () => `it-${process.pid}-${++n}-${Math.random().toString(36).slice(2, 8)}`;
