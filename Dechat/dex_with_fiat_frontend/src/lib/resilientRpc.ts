/**
 * resilientRpc.ts
 *
 * Provides allowlisted Stellar RPC endpoint configuration per network,
 * automatic failover for safe read and status operations, write-operation pinning,
 * and live diagnostic health feedback.
 *
 * Rules:
 *   - Allowlisted endpoint configuration per network (TESTNET, PUBLIC)
 *   - Failover ONLY for safe read or status operations
 *   - Write operations (signing, building tx) are strictly pinned to the configured network
 *   - Live diagnostics exposing active endpoint, health status, and last successful refresh
 */

import { rpc, Networks } from '@stellar/stellar-sdk';
import { clientEnv as env } from '@/lib/clientEnv';

export interface RpcEndpointConfig {
  url: string;
  label: string;
  isPrimary: boolean;
}

export const ALLOWLISTED_RPC_ENDPOINTS: Record<string, RpcEndpointConfig[]> = {
  TESTNET: [
    {
      url: env.NEXT_PUBLIC_STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
      label: 'Stellar Foundation Testnet (Primary)',
      isPrimary: true,
    },
    {
      url: 'https://testnet.stellar.org/rpc',
      label: 'Stellar Foundation Testnet (Secondary)',
      isPrimary: false,
    },
    {
      url: 'https://rpc-testnet.stellar.org',
      label: 'Stellar Foundation Testnet (Backup)',
      isPrimary: false,
    },
  ],
  PUBLIC: [
    {
      url: 'https://soroban-rpc.stellar.org',
      label: 'Stellar Foundation Public (Primary)',
      isPrimary: true,
    },
    {
      url: 'https://mainnet.stellar.org/rpc',
      label: 'Stellar Foundation Public (Secondary)',
      isPrimary: false,
    },
  ],
};

export type EndpointHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface EndpointHealth {
  url: string;
  status: EndpointHealthStatus;
  lastChecked: string | null;
  lastLatencyMs: number | null;
  consecutiveFailures: number;
}

export interface RpcDiagnostics {
  network: string;
  activeEndpoint: string;
  healthStatus: EndpointHealthStatus;
  lastSuccessfulRefresh: string | null;
  failoverCount: number;
  endpoints: EndpointHealth[];
}

interface NetworkRpcState {
  activeEndpointIndex: number;
  lastSuccessfulRefresh: string | null;
  failoverCount: number;
  endpoints: Map<string, EndpointHealth>;
}

const networkStates = new Map<string, NetworkRpcState>();
const diagnosticListeners = new Set<(diag: RpcDiagnostics) => void>();

function initNetworkState(network: string): NetworkRpcState {
  const normNetwork = network.toUpperCase();
  const allowlist = ALLOWLISTED_RPC_ENDPOINTS[normNetwork] ?? ALLOWLISTED_RPC_ENDPOINTS.TESTNET;
  const endpointMap = new Map<string, EndpointHealth>();

  for (const ep of allowlist) {
    endpointMap.set(ep.url, {
      url: ep.url,
      status: 'healthy',
      lastChecked: null,
      lastLatencyMs: null,
      consecutiveFailures: 0,
    });
  }

  const state: NetworkRpcState = {
    activeEndpointIndex: 0,
    lastSuccessfulRefresh: null,
    failoverCount: 0,
    endpoints: endpointMap,
  };

  networkStates.set(normNetwork, state);
  return state;
}

function getNetworkState(network: string): NetworkRpcState {
  const normNetwork = network.toUpperCase();
  let state = networkStates.get(normNetwork);
  if (!state) {
    state = initNetworkState(normNetwork);
  }
  return state;
}

export function resetRpcStateForTesting(network?: string): void {
  if (network) {
    networkStates.delete(network.toUpperCase());
  } else {
    networkStates.clear();
  }
}

export function getActiveEndpoint(network: string): string {
  const normNetwork = network.toUpperCase();
  const allowlist = ALLOWLISTED_RPC_ENDPOINTS[normNetwork] ?? ALLOWLISTED_RPC_ENDPOINTS.TESTNET;
  const state = getNetworkState(normNetwork);
  const endpoint = allowlist[state.activeEndpointIndex] ?? allowlist[0];
  return endpoint.url;
}

export function getRpcDiagnostics(network = 'TESTNET'): RpcDiagnostics {
  const normNetwork = network.toUpperCase();
  const allowlist = ALLOWLISTED_RPC_ENDPOINTS[normNetwork] ?? ALLOWLISTED_RPC_ENDPOINTS.TESTNET;
  const state = getNetworkState(normNetwork);
  const activeUrl = allowlist[state.activeEndpointIndex]?.url ?? allowlist[0].url;

  const endpointHealthList: EndpointHealth[] = allowlist.map((ep) => {
    return (
      state.endpoints.get(ep.url) ?? {
        url: ep.url,
        status: 'healthy',
        lastChecked: null,
        lastLatencyMs: null,
        consecutiveFailures: 0,
      }
    );
  });

  const activeHealth = state.endpoints.get(activeUrl);
  let overallHealth: EndpointHealthStatus = activeHealth?.status ?? 'healthy';
  const allUnhealthy = endpointHealthList.every((e) => e.status === 'unhealthy');
  if (allUnhealthy) {
    overallHealth = 'unhealthy';
  } else if (state.failoverCount > 0 || endpointHealthList.some((e) => e.status !== 'healthy')) {
    overallHealth = 'degraded';
  }

  return {
    network: normNetwork,
    activeEndpoint: activeUrl,
    healthStatus: overallHealth,
    lastSuccessfulRefresh: state.lastSuccessfulRefresh,
    failoverCount: state.failoverCount,
    endpoints: endpointHealthList,
  };
}

