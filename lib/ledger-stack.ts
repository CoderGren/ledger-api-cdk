import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  Validations,
  aws_apigateway as apigwv1,
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_authorizers as authorizers,
  aws_apigatewayv2_integrations as integrations,
  aws_cloudwatch as cloudwatch,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { CostGuardrail } from './cost-guardrail.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HANDLER_ENTRY = path.join(here, '..', 'src', 'handlers', 'lambda.ts');

/**
 * How callers authenticate. There is deliberately no default: a deployable stack must either
 * name a JWT issuer (Cognito user pool or any OIDC issuer) or opt out explicitly for a private demo.
 */
export type LedgerAuth =
  | { jwt: { issuer: string; audience: string[] } }
  /** Unauthenticated demo. Never deploy this publicly: anyone could create accounts and post transfers. */
  | { unauthenticated: true };

export interface LedgerStackProps extends StackProps {
  readonly auth: LedgerAuth;
  /** Browser origins allowed by CORS (the demo dashboard). */
  readonly corsOrigins: string[];
  /** Steady-state requests per second across the API. */
  readonly throttleRateLimit?: number;
  readonly throttleBurstLimit?: number;
  /** Optional AWS Budgets guardrail. */
  readonly budget?: { monthlyLimitUsd: number; notificationEmail: string };
}

type DynamoAction = 'GetItem' | 'PutItem' | 'UpdateItem' | 'Query';
/** Partition-key prefixes of the single-table design (see src/store/dynamodb-repository.ts). */
type KeyPrefix = 'ACCOUNT#' | 'TXN#' | 'STMT#' | 'IDEMPOTENCY#';

interface Grant {
  actions: DynamoAction[];
  /** Enforced with dynamodb:LeadingKeys, so e.g. UpdateItem can only ever touch ACCOUNT# items. */
  prefixes: KeyPrefix[];
}

interface RouteSpec {
  id: string;
  handler: string;
  method: apigw.HttpMethod;
  path: string;
  /** Exactly the DynamoDB actions this route needs, on exactly the item types it touches. */
  grants: Grant[];
}

const POSTING_GRANTS: Grant[] = [
  { actions: ['GetItem'], prefixes: ['ACCOUNT#', 'IDEMPOTENCY#'] },
  { actions: ['Query'], prefixes: ['TXN#'] },
  { actions: ['PutItem'], prefixes: ['IDEMPOTENCY#', 'TXN#', 'STMT#'] },
  { actions: ['UpdateItem'], prefixes: ['ACCOUNT#'] },
];

export const ROUTES: RouteSpec[] = [
  {
    id: 'CreateAccount',
    handler: 'createAccount',
    method: apigw.HttpMethod.POST,
    path: '/accounts',
    grants: [{ actions: ['GetItem', 'PutItem'], prefixes: ['ACCOUNT#', 'IDEMPOTENCY#'] }],
  },
  {
    id: 'GetBalance',
    handler: 'getBalance',
    method: apigw.HttpMethod.GET,
    path: '/accounts/{accountId}/balance',
    grants: [{ actions: ['GetItem'], prefixes: ['ACCOUNT#'] }],
  },
  {
    id: 'ListTransactions',
    handler: 'listTransactions',
    method: apigw.HttpMethod.GET,
    path: '/accounts/{accountId}/transactions',
    grants: [
      { actions: ['GetItem'], prefixes: ['ACCOUNT#'] },
      { actions: ['Query'], prefixes: ['STMT#'] },
    ],
  },
  { id: 'PostTransfer', handler: 'postTransfer', method: apigw.HttpMethod.POST, path: '/transfers', grants: POSTING_GRANTS },
  {
    id: 'ReverseTransaction',
    handler: 'reverseTransaction',
    method: apigw.HttpMethod.POST,
    path: '/transactions/{transactionId}/reversal',
    grants: POSTING_GRANTS,
  },
];

export class LedgerStack extends Stack {
  readonly table: dynamodb.Table;
  readonly api: apigw.HttpApi;
  readonly functions: Record<string, nodejs.NodejsFunction> = {};

