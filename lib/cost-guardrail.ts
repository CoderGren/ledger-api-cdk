import { aws_budgets as budgets } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface CostGuardrailProps {
  /** Monthly spend, in whole US dollars, that triggers notifications. */
  readonly monthlyLimitUsd: number;
  /** Address that receives budget alerts. Use a team distribution list, not a person. */
  readonly notificationEmail: string;
}

/**
 * AWS Budgets alarm: email at 80% of actual spend and when forecast spend crosses 100%.
 * Budgets are account-wide and free for the first two per account.
 */
export class CostGuardrail extends Construct {
  readonly budget: budgets.CfnBudget;

  constructor(scope: Construct, id: string, props: CostGuardrailProps) {
    super(scope, id);
    if (!Number.isInteger(props.monthlyLimitUsd) || props.monthlyLimitUsd <= 0) {
      throw new Error('monthlyLimitUsd must be a positive whole number of dollars');
    }
    const subscribers = [{ subscriptionType: 'EMAIL', address: props.notificationEmail }];
    this.budget = new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyLimitUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
          subscribers,
        },
        {
          notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
          subscribers,
        },
      ],
    });
  }
}