function notifyDiagnostics(network: string): void {
  const diag = getRpcDiagnostics(network);
  diagnosticListeners.forEach((listener) => {
    try {
      listener(diag);
    } catch {
      // Ignore listener error
    }
  });
}

export function subscribeToRpcDiagnostics(
  listener: (diag: RpcDiagnostics) => void,
): () => void {
  diagnosticListeners.add(listener);
  return () => {
    diagnosticListeners.delete(listener);
  };
}

/**
 * Server instance cache per endpoint URL.
 */
const serverCache = new Map<string, rpc.Server>();

export function getRpcServerForUrl(url: string): rpc.Server {
  let s = serverCache.get(url);
  if (!s) {
    s = new rpc.Server(url, { allowHttp: false });
    serverCache.set(url, s);
  }
  return s;
}

export interface ResilientReadOptions {
  timeoutMs?: number;
  retries?: number;
}

/**
 * Executes a safe read-only operation against the active allowlisted RPC endpoint,
 * automatically failing over to the next allowlisted endpoint on timeout or error.
 *
 * Strictly confined to read operations on the SAME network.
 */
export async function withResilientRpcRead<T>(
  network: string,
  operation: (server: rpc.Server, endpointUrl: string) => Promise<T>,
  options: ResilientReadOptions = {},
): Promise<T> {
  const normNetwork = network.toUpperCase();
  const allowlist = ALLOWLISTED_RPC_ENDPOINTS[normNetwork] ?? ALLOWLISTED_RPC_ENDPOINTS.TESTNET;
  const state = getNetworkState(normNetwork);
  const timeoutMs = options.timeoutMs ?? 6000;

  const startIndex = state.activeEndpointIndex;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < allowlist.length; attempt++) {
    const currentIndex = (startIndex + attempt) % allowlist.length;
    const currentEndpoint = allowlist[currentIndex];
    const server = getRpcServerForUrl(currentEndpoint.url);
    const epHealth = state.endpoints.get(currentEndpoint.url) ?? {
      url: currentEndpoint.url,
      status: 'healthy',
      lastChecked: null,
      lastLatencyMs: null,
      consecutiveFailures: 0,
    };

    const startTime = Date.now();
    try {
      const result = await Promise.race([
        operation(server, currentEndpoint.url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`RPC request timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      const latencyMs = Date.now() - startTime;
      const nowStr = new Date().toISOString();

      // Mark this endpoint healthy
      epHealth.status = 'healthy';
      epHealth.lastChecked = nowStr;
      epHealth.lastLatencyMs = latencyMs;
      epHealth.consecutiveFailures = 0;
      state.endpoints.set(currentEndpoint.url, epHealth);

      // Set active endpoint to this working one
      state.activeEndpointIndex = currentIndex;
      state.lastSuccessfulRefresh = nowStr;

      notifyDiagnostics(normNetwork);
      return result;
    } catch (err) {
      lastError = err;
      const latencyMs = Date.now() - startTime;
      const nowStr = new Date().toISOString();

      epHealth.consecutiveFailures += 1;
      epHealth.lastChecked = nowStr;
      epHealth.lastLatencyMs = latencyMs;
      epHealth.status = epHealth.consecutiveFailures >= 2 ? 'unhealthy' : 'degraded';
      state.endpoints.set(currentEndpoint.url, epHealth);

      state.failoverCount += 1;
      const nextIndex = (currentIndex + 1) % allowlist.length;
      state.activeEndpointIndex = nextIndex;

      notifyDiagnostics(normNetwork);
    }
  }

  throw new Error(
    `All allowlisted Stellar RPC endpoints for ${normNetwork} failed. Last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Enforces that write operations (transactions, signing) are strictly pinned to the
 * configured network and passphrase. Prevents silent network switching.
 */
export function assertWriteNetworkPinning(
  targetNetwork: string,
  configuredNetwork: string,
): void {
  const normTarget = targetNetwork.toUpperCase();
  const normConfigured = configuredNetwork.toUpperCase();

  if (normTarget !== normConfigured) {
    throw new Error(
      `Cannot execute write transaction: target network ${normTarget} does not match configured signing network ${normConfigured}. Network switching for write actions is prohibited.`,
    );
  }
}

/**
 * Returns the appropriate network passphrase for signing, pinned to the network.
 */
export function getPinnedNetworkPassphrase(network: string): string {
  const norm = network.toUpperCase();
  if (norm === 'PUBLIC' || norm === 'MAINNET') {
    return Networks.PUBLIC;
  }
  return Networks.TESTNET;
}
