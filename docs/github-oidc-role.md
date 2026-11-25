# GitHub OIDC deploy role

The deploy workflow never sees long-lived AWS keys. GitHub issues a short-lived OIDC token,
and AWS STS exchanges it for temporary credentials for one IAM role, but only for this
repository's `main` branch running the `deploy.yml` workflow in the `production` environment.

> **Why the YAML guard isn't enough.** `workflow_dispatch` runs the workflow file *from the ref
> you pick*, so anyone with write access could push a branch that deletes the
> `if: github.ref == 'refs/heads/main'` line. The default `sub` claim
> (`repo:<owner>/<repo>:environment:production`) doesn't contain the ref. The real controls are
> the GitHub environment protection rules (step 0) and a `sub` claim that includes the ref and
> the workflow file (step 2).

Replace the `<PLACEHOLDERS>` and create these once per AWS account (for example with a small
bootstrap CDK stack or the console).

## 0. Protect the `production` environment (required)

Settings → Environments → `production`:

- **Deployment branches and tags:** *Selected branches and tags* → `main` only. A run from any
  other branch can't enter the environment, so it never gets an OIDC token with
  `environment:production`.
- **Required reviewers:** at least one person other than the one triggering the deploy, with
  *Prevent self-review* on.
- Protect `main` itself (pull request reviews, required CI checks, no force pushes), since anything
  merged to `main` becomes deployable.

## 1. OIDC identity provider

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

## 2. Trust policy for the deploy role

First make the `sub` claim carry the ref and the workflow file (repository admin, one-time,
GitHub REST API `PUT /repos/<GITHUB_OWNER>/<GITHUB_REPO>/actions/oidc/customization/sub`):

```json
{ "use_default": false, "include_claim_keys": ["repo", "context", "ref", "job_workflow_ref"] }
```

Then trust exactly that subject (check the exact string once in a debug run, since it depends on
the claim order above):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:<GITHUB_OWNER>/<GITHUB_REPO>:environment:production:ref:refs/heads/main:job_workflow_ref:<GITHUB_OWNER>/<GITHUB_REPO>/.github/workflows/deploy.yml@refs/heads/main"
        }
      }
    }
  ]
}
```

Use `StringEquals`, not `StringLike` with wildcards. If you skip the customization, keep the
default `environment:production` subject and rely on step 0; that is weaker but still requires the
environment's branch rule to pass.

## 3. Permissions

Give the role only what CDK needs: permission to assume the CDK bootstrap roles
(`cdk-<qualifier>-deploy-role-*`, `cdk-<qualifier>-file-publishing-role-*`,
`cdk-<qualifier>-lookup-role-*`) in the target account and region. The GitHub role itself holds
no direct DynamoDB, Lambda or IAM permissions.

**Scope the CloudFormation execution role too.** CloudFormation deploys with the role created by
`cdk bootstrap`, which defaults to `AdministratorAccess`. Bootstrap with a scoped policy and a
permissions boundary instead:

```bash
npx cdk bootstrap aws://<AWS_ACCOUNT_ID>/<REGION> \
  --cloudformation-execution-policies arn:aws:iam::<AWS_ACCOUNT_ID>:policy/<LEDGER_DEPLOY_POLICY> \
  --custom-permissions-boundary <LEDGER_PERMISSIONS_BOUNDARY>
```

`<LEDGER_DEPLOY_POLICY>` needs the services this stack creates (DynamoDB, Lambda, API Gateway,
CloudWatch Logs and alarms, Budgets, and IAM role/policy management limited to roles under the
boundary). The permissions boundary stops a modified stack from minting a more powerful role than
the boundary allows.

## 4. Repository variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Example |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<AWS_ACCOUNT_ID>:role/<ROLE_NAME>` |
| `AWS_REGION` | `us-east-1` |
| `CORS_ORIGINS` | `https://<DEMO_HOST>` |
| `BUDGET_EMAIL` | `<TEAM_ALERTS_ADDRESS>` (optional) |
| `JWT_ISSUER` | `https://cognito-idp.<REGION>.amazonaws.com/<USER_POOL_ID>` (required) |
| `JWT_AUDIENCE` | `<APP_CLIENT_ID>` (required; comma-separated for several) |

These are variables, not secrets: a role ARN is not a credential, and nothing in this
repository can be used to authenticate to AWS.
