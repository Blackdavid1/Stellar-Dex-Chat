import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  encodeAddress,
  encodeI128,
  encodeU64,
  encodeU32,
  encodeBool,
  decodeReceipt,
  decodeWithdrawRequest,
} from '../encoding';
import { mapContractError, extractErrorCode } from '../errorMapping';
import { FiatBridgeContractClient } from '../client';
import { FIAT_BRIDGE_METHODS, FiatBridgeErrorCode } from '../types';
import { Address, scValToNative } from '@stellar/stellar-sdk';

describe('Typed Contract Client & ABI Bindings (#59)', () => {
  const TEST_CONTRACT_ID =
    'CAWYXBN4PSVXD7NIYEWVFFIIIEUCC6PUN3IMG3J2WHKDB4NVIISMXBPR';
  const TEST_USER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const TEST_ADMIN = 'GBEFLW6RTALNHCL7HW2INWB4ASHZ7E6MF6E2IOIIMBVEAU2B2B4XLRQW';

  let client: FiatBridgeContractClient;

  beforeEach(() => {
    client = new FiatBridgeContractClient({
      contractId: TEST_CONTRACT_ID,
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
  });

  describe('Argument Encoding', () => {
    it('correctly encodes Address', () => {
      const val = encodeAddress(TEST_USER);
      expect(val).toBeDefined();
      const native = scValToNative(val);
      expect(native).toBe(TEST_USER);
    });

    it('correctly encodes i128 BigInt amounts', () => {
      const amount = BigInt('5000000000');
      const val = encodeI128(amount);
      expect(val).toBeDefined();
      const native = scValToNative(val);
      expect(native).toBe(amount);
    });

    it('correctly encodes u64 integers and BigInts', () => {
      const id = BigInt(42);
      const val = encodeU64(id);
      expect(scValToNative(val)).toBe(id);
    });

    it('correctly encodes u32 ledger numbers', () => {
      const ledger = 123456;
      const val = encodeU32(ledger);
      expect(scValToNative(val)).toBe(ledger);
    });

    it('correctly encodes boolean flags', () => {
      expect(scValToNative(encodeBool(true))).toBe(true);
      expect(scValToNative(encodeBool(false))).toBe(false);
    });
  });

  describe('Result Decoding', () => {
    it('decodes ContractReceipt struct from native object', () => {
      const raw = {
        depositor: TEST_USER,
        amount: '10000000',
        ledger: 54321,
      };
      const decoded = decodeReceipt(raw);
      expect(decoded).toEqual({
        depositor: TEST_USER,
        amount: BigInt(10000000),
        ledger: 54321,
      });
    });

    it('returns null for empty or invalid receipt raw value', () => {
      expect(decodeReceipt(null)).toBeNull();
      expect(decodeReceipt({})).toBeNull();
    });

    it('decodes ContractWithdrawRequest struct from native object', () => {
      const raw = {
        id: '10',
        user: TEST_USER,
        token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        amount: '25000000',
        destination: TEST_ADMIN,
        queued_at_ledger: 654321,
      };
      const decoded = decodeWithdrawRequest(raw);
      expect(decoded).toEqual({
        id: BigInt(10),
        user: TEST_USER,
        token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        amount: BigInt(25000000),
        destination: TEST_ADMIN,
        queuedAtLedger: 654321,
      });
    });

    it('returns null for invalid withdraw request', () => {
      expect(decodeWithdrawRequest(null)).toBeNull();
    });
  });

  describe('Error Code Extraction & Mapping', () => {
    it('extracts error code from HostError strings', () => {
      expect(extractErrorCode('HostError: Error(Contract, #501)')).toBe(501);
      expect(extractErrorCode('HostError: Error(Contract, 502)')).toBe(502);
      expect(extractErrorCode('Transaction failed with code: 302')).toBe(302);
    });

    it('maps withdrawal queue error codes to typed descriptions', () => {
      const mapped501 = mapContractError('Error(Contract, #501)');
      expect(mapped501.code).toBe(FiatBridgeErrorCode.RequestNotFound);
      expect(mapped501.name).toBe('RequestNotFound');
      expect(mapped501.category).toBe('Withdrawal Queue');
      expect(mapped501.message).toContain('withdrawal request ID does not exist');

      const mapped502 = mapContractError('Error(Contract, #502)');
      expect(mapped502.code).toBe(FiatBridgeErrorCode.WithdrawalLocked);
      expect(mapped502.name).toBe('WithdrawalLocked');
      expect(mapped502.category).toBe('Withdrawal Queue');
    });

    it('maps quota and constraint errors correctly', () => {
      const mapped801 = mapContractError('Error(Contract, #801)');
      expect(mapped801.code).toBe(FiatBridgeErrorCode.WithdrawalQuotaExceeded);
      expect(mapped801.name).toBe('WithdrawalQuotaExceeded');
      expect(mapped801.category).toBe('Quota & Migration');

      const mapped302 = mapContractError('Error(Contract, #302)');
      expect(mapped302.code).toBe(FiatBridgeErrorCode.ExceedsLimit);
      expect(mapped302.category).toBe('Constraints & Limits');
    });

    it('provides fallback for unmapped or generic network errors', () => {
      const mapped = mapContractError(new Error('Network connection dropped'));
      expect(mapped.code).toBe(-1);
      expect(mapped.name).toBe('UnknownContractError');
      expect(mapped.message).toBe('Network connection dropped');
    });
  });

  describe('Transaction Construction & Operations', () => {
    it('builds typed deposit operation with centralized method name', () => {
      const amount = BigInt(1000000);
      const op = client.buildDepositOperation(TEST_USER, amount);
      expect(op).toBeDefined();
    });

    it('builds typed withdraw operation with centralized method name', () => {
      const amount = BigInt(500000);
      const op = client.buildWithdrawOperation(TEST_USER, amount);
      expect(op).toBeDefined();
    });

    it('builds typed request_withdrawal operation', () => {
      const token = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
      const amount = BigInt(200000);
      const op = client.buildRequestWithdrawalOperation(
        TEST_USER,
        token,
        amount,
        TEST_ADMIN,
      );
      expect(op).toBeDefined();
    });
  });

  describe('Client Cache Management', () => {
    it('manages cache with TTL correctly', () => {
      client.setCached('test_key', 'cached_value', 1000);
      expect(client.getCached('test_key')).toBe('cached_value');

      client.clearCache();
      expect(client.getCached('test_key')).toBeUndefined();
    });
  });
});
