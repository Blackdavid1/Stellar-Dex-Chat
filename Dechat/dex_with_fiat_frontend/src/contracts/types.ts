/**
 * Typed Soroban Contract ABI Bindings for Fiat Bridge Contract.
 * Centralizes contract method names, argument types, return types, and error codes.
 */

export const FIAT_BRIDGE_METHODS = {
  INIT: 'init',
  DEPOSIT: 'deposit',
  WITHDRAW: 'withdraw',
  REQUEST_WITHDRAWAL: 'request_withdrawal',
  EXECUTE_WITHDRAWAL: 'execute_withdrawal',
  CANCEL_WITHDRAWAL: 'cancel_withdrawal',
  RECLAIM_EXPIRED_WITHDRAWAL: 'reclaim_expired_withdrawal',
  GET_TOKEN: 'get_token',
  GET_TOTAL_WITHDRAWN: 'get_total_withdrawn',
  GET_TOTAL_LIABILITIES: 'get_total_liabilities',
  GET_ADMIN: 'get_admin',
  GET_LIMIT: 'get_limit',
  GET_TOTAL_DEPOSITED: 'get_total_deposited',
  GET_WQ_DEPTH: 'get_wq_depth',
  GET_WQ_OLDEST_QUEUED_LEDGER: 'get_wq_oldest_queued_ledger',
  GET_WQ_OLDEST_AGE_LEDGERS: 'get_wq_oldest_age_ledgers',
  GET_WITHDRAWAL_REQUEST: 'get_withdrawal_request',
  GET_RECEIPT_BY_INDEX: 'get_receipt_by_index',
  GET_ACCRUED_FEES: 'get_accrued_fees',
  GET_EVENT_VERSION: 'get_event_version',
  IS_CIRCUIT_BREAKER_TRIPPED: 'is_circuit_breaker_tripped',
  IS_DENIED: 'is_denied',
} as const;

export type FiatBridgeMethod =
  (typeof FIAT_BRIDGE_METHODS)[keyof typeof FIAT_BRIDGE_METHODS];

export interface ContractReceipt {
  depositor: string;
  amount: bigint;
  ledger: number;
}

export interface ContractWithdrawRequest {
  id: bigint;
  user: string;
  token: string;
  amount: bigint;
  destination: string;
  queuedAtLedger: number;
}

export enum FiatBridgeErrorCode {
  Overflow = 10,
  NotInitialized = 101,
  AlreadyInitialized = 102,
  InternalError = 103,
  ContractPaused = 104,
  Unauthorized = 201,
  NotAllowed = 202,
  NoPendingAdmin = 203,
  InvalidRecipient = 204,
  NotOperator = 205,
  OperatorCapReached = 206,
  SameAdmin = 207,
  ZeroAmount = 301,
  ExceedsLimit = 302,
  ExceedsLimitMaxCap = 303,
  DailyLimitExceeded = 304,
  ExceedsFiatLimit = 305,
  ReferenceTooLong = 306,
  CooldownActive = 307,
  AntiSandwichDelayActive = 308,
  TokenNotWhitelisted = 309,
  AddressDenied = 310,
  RescueForbidden = 311,
  CircuitBreakerActive = 312,
  InvalidMemoHash = 313,
  FeeWithdrawalExceedsBalance = 314,
  CircuitBreakerTripped = 315,
  LimitCapCannotBeLowered = 319,
  InsufficientFunds = 401,
  NoFeesToWithdraw = 402,
  RequestNotFound = 501,
  WithdrawalLocked = 502,
  OperatorDailyLimitExceeded = 503,
  ActionNotQueued = 601,
  ActionNotReady = 602,
  InactivityThresholdNotReached = 603,
  NoEmergencyRecoveryAddress = 604,
  UpgradeNotReady = 605,
  UpgradeProposalMissing = 606,
  UpgradeDelayTooShort = 607,
  OracleNotSet = 701,
  OraclePriceInvalid = 702,
  SlippageExceeded = 703,
  SlippageTooHigh = 704,
  WithdrawalQuotaExceeded = 801,
  MigrationAlreadyComplete = 802,
  BatchOperationFailed = 803,
  InvalidNonce = 901,
  StaleNonce = 902,
  BelowMinimum = 1001,
  InvalidThreshold = 1101,
  DuplicateSigner = 1102,
  SignerNotFound = 1103,
  ProposalNotFound = 1104,
  AlreadyApproved = 1105,
  ProposalAlreadyExecuted = 1106,
  ThresholdNotMet = 1107,
  MaxSignersReached = 1108,
}

export type ErrorCategory =
  | 'Initialization & State'
  | 'Authorization & Access'
  | 'Constraints & Limits'
  | 'Funds & Balances'
  | 'Withdrawal Queue'
  | 'Governance & Timelock'
  | 'External Services'
  | 'Quota & Migration'
  | 'Replay Protection'
  | 'Deposit Floor'
  | 'Multi-sig'
  | 'Unknown';

export interface TypedContractError {
  code: number;
  name: string;
  category: ErrorCategory;
  message: string;
  rawError?: unknown;
}

export interface ClientFeeEstimate {
  minFee: string;
  fee: number;
  baseFee: number;
  resourceFee: number;
}

export interface ContractInvocationResult<T> {
  result: T;
  feeEstimate: ClientFeeEstimate | null;
  assembledXdr?: string;
}
