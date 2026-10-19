import {
  FiatBridgeErrorCode,
  TypedContractError,
  ErrorCategory,
} from './types';
import abiData from './abi/fiat_bridge_abi.json';

const ERROR_REGISTRY = abiData.errors as Record<
  string,
  { name: string; description: string }
>;

function getCategoryForCode(code: number): ErrorCategory {
  if (code >= 101 && code <= 199) return 'Initialization & State';
  if (code >= 201 && code <= 299) return 'Authorization & Access';
  if (code >= 301 && code <= 399) return 'Constraints & Limits';
  if (code >= 401 && code <= 499) return 'Funds & Balances';
  if (code >= 501 && code <= 599) return 'Withdrawal Queue';
  if (code >= 601 && code <= 699) return 'Governance & Timelock';
  if (code >= 701 && code <= 799) return 'External Services';
  if (code >= 801 && code <= 899) return 'Quota & Migration';
  if (code >= 901 && code <= 999) return 'Replay Protection';
  if (code >= 1001 && code <= 1099) return 'Deposit Floor';
  if (code >= 1101 && code <= 1199) return 'Multi-sig';
  return 'Unknown';
}

/**
 * Extracts a numeric contract error code from Soroban simulation/RPC error output.
 * Matches patterns like:
 * - Error(Contract, #501)
 * - Error(Contract, 501)
 * - "code": 501
 * - contract error 501
 */
export function extractErrorCode(error: unknown): number | null {
  if (!error) return null;

  if (typeof error === 'number') {
    return error in ERROR_REGISTRY ? error : null;
  }

  const errorStr =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? `${error.message} ${(error as { details?: string }).details ?? ''}`
        : JSON.stringify(error);

  // Pattern 1: Error(Contract, #501) or Error(Contract, 501)
  const contractMatch = errorStr.match(/Error\(Contract,\s*#?([0-9]+)\)/i);
  if (contractMatch?.[1]) {
    return parseInt(contractMatch[1], 10);
  }

  // Pattern 2: "code": 501 or code: 501
  const codeMatch = errorStr.match(/['"]?code['"]?:\s*([0-9]{3,4})/i);
  if (codeMatch?.[1]) {
    return parseInt(codeMatch[1], 10);
  }

  // Pattern 3: #501 or [Error: 501]
  const hashMatch = errorStr.match(/#([0-9]{3,4})\b/);
  if (hashMatch?.[1]) {
    return parseInt(hashMatch[1], 10);
  }

  return null;
}

/**
 * Maps any Soroban simulation, RPC, or execution error into a strongly typed contract error.
 */
export function mapContractError(error: unknown): TypedContractError {
  const code = extractErrorCode(error);

  if (code !== null && ERROR_REGISTRY[code.toString()]) {
    const info = ERROR_REGISTRY[code.toString()];
    return {
      code,
      name: info.name,
      category: getCategoryForCode(code),
      message: info.description,
      rawError: error,
    };
  }

  // Fallback for general unmapped errors
  const fallbackMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown contract error occurred';

  return {
    code: -1,
    name: 'UnknownContractError',
    category: 'Unknown',
    message: fallbackMessage,
    rawError: error,
  };
}

export function isSpecificContractError(
  error: unknown,
  expectedCode: FiatBridgeErrorCode,
): boolean {
  const code = extractErrorCode(error);
  return code === expectedCode;
}
