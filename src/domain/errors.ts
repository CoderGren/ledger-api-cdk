export type LedgerErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'CURRENCY_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ALREADY_REVERSED'
  | 'CONCURRENT_UPDATE'
  | 'UNAUTHENTICATED';

const STATUS: Record<LedgerErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  INSUFFICIENT_FUNDS: 422,
  CURRENCY_MISMATCH: 422,
  IDEMPOTENCY_CONFLICT: 409,
  ALREADY_REVERSED: 409,
  CONCURRENT_UPDATE: 409,
  UNAUTHENTICATED: 401,
};

export class LedgerError extends Error {
  readonly status: number;
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
    this.status = STATUS[code];
  }
}
