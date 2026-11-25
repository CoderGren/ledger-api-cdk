/**
 * Lambda entry points. Each API route is its own function (and IAM role), so read-only
 * routes never hold write permissions. The DynamoDB client is created once per container.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LedgerService } from '../domain/service.js';
import { DynamoDbLedgerRepository } from '../store/dynamodb-repository.js';
import { createRoutes } from './routes.js';
import { parseAuthMode, type HttpEvent } from './http.js';

const tableName = process.env.TABLE_NAME;
if (!tableName) throw new Error('TABLE_NAME is not set');

// Fails at cold start if AUTH_MODE is missing or unknown.
const authMode = parseAuthMode(process.env.AUTH_MODE);

const routes = createRoutes(new LedgerService({ repo: new DynamoDbLedgerRepository(new DynamoDBClient({}), tableName) }), { authMode });

export const createAccount = (e: HttpEvent) => routes.createAccount(e);
export const getBalance = (e: HttpEvent) => routes.getBalance(e);
export const listTransactions = (e: HttpEvent) => routes.listTransactions(e);
export const postTransfer = (e: HttpEvent) => routes.postTransfer(e);
export const reverseTransaction = (e: HttpEvent) => routes.reverseTransaction(e);
