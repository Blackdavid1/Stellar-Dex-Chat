import {
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import {
  ContractReceipt,
  ContractWithdrawRequest,
} from './types';

/**
 * Encodes JavaScript arguments into typed Soroban ScVal representations according to ABI specification.
 */
export function encodeAddress(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

export function encodeI128(value: bigint | number | string): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: 'i128' });
}

export function encodeU64(value: bigint | number): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: 'u64' });
}

export function encodeU32(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: 'u32' });
}

export function encodeBool(value: boolean): xdr.ScVal {
  return nativeToScVal(value, { type: 'bool' });
}

/**
 * Decodes native values into typed ContractReceipt.
 */
export function decodeReceipt(raw: unknown): ContractReceipt | null {
  if (!raw || typeof raw !== 'object') return null;

  const r = raw as Record<string, unknown>;
  if (!r.depositor && !r._0) return null;

  return {
    depositor: String(r.depositor ?? r._0),
    amount: BigInt(String(r.amount ?? r._1 ?? 0)),
    ledger: Number(r.ledger ?? r._2 ?? 0),
  };
}

/**
 * Decodes native values into typed ContractWithdrawRequest.
 */
export function decodeWithdrawRequest(raw: unknown): ContractWithdrawRequest | null {
  if (!raw || typeof raw !== 'object') return null;

  const w = raw as Record<string, unknown>;
  if (w.id === undefined && w._0 === undefined) return null;

  return {
    id: BigInt(String(w.id ?? w._0 ?? 0)),
    user: String(w.user ?? w._1 ?? ''),
    token: String(w.token ?? w._2 ?? ''),
    amount: BigInt(String(w.amount ?? w._3 ?? 0)),
    destination: String(w.destination ?? w._4 ?? ''),
    queuedAtLedger: Number(w.queued_at_ledger ?? w._5 ?? 0),
  };
}

/**
 * Decodes an ScVal response into native JavaScript types.
 */
export function decodeScVal<T>(val: xdr.ScVal | undefined | null): T {
  if (!val) {
    throw new Error('No return value from contract call');
  }
  return scValToNative(val) as T;
}