  constructor(scope: Construct, id: string, props: LedgerStackProps) {
    super(scope, id, props);

    // Single table: accounts, transactions, statement entries and idempotency records.
    this.table = new dynamodb.Table(this, 'LedgerTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const defaultAuthorizer =
      'jwt' in props.auth
        ? new authorizers.HttpJwtAuthorizer('JwtAuthorizer', props.auth.jwt.issuer, { jwtAudience: props.auth.jwt.audience })
        : undefined;

    this.api = new apigw.HttpApi(this, 'LedgerApi', {
      description: 'Double-entry ledger API',
      // Every route requires a valid JWT; CORS preflight is answered by API Gateway before auth.
      ...(defaultAuthorizer ? { defaultAuthorizer } : {}),
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: props.corsOrigins,
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.OPTIONS],
        // `authorization` carries the bearer token for the JWT authorizer.
        allowHeaders: ['authorization', 'content-type', 'idempotency-key'],
        exposeHeaders: ['idempotent-replayed', 'location'],
        maxAge: Duration.hours(1),
      },
    });

    const stage = this.api.addStage('DefaultStage', {
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: props.throttleRateLimit ?? 20, burstLimit: props.throttleBurstLimit ?? 40 },
      accessLogSettings: {
        destination: new apigw.LogGroupLogDestination(accessLogs),
        format: apigwv1.AccessLogFormat.custom(
          JSON.stringify({
            requestId: apigwv1.AccessLogField.contextRequestId(),
            routeKey: apigwv1.AccessLogField.contextRouteKey(),
            status: apigwv1.AccessLogField.contextStatus(),
            latencyMs: apigwv1.AccessLogField.contextIntegrationLatency(),
            sourceIp: apigwv1.AccessLogField.contextIdentitySourceIp(),
          }),
        ),
      },
    });

    for (const spec of ROUTES) {
      const fn = this.createRouteFunction(spec, 'jwt' in props.auth ? 'jwt' : 'none');
      this.functions[spec.handler] = fn;
      this.api.addRoutes({
        path: spec.path,
        methods: [spec.method],
        integration: new integrations.HttpLambdaIntegration(`${spec.id}Integration`, fn),
      });
    }

    // State-only alarm: no action is attached, so it notifies no one (see README, design notes).
    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      alarmDescription: 'Ledger API is returning 5xx responses',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5xx',
        dimensionsMap: { ApiId: this.api.apiId, Stage: '$default' },
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    if (props.budget) new CostGuardrail(this, 'CostGuardrail', props.budget);

    new CfnOutput(this, 'ApiUrl', { value: stage.url });
    new CfnOutput(this, 'TableName', { value: this.table.tableName });

    if ('unauthenticated' in props.auth) {
      Validations.of(this.api).acknowledge({
        id: 'AwsSolutions-APIG4',
        reason:
          'Explicit opt-in (-c allowUnauthenticated=true) for a private local/sandbox demo only. Throttling limits cost, not abuse; ' +
          'this mode must not be deployed publicly. The default build requires a JWT authorizer. (WAF cannot be attached to HTTP APIs.)',
      });
    }
  }

  private createRouteFunction(spec: RouteSpec, authMode: 'jwt' | 'none'): nodejs.NodejsFunction {
    const logGroup = new logs.LogGroup(this, `${spec.id}Logs`, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Hand-written role instead of AWSLambdaBasicExecutionRole: logs only to its own group,
    // and only the DynamoDB actions this route uses, on this table, on the key prefixes it needs.
    const role = new iam.Role(this, `${spec.id}Role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Least-privilege role for the ${spec.handler} route`,
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${logGroup.logGroupArn}`],
      }),
    );
    for (const grant of spec.grants) {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: grant.actions.map((a) => `dynamodb:${a}`),
          resources: [this.table.tableArn],
          conditions: {
            'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': grant.prefixes.map((p) => `${p}*`) },
          },
        }),
      );
    }

    const fn = new nodejs.NodejsFunction(this, `${spec.id}Function`, {
      entry: HANDLER_ENTRY,
      handler: spec.handler,
      // Node.js 20 was deprecated in Lambda on 2026-04-30; 24.x is the current LTS runtime.
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      role,
      logGroup,
      environment: {
        TABLE_NAME: this.table.tableName,
        // Handlers reject tokens without `sub` in jwt mode; `none` only in the explicit demo mode.
        AUTH_MODE: authMode,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node24',
        // AWS SDK v3 ships in the Node.js Lambda runtime; keep bundles small.
        externalModules: ['@aws-sdk/*'],
      },
    });

    Validations.of(fn).acknowledge({
      id: 'AwsSolutions-L1',
      reason:
        'Pinned to nodejs24.x (Active LTS) to match the CI and local toolchain; moving to a newer runtime is a deliberate, tested change.',
    });
    return fn;
  }
}
