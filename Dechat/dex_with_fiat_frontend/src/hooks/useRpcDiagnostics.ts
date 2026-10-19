'use client';

import { useState, useEffect } from 'react';
import {
  getRpcDiagnostics,
  subscribeToRpcDiagnostics,
  type RpcDiagnostics,
} from '@/lib/resilientRpc';

export function useRpcDiagnostics(network = 'TESTNET') {
  const [diagnostics, setDiagnostics] = useState<RpcDiagnostics>(() =>
    getRpcDiagnostics(network),
  );

  useEffect(() => {
    setDiagnostics(getRpcDiagnostics(network));
    const unsubscribe = subscribeToRpcDiagnostics((updated) => {
      if (updated.network === network.toUpperCase()) {
        setDiagnostics(updated);
      }
    });
    return unsubscribe;
  }, [network]);

  return diagnostics;
}
