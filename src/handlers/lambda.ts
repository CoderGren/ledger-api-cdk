/**
 * Lambda entry points. Each API route is its own function (and IAM role), so read-only
 * routes never hold write permissions. The DynamoDB client is created once per container.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LedgerService } from '../domain/service.js';
import { DynamoDbLedgerRepository } from '../store/dynamodb-repository.js';
import { createRoutes } from './routes.js';
import type { HttpEvent } from './http.js';

const tableName = process.env.TABLE_NAME;
if (!tableName) throw new Error('TABLE_NAME is not set');

const routes = createRoutes(new LedgerService({ repo: new DynamoDbLedgerRepository(new DynamoDBClient({}), tableName) }));

export const createAccount = (e: HttpEvent) => routes.createAccount(e);
export const getBalance = (e: HttpEvent) => routes.getBalance(e);
export const listTransactions = (e: HttpEvent) => routes.listTransactions(e);
export const postTransfer = (e: HttpEvent) => routes.postTransfer(e);
export const reverseTransaction = (e: HttpEvent) => routes.reverseTransaction(e);
