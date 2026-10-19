import fs from 'fs';
import path from 'path';
import abiData from './abi/fiat_bridge_abi.json';
import { FIAT_BRIDGE_METHODS, FiatBridgeErrorCode } from './types';

export interface ValidationReport {
  valid: boolean;
  missingMethodsInAbi: string[];
  missingMethodsInTypes: string[];
  missingErrorsInTypes: string[];
  unmatchedErrors: string[];
  contractRustDrift: string[];
}

/**
 * Validates TypeScript contract bindings against the canonical ABI fixture and the Rust contract source.
 */
export function validateAbiBindings(rustSourcePath?: string): ValidationReport {
  const report: ValidationReport = {
    valid: true,
    missingMethodsInAbi: [],
    missingMethodsInTypes: [],
    missingErrorsInTypes: [],
    unmatchedErrors: [],
    contractRustDrift: [],
  };

  const abiMethodNames = new Set(abiData.methods.map((m) => m.name));
  const typeMethodNames = new Set(Object.values(FIAT_BRIDGE_METHODS));

  // 1. Check all methods in types exist in ABI
  for (const m of typeMethodNames) {
    if (!abiMethodNames.has(m)) {
      report.missingMethodsInAbi.push(m);
      report.valid = false;
    }
  }

  // 2. Check all methods in ABI exist in types
  for (const m of abiMethodNames) {
    if (!typeMethodNames.has(m as (typeof FIAT_BRIDGE_METHODS)[keyof typeof FIAT_BRIDGE_METHODS])) {
      report.missingMethodsInTypes.push(m);
      report.valid = false;
    }
  }

  // 3. Check error codes
  const abiErrors = abiData.errors as Record<string, { name: string; description: string }>;
  for (const [codeStr, info] of Object.entries(abiErrors)) {
    const num = parseInt(codeStr, 10);
    const enumVal = (FiatBridgeErrorCode as unknown as Record<string, number>)[info.name];
    if (enumVal !== num) {
      report.unmatchedErrors.push(
        `Error '${info.name}' code mismatch: ABI says ${num}, Enum says ${enumVal}`,
      );
      report.valid = false;
    }
  }

  // 4. If Rust contract source file path is provided or default exists, check for method export drift
  const targetRustPath =
    rustSourcePath ||
    path.resolve(process.cwd(), '../stellar-contracts/src/lib.rs');

  if (fs.existsSync(targetRustPath)) {
    const rustSource = fs.readFileSync(targetRustPath, 'utf8');
    // Verify each ABI method has a corresponding `pub fn <name>` in Rust contract
    for (const methodName of abiMethodNames) {
      const regex = new RegExp(`pub\\s+fn\\s+${methodName}\\b`);
      if (!regex.test(rustSource)) {
        report.contractRustDrift.push(
          `ABI method '${methodName}' not found as public function in contract ${targetRustPath}`,
        );
        report.valid = false;
      }
    }
  }

  return report;
}

// CLI runner
if (require.main === module) {
  const result = validateAbiBindings();
  if (!result.valid) {
    console.error('❌ ABI Bindings Validation Failed:');
    if (result.missingMethodsInAbi.length) {
      console.error('Missing in ABI:', result.missingMethodsInAbi);
    }
    if (result.missingMethodsInTypes.length) {
      console.error('Missing in Types:', result.missingMethodsInTypes);
    }
    if (result.unmatchedErrors.length) {
      console.error('Unmatched Errors:', result.unmatchedErrors);
    }
    if (result.contractRustDrift.length) {
      console.error('Contract Drift:', result.contractRustDrift);
    }
    process.exit(1);
  } else {
    console.log('✅ ABI bindings and contract interface match perfectly.');
    process.exit(0);
  }
}
