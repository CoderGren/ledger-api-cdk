#!/usr/bin/env node
import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { LedgerStack, type LedgerAuth } from '../lib/ledger-stack.js';

const app = new App();

const corsOrigins = String(app.node.tryGetContext('corsOrigins') ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const budgetEmail = app.node.tryGetContext('budgetEmail') as string | undefined;
const monthlyBudgetUsd = Number(app.node.tryGetContext('monthlyBudgetUsd') ?? 10);

// Auth is required. Pass a JWT issuer (Cognito: https://cognito-idp.<region>.amazonaws.com/<pool-id>)
// and audience (app client id), or explicitly opt out for a private demo that must not be public.
const jwtIssuer = app.node.tryGetContext('jwtIssuer') as string | undefined;
const jwtAudience = String(app.node.tryGetContext('jwtAudience') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const allowUnauthenticated = String(app.node.tryGetContext('allowUnauthenticated')) === 'true';

let auth: LedgerAuth;
if (jwtIssuer) {
  if (jwtAudience.length === 0) throw new Error('jwtAudience context is required with jwtIssuer');
  auth = { jwt: { issuer: jwtIssuer, audience: jwtAudience } };
} else if (allowUnauthenticated) {
  auth = { unauthenticated: true };
} else {
  throw new Error(
    'Refusing to synthesize an unauthenticated ledger API. Pass -c jwtIssuer=<issuer URL> -c jwtAudience=<audience>, ' +
      'or -c allowUnauthenticated=true for a private demo that will not be exposed publicly.',
  );
}

new LedgerStack(app, 'LedgerApi', {
  // Account and region come from the deploying credentials (GitHub OIDC role in CI).
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  corsOrigins,
  auth,
  ...(budgetEmail ? { budget: { monthlyLimitUsd: monthlyBudgetUsd, notificationEmail: budgetEmail } } : {}),
});

Tags.of(app).add('project', 'ledger-api');
// cdk-nag v3 runs as a CDK policy-validation plugin: unacknowledged findings fail `cdk synth`.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
