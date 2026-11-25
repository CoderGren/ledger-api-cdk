import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { App, Stack, Validations, aws_dynamodb as dynamodb } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { beforeAll, describe, expect, it } from 'vitest';
import { LedgerStack } from '../lib/ledger-stack.js';

// Skip esbuild bundling in unit tests; `cdk synth` in CI exercises the real bundle.
const makeApp = () => new App({ context: { 'aws:cdk:bundling-stacks': [] } });
const props = {
  corsOrigins: ['http://localhost:5173'],
  auth: { jwt: { issuer: 'https://issuer.example.com/', audience: ['ledger-api'] } },
  budget: { monthlyLimitUsd: 10, notificationEmail: 'glen@gmbxdigital.com' },
};

let template: Template;
beforeAll(() => {
  template = Template.fromStack(new LedgerStack(makeApp(), 'Test', props));
});

type PolicyDoc = { Statement: Array<{ Action: string | string[]; Resource: unknown }> };
const policies = () => Object.values(template.findResources('AWS::IAM::Policy')) as Array<{ Properties: { PolicyDocument: PolicyDoc } }>;
const actionsOf = (doc: PolicyDoc) => doc.Statement.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));

describe('LedgerStack', () => {
  it('DynamoDB table: on-demand, KMS encrypted, PITR, TTL, deletion protection, retained', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        BillingMode: 'PAY_PER_REQUEST',
        SSESpecification: { SSEEnabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        DeletionProtectionEnabled: true,
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
      },
    });
  });

  it('five Lambda functions on a current Node.js runtime, ARM64, with bounded timeouts', () => {
    template.resourceCountIs('AWS::Lambda::Function', 5);
    template.allResourcesProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Timeout: 10,
      Environment: { Variables: { TABLE_NAME: Match.anyValue() } },
    });
  });

  it('every log group has a retention period', () => {
    const groups = Object.values(template.findResources('AWS::Logs::LogGroup'));
    expect(groups).toHaveLength(6); // 5 functions + API access logs
    for (const g of groups) expect((g as { Properties: { RetentionInDays: number } }).Properties.RetentionInDays).toBe(30);
  });

  it('IAM is least-privilege: no wildcards, no deletes, no managed policies', () => {
    template.allResourcesProperties('AWS::IAM::Role', { ManagedPolicyArns: Match.absent() });
    const all = policies().flatMap((p) => actionsOf(p.Properties.PolicyDocument));
    expect(all.length).toBeGreaterThan(0);
    for (const action of all) {
      expect(action).not.toMatch(/\*/);
      expect(action).not.toMatch(/Delete|Scan|BatchWrite/);
    }
    for (const p of policies()) {
      for (const s of p.Properties.PolicyDocument.Statement) expect(s.Resource).not.toBe('*');
    }
  });

  it('read-only routes cannot write', () => {
    const roleFor = (fn: string) =>
      policies().find((p) => JSON.stringify(p).includes(`${fn}Role`))!.Properties.PolicyDocument;
    expect(actionsOf(roleFor('GetBalance')).filter((a) => a.startsWith('dynamodb:'))).toEqual(['dynamodb:GetItem']);
    expect(actionsOf(roleFor('ListTransactions')).filter((a) => a.startsWith('dynamodb:')).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
    expect(actionsOf(roleFor('CreateAccount')).filter((a) => a.startsWith('dynamodb:'))).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem']);
  });

  it('every DynamoDB statement is pinned to key prefixes with dynamodb:LeadingKeys', () => {
    type Stmt = { Action: string | string[]; Condition?: Record<string, Record<string, string[]>> };
    const roleFor = (fn: string) =>
      policies().find((p) => JSON.stringify(p).includes(`${fn}Role`))!.Properties.PolicyDocument.Statement as Stmt[];
    const grants = (fn: string) =>
      roleFor(fn)
        .filter((s) => [s.Action].flat().some((a) => a.startsWith('dynamodb:')))
        .map((s) => ({ actions: [s.Action].flat().sort(), prefixes: s.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'] }));
    for (const fn of ['CreateAccount', 'GetBalance', 'ListTransactions', 'PostTransfer', 'ReverseTransaction']) {
      for (const g of grants(fn)) expect(g.prefixes?.length, fn).toBeGreaterThan(0);
    }
    // Writers can only UpdateItem balances (ACCOUNT#) and can never overwrite an account with PutItem.
    for (const fn of ['PostTransfer', 'ReverseTransaction']) {
      expect(grants(fn)).toContainEqual({ actions: ['dynamodb:UpdateItem'], prefixes: ['ACCOUNT#*'] });
      expect(grants(fn)).toContainEqual({ actions: ['dynamodb:PutItem'], prefixes: ['IDEMPOTENCY#*', 'TXN#*', 'STMT#*'] });
    }
    expect(grants('GetBalance')).toEqual([{ actions: ['dynamodb:GetItem'], prefixes: ['ACCOUNT#*'] }]);
    expect(grants('ListTransactions')).toContainEqual({ actions: ['dynamodb:Query'], prefixes: ['STMT#*'] });
  });

  it('HTTP API stage is throttled and access-logged', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      AccessLogSettings: { DestinationArn: Match.anyValue(), Format: Match.stringLikeRegexp('requestId') },
    });
  });

  it('exposes the five ledger routes with a CORS allow-list (no wildcard origin)', () => {
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map(
      (r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey,
    );
    expect(routes.sort()).toEqual([
      'GET /accounts/{accountId}/balance',
      'GET /accounts/{accountId}/transactions',
      'POST /accounts',
      'POST /transactions/{transactionId}/reversal',
      'POST /transfers',
    ]);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: { AllowOrigins: ['http://localhost:5173'], AllowHeaders: Match.arrayWith(['idempotency-key']) },
    });
  });

  it('has a 5xx alarm and a monthly cost budget with email alerts', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: '5xx', Namespace: 'AWS/ApiGateway' });
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: 10, Unit: 'USD' } },
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: 'FORECASTED', Threshold: 100 }) }),
      ]),
    });
  });

  it('L-M3: every route requires the JWT authorizer by default', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      JwtConfiguration: { Issuer: 'https://issuer.example.com/', Audience: ['ledger-api'] },
      IdentitySource: ['$request.header.Authorization'],
    });
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route')) as Array<{ Properties: { AuthorizationType?: string } }>;
    expect(routes).toHaveLength(5);
    for (const r of routes) expect(r.Properties.AuthorizationType).toBe('JWT');
  });

  it('L-M3: the unauthenticated demo is an explicit opt-in, and still nag-clean only via a documented acknowledgement', () => {
    const app = makeApp();
    const t = Template.fromStack(new LedgerStack(app, 'Demo', { ...props, auth: { unauthenticated: true } }));
    t.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 0);
    const app2 = makeApp();
    new LedgerStack(app2, 'DemoNag', { ...props, auth: { unauthenticated: true } });
    Validations.of(app2).addPlugins(new AwsSolutionsChecks(app2));
    expect(nagReport(app2).find((r) => r.pluginName === 'AwsSolutions')?.violations ?? []).toEqual([]);
  });

  it('L-M3: bin/app.ts refuses to synthesize without auth unless explicitly opted out', () => {
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'bin/app.ts'], {
        env: { ...process.env, CDK_CONTEXT_JSON: JSON.stringify(Object.fromEntries(args.map((a) => a.split('=')))), CDK_OUTDIR: mkdtempSync(`${tmpdir()}/cdk-`) },
        encoding: 'utf8',
      });
    const none = run([]);
    expect(none.status).not.toBe(0);
    expect(none.stderr).toMatch(/Refusing to synthesize an unauthenticated ledger API/);
  });

  it('omits the budget when no notification email is configured', () => {
    const t = Template.fromStack(new LedgerStack(makeApp(), 'NoBudget', { ...props, budget: undefined }));
    t.resourceCountIs('AWS::Budgets::Budget', 0);
  });

  it('passes the cdk-nag AwsSolutions pack (only documented acknowledgements)', () => {
    const app = makeApp();
    new LedgerStack(app, 'Nag', props);
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    expect(nagReport(app).find((r) => r.pluginName === 'AwsSolutions')?.violations ?? []).toEqual([]);
  });

  it('cdk-nag is actually enforcing (control: a table without PITR is flagged)', () => {
    const app = makeApp();
    const bad = new Stack(app, 'Bad');
    new dynamodb.Table(bad, 'NoPitr', { partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING } });
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    const rules = (nagReport(app).find((r) => r.pluginName === 'AwsSolutions')?.violations ?? []).map((v) => v.ruleName);
    expect(rules).toContain('AwsSolutions-DDB3');
  });
});

function nagReport(app: App) {
  let dir: string;
  try {
    dir = app.synth().directory;
  } catch {
    dir = app.outdir;
  }
  const report = JSON.parse(readFileSync(`${dir}/validation-report.json`, 'utf8')) as {
    pluginReports: Array<{ pluginName: string; conclusion: string; violations: Array<{ ruleName: string }> }>;
  };
  return report.pluginReports;
}
