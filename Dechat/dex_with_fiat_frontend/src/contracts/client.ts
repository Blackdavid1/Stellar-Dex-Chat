import {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import {
  FIAT_BRIDGE_METHODS,
  FiatBridgeMethod,
  ContractReceipt,
  ContractWithdrawRequest,
  ClientFeeEstimate,
} from './types';
import {
  encodeAddress,
  encodeI128,
  encodeU64,
  decodeReceipt,
  decodeWithdrawRequest,
  decodeScVal,
} from './encoding';
import { mapContractError } from './errorMapping';

export interface ContractClientConfig {
  rpcUrl?: string;
  contractId: string;
  networkPassphrase?: string;
  dummySourceAccount?: string;
  cacheTtlMs?: number;
}

const DEFAULT_RPC_URL =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL ||
  'https://soroban-testnet.stellar.org';
const DEFAULT_NETWORK_PASSPHRASE = Networks.TESTNET;
const DEFAULT_DUMMY_SOURCE =
  'GBEFLW6RTALNHCL7HW2INWB4ASHZ7E6MF6E2IOIIMBVEAU2B2B4XLRQW';
const DEFAULT_CACHE_TTL = 10_000;

export class FiatBridgeContractClient {
  public readonly contractId: string;
  public readonly rpcUrl: string;
  public readonly networkPassphrase: string;
  public readonly dummySourceAccount: string;
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly cache = new Map<string, { value: unknown; expires: number }>();
  private readonly cacheTtlMs: number;

  constructor(config: ContractClientConfig) {
    this.contractId = config.contractId;
    this.rpcUrl = config.rpcUrl || DEFAULT_RPC_URL;
    this.networkPassphrase =
      config.networkPassphrase || DEFAULT_NETWORK_PASSPHRASE;
    this.dummySourceAccount =
      config.dummySourceAccount || DEFAULT_DUMMY_SOURCE;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL;
    this.server = new rpc.Server(this.rpcUrl, { allowHttp: false });
    this.contract = new Contract(this.contractId);
  }

  // ── Cache management ──────────────────────────────────────────────────────

  public getCached<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  public setCached(key: string, value: unknown, ttlMs?: number): void {
    this.cache.set(key, {
      value,
      expires: Date.now() + (ttlMs ?? this.cacheTtlMs),
    });
  }

  public clearCache(): void {
    this.cache.clear();
  }

  // ── Read-only Query Execution ─────────────────────────────────────────────

  public async callView<T>(
    method: FiatBridgeMethod,
    args: xdr.ScVal[] = [],
    useCache: boolean = true,
  ): Promise<T> {
    const cacheKey = `${method}:${args.map((a) => a.toXDR('hex')).join(':')}`;
    if (useCache) {
      const cached = this.getCached<T>(cacheKey);
      if (cached !== undefined) return cached;
    }

    try {
      let account;
      try {
        account = await this.server.getAccount(this.dummySourceAccount);
      } catch {
        const { Account } = await import('@stellar/stellar-sdk');
        account = new Account(this.dummySourceAccount, '0');
      }

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call(method, ...args))
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        const mapped = mapContractError(sim.error);
        throw new Error(
          `Contract query '${method}' failed [${mapped.name} #${mapped.code}]: ${mapped.message}`,
        );
      }

      const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result
        ?.retval;
      const decoded = decodeScVal<T>(retval);
      if (useCache) {
        this.setCached(cacheKey, decoded);
      }
      return decoded;
    } catch (err) {
      if (err instanceof Error && err.message.includes('Contract query')) {
        throw err;
      }
      const mapped = mapContractError(err);
      throw new Error(
        `Failed to call '${method}': ${mapped.message || (err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  // ── Typed Query Domain Methods ───────────────────────────────────────────

  public async getToken(): Promise<string> {
    return this.callView<string>(FIAT_BRIDGE_METHODS.GET_TOKEN);
  }

  public async getTotalWithdrawn(): Promise<bigint> {
    return this.callView<bigint>(FIAT_BRIDGE_METHODS.GET_TOTAL_WITHDRAWN);
  }

  public async getTotalLiabilities(): Promise<bigint> {
    return this.callView<bigint>(FIAT_BRIDGE_METHODS.GET_TOTAL_LIABILITIES);
  }

  public async getBalance(): Promise<bigint> {
    const deposited = await this.getTotalDeposited();
    try {
      const withdrawn = await this.getTotalWithdrawn();
      return deposited >= withdrawn ? deposited - withdrawn : BigInt(0);
    } catch {
      return deposited;
    }
  }

  public async getAdmin(): Promise<string> {
    return this.callView<string>(FIAT_BRIDGE_METHODS.GET_ADMIN);
  }

  public async getLimit(): Promise<bigint> {
    return this.callView<bigint>(FIAT_BRIDGE_METHODS.GET_LIMIT);
  }

  public async getTotalDeposited(): Promise<bigint> {
    return this.callView<bigint>(FIAT_BRIDGE_METHODS.GET_TOTAL_DEPOSITED);
  }

  public async getWithdrawalQueueDepth(): Promise<number> {
    const value = await this.callView<bigint | number>(
      FIAT_BRIDGE_METHODS.GET_WQ_DEPTH,
    );
    return Number(value);
  }

  public async getWithdrawalQueueOldestQueuedLedger(): Promise<number | null> {
    const val = await this.callView<number | bigint | null>(
      FIAT_BRIDGE_METHODS.GET_WQ_OLDEST_QUEUED_LEDGER,
    );
    return val !== null && val !== undefined ? Number(val) : null;
  }

  public async getWithdrawalQueueOldestAgeLedgers(): Promise<number | null> {
    const val = await this.callView<number | bigint | null>(
      FIAT_BRIDGE_METHODS.GET_WQ_OLDEST_AGE_LEDGERS,
    );
    return val !== null && val !== undefined ? Number(val) : null;
  }

  public async getWithdrawalRequest(
    id: bigint | number,
  ): Promise<ContractWithdrawRequest | null> {
    const raw = await this.callView<unknown>(
      FIAT_BRIDGE_METHODS.GET_WITHDRAWAL_REQUEST,
      [encodeU64(id)],
    );
    return decodeWithdrawRequest(raw);
  }

  public async getReceiptByIndex(
    index: bigint | number,
  ): Promise<ContractReceipt | null> {
    const raw = await this.callView<unknown>(
      FIAT_BRIDGE_METHODS.GET_RECEIPT_BY_INDEX,
      [encodeU64(index)],
    );
    return decodeReceipt(raw);
  }

  public async getAccruedFees(tokenAddress: string): Promise<bigint> {
    return this.callView<bigint>(FIAT_BRIDGE_METHODS.GET_ACCRUED_FEES, [
      encodeAddress(tokenAddress),
    ]);
  }

  public async getEventVersion(): Promise<number> {
    const ver = await this.callView<number | bigint>(
      FIAT_BRIDGE_METHODS.GET_EVENT_VERSION,
    );
    return Number(ver);
  }

  public async isCircuitBreakerTripped(): Promise<boolean> {
    return this.callView<boolean>(
      FIAT_BRIDGE_METHODS.IS_CIRCUIT_BREAKER_TRIPPED,
    );
  }

  public async isDenied(address: string): Promise<boolean> {
    return this.callView<boolean>(FIAT_BRIDGE_METHODS.IS_DENIED, [
      encodeAddress(address),
    ]);
  }

  // ── Transaction Construction & Simulation ────────────────────────────────

  public async buildAndSimulate(
    sourcePublicKey: string,
    operation: ReturnType<Contract['call']>,
  ): Promise<{ assembledXdr: string; feeEstimate: ClientFeeEstimate | null }> {
    try {
      const account = await this.server.getAccount(sourcePublicKey);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        const mapped = mapContractError(sim.error);
        throw new Error(
          `Simulation failed [${mapped.name} #${mapped.code}]: ${mapped.message}`,
        );
      }

      let feeEstimate: ClientFeeEstimate | null = null;
      const successSim = sim as rpc.Api.SimulateTransactionSuccessResponse;
      if (successSim.minResourceFee !== undefined) {
        const resourceFeeInStroops = BigInt(successSim.minResourceFee);
        const baseFeeInStroops = BigInt(BASE_FEE);
        const totalFeeInStroops = resourceFeeInStroops + baseFeeInStroops;

        feeEstimate = {
          minFee: totalFeeInStroops.toString(),
          fee: Number(totalFeeInStroops) / 10_000_000,
          baseFee: Number(baseFeeInStroops) / 10_000_000,
          resourceFee: Number(resourceFeeInStroops) / 10_000_000,
        };
      }

      return {
        assembledXdr: rpc.assembleTransaction(tx, sim).build().toXDR(),
        feeEstimate,
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes('Simulation failed [')) {
        throw err;
      }
      const mapped = mapContractError(err);
      throw new Error(`Transaction simulation error: ${mapped.message}`);
    }
  }

  public buildDepositOperation(
    fromPublicKey: string,
    amount: bigint,
  ): ReturnType<Contract['call']> {
    return this.contract.call(
      FIAT_BRIDGE_METHODS.DEPOSIT,
      encodeAddress(fromPublicKey),
      encodeI128(amount),
    );
  }

  public buildWithdrawOperation(
    recipientPublicKey: string,
    amount: bigint,
  ): ReturnType<Contract['call']> {
    return this.contract.call(
      FIAT_BRIDGE_METHODS.WITHDRAW,
      encodeAddress(recipientPublicKey),
      encodeI128(amount),
    );
  }

  public buildRequestWithdrawalOperation(
    userPublicKey: string,
    tokenAddress: string,
    amount: bigint,
    destinationPublicKey: string,
  ): ReturnType<Contract['call']> {
    return this.contract.call(
      FIAT_BRIDGE_METHODS.REQUEST_WITHDRAWAL,
      encodeAddress(userPublicKey),
      encodeAddress(tokenAddress),
      encodeI128(amount),
      encodeAddress(destinationPublicKey),
    );
  }

  public async simulateDeposit(
    fromPublicKey: string,
    amount: bigint,
  ): Promise<ClientFeeEstimate | null> {
    const op = this.buildDepositOperation(fromPublicKey, amount);
    const { feeEstimate } = await this.buildAndSimulate(fromPublicKey, op);
    return feeEstimate;
  }

  public async simulateWithdraw(
    adminPublicKey: string,
    recipientPublicKey: string,
    amount: bigint,
  ): Promise<ClientFeeEstimate | null> {
    const op = this.buildWithdrawOperation(recipientPublicKey, amount);
    const { feeEstimate } = await this.buildAndSimulate(adminPublicKey, op);
    return feeEstimate;
  }
}
