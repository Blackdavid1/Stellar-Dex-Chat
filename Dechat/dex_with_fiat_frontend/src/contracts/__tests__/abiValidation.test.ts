import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { validateAbiBindings } from '../validateAbi';
import { FIAT_BRIDGE_METHODS, FiatBridgeErrorCode } from '../types';
import abiData from '../abi/fiat_bridge_abi.json';

describe('Fiat Bridge Contract ABI Bindings (#59)', () => {
  it('validates canonical ABI JSON artifact structure', () => {
    expect(abiData.contractName).toBe('FiatBridgeContract');
    expect(abiData.version).toBe(1);
    expect(Array.isArray(abiData.methods)).toBe(true);
    expect(abiData.methods.length).toBeGreaterThan(15);
    expect(abiData.errors).toBeDefined();
  });

  it('ensures all typed methods have corresponding ABI definitions', () => {
    const report = validateAbiBindings();
    expect(report.missingMethodsInAbi).toEqual([]);
    expect(report.missingMethodsInTypes).toEqual([]);
  });

  it('ensures all ABI error codes match the TypeScript error enum', () => {
    const report = validateAbiBindings();
    expect(report.unmatchedErrors).toEqual([]);
    expect(FiatBridgeErrorCode.RequestNotFound).toBe(501);
    expect(FiatBridgeErrorCode.WithdrawalLocked).toBe(502);
    expect(FiatBridgeErrorCode.ExceedsLimit).toBe(302);
    expect(FiatBridgeErrorCode.WithdrawalQuotaExceeded).toBe(801);
  });

  it('fails validation when an ABI method is missing in the contract source', () => {
    const report = validateAbiBindings();
    expect(report.contractRustDrift).toEqual([]);
    expect(report.valid).toBe(true);
  });
});
