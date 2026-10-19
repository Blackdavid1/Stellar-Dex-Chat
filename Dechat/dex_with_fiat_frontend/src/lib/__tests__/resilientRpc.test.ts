import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ALLOWLISTED_RPC_ENDPOINTS,
  getRpcDiagnostics,
  withResilientRpcRead,
  assertWriteNetworkPinning,
  getPinnedNetworkPassphrase,
  resetRpcStateForTesting,
  getActiveEndpoint,
} from '../resilientRpc';
import { Networks } from '@stellar/stellar-sdk';

describe('resilientRpc (Issue #66)', () => {
  beforeEach(() => {
    resetRpcStateForTesting();
    vi.restoreAllMocks();
  });

  it('defines allowlisted endpoint configuration per network', () => {
    expect(ALLOWLISTED_RPC_ENDPOINTS.TESTNET).toBeDefined();
    expect(ALLOWLISTED_RPC_ENDPOINTS.TESTNET.length).toBeGreaterThanOrEqual(2);
    expect(ALLOWLISTED_RPC_ENDPOINTS.PUBLIC).toBeDefined();
    expect(ALLOWLISTED_RPC_ENDPOINTS.PUBLIC.length).toBeGreaterThanOrEqual(2);

    const testnetPrimary = ALLOWLISTED_RPC_ENDPOINTS.TESTNET.find((e) => e.isPrimary);
    expect(testnetPrimary).toBeDefined();
  });

  it('fails over to secondary endpoint when primary endpoint times out on safe read', async () => {
    let callCount = 0;
    const urlsCalled: string[] = [];

    const mockOperation = vi.fn().mockImplementation(async (_server, endpointUrl: string) => {
      callCount += 1;
      urlsCalled.push(endpointUrl);
      if (callCount === 1) {
        // First endpoint times out / throws
        throw new Error('RPC request timed out after 5000ms');
      }
      return { ledgerSequence: 12345 };
    });

    const result = await withResilientRpcRead('TESTNET', mockOperation, { timeoutMs: 1000 });

    expect(result).toEqual({ ledgerSequence: 12345 });
    expect(callCount).toBe(2);
    expect(urlsCalled[0]).toBe(ALLOWLISTED_RPC_ENDPOINTS.TESTNET[0].url);
    expect(urlsCalled[1]).toBe(ALLOWLISTED_RPC_ENDPOINTS.TESTNET[1].url);

    // Diagnostics should report failover and degraded status
    const diagnostics = getRpcDiagnostics('TESTNET');
    expect(diagnostics.failoverCount).toBeGreaterThan(0);
    expect(diagnostics.activeEndpoint).toBe(ALLOWLISTED_RPC_ENDPOINTS.TESTNET[1].url);
    expect(diagnostics.lastSuccessfulRefresh).not.toBeNull();
  });

  it('fails over on malformed response', async () => {
    let callCount = 0;
    const mockOperation = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      }
      return '100.0000000';
    });

    const result = await withResilientRpcRead('TESTNET', mockOperation);
    expect(result).toBe('100.0000000');
    expect(callCount).toBe(2);
  });

  it('updates endpoint health to healthy upon successful recovery', async () => {
    // 1. Initial successful read
    await withResilientRpcRead('TESTNET', async () => 'ok');

    const diag = getRpcDiagnostics('TESTNET');
    expect(diag.healthStatus).toBe('healthy');
    expect(diag.lastSuccessfulRefresh).not.toBeNull();
  });

  it('strictly pins write operations to configured network and prohibits silent network switching', () => {
    // Write operation on matching network succeeds
    expect(() => assertWriteNetworkPinning('TESTNET', 'TESTNET')).not.toThrow();
    expect(() => assertWriteNetworkPinning('PUBLIC', 'PUBLIC')).not.toThrow();

    // Write operation attempting to switch networks is rejected
    expect(() => assertWriteNetworkPinning('PUBLIC', 'TESTNET')).toThrow(
      /Network switching for write actions is prohibited/,
    );
    expect(() => assertWriteNetworkPinning('TESTNET', 'PUBLIC')).toThrow(
      /Network switching for write actions is prohibited/,
    );

    // Verified passphrase pinning
    expect(getPinnedNetworkPassphrase('TESTNET')).toBe(Networks.TESTNET);
    expect(getPinnedNetworkPassphrase('PUBLIC')).toBe(Networks.PUBLIC);
  });

  it('exposes active endpoint health and refresh in diagnostics', async () => {
    await withResilientRpcRead('TESTNET', async () => 'data');

    const diagnostics = getRpcDiagnostics('TESTNET');
    expect(diagnostics.network).toBe('TESTNET');
    expect(diagnostics.activeEndpoint).toBe(getActiveEndpoint('TESTNET'));
    expect(diagnostics.healthStatus).toBe('healthy');
    expect(diagnostics.endpoints.length).toBe(ALLOWLISTED_RPC_ENDPOINTS.TESTNET.length);
  });
});
