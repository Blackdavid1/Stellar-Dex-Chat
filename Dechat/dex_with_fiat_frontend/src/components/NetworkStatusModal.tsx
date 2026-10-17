'use client';

import { X, Wifi, WifiOff, AlertTriangle, Activity } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import { useStellarWallet, EXPECTED_NETWORK } from '@/contexts/StellarWalletContext';
import { useRpcDiagnostics } from '@/hooks/useRpcDiagnostics';

interface NetworkStatusModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function NetworkStatusModal({ isOpen, onClose }: NetworkStatusModalProps) {
  const { isDarkMode } = useTheme();
  const { connection, isNetworkMismatch } = useStellarWallet();
  const rpcDiag = useRpcDiagnostics(connection.network || 'TESTNET');

  if (!isOpen) return null;

  const status = !connection.isConnected
    ? 'disconnected'
    : isNetworkMismatch
      ? 'mismatch'
      : 'connected';

  const statusConfig = {
    connected: {
      dot: 'bg-green-400',
      label: 'Connected',
      description: `Wallet is connected to the Stellar ${connection.network} network.`,
      Icon: Wifi,
      iconClass: isDarkMode ? 'text-green-400' : 'text-green-600',
    },
    mismatch: {
      dot: 'bg-amber-400',
      label: 'Network Mismatch',
      description: `Wallet is connected to ${connection.network} but the app expects ${EXPECTED_NETWORK}. Transactions are disabled.`,
      Icon: AlertTriangle,
      iconClass: isDarkMode ? 'text-amber-400' : 'text-amber-600',
    },
    disconnected: {
      dot: 'bg-red-500',
      label: 'Disconnected',
      description: 'No Stellar wallet is connected. Connect Freighter to send transactions.',
      Icon: WifiOff,
      iconClass: isDarkMode ? 'text-red-400' : 'text-red-600',
    },
  }[status];

  const rpcHealthBadge = {
    healthy: 'text-green-700 bg-green-100 dark:text-green-300 dark:bg-green-900/60',
    degraded: 'text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/60',
    unhealthy: 'text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-900/60',
  }[rpcDiag.healthStatus];

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Network status"
        className={`fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-88 rounded-xl shadow-2xl border p-6 transition-colors duration-300 ${
          isDarkMode
            ? 'bg-gray-900 border-gray-700 text-gray-100'
            : 'bg-white border-gray-200 text-gray-900'
        }`}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Network & RPC Diagnostics</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className={`p-1.5 rounded-lg transition-colors ${
              isDarkMode
                ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
            }`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-start gap-3">
          <span className={`mt-1 w-3 h-3 rounded-full flex-shrink-0 ${statusConfig.dot}`} />
          <div>
            <p className="font-medium text-sm">{statusConfig.label}</p>
            <p className={`text-xs mt-1 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              {statusConfig.description}
            </p>
          </div>
        </div>

        <dl className={`mt-4 space-y-2 text-xs border-t pt-4 ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          {connection.isConnected && (
            <>
              <div className="flex justify-between">
                <dt className={isDarkMode ? 'text-gray-400' : 'text-gray-500'}>Address</dt>
                <dd className="font-mono">
                  {connection.address.slice(0, 6)}…{connection.address.slice(-4)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className={isDarkMode ? 'text-gray-400' : 'text-gray-500'}>Network</dt>
                <dd>{connection.network || '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className={isDarkMode ? 'text-gray-400' : 'text-gray-500'}>Expected</dt>
                <dd>{EXPECTED_NETWORK}</dd>
              </div>
            </>
          )}

          {/* RPC Diagnostics Section */}
          <div className="pt-2 border-t border-[var(--color-border)] mt-3">
            <div className="flex items-center gap-1.5 mb-2 font-medium">
              <Activity className="w-3.5 h-3.5 text-blue-500" />
              <span>RPC Endpoint Diagnostics</span>
            </div>
            <div className="flex justify-between items-center py-1">
              <dt className={isDarkMode ? 'text-gray-400' : 'text-gray-500'}>Active RPC</dt>
              <dd className="font-mono text-[11px] truncate max-w-[170px]" title={rpcDiag.activeEndpoint}>
                {rpcDiag.activeEndpoint.replace('https://', '')}
              </dd>
            </div>
            <div className="flex justify-between items-center py-1">
              <dt className={isDarkMode ? 'text-gray-400' : 'text-gray-500'}>Endpoint Health</dt>
              <dd>
                <span className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${rpcHealthBadge}`}>
                  {rpcDiag.healthStatus}
                </span>
              </dd>
            </div>
            <div className="flex justify-between items-center py-1">
              <dt className={isDarkMode ? 'text-gray-400' : 'text-gray-500'}>Last Refresh</dt>
              <dd className="text-[11px]">
                {rpcDiag.lastSuccessfulRefresh
                  ? new Date(rpcDiag.lastSuccessfulRefresh).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })
                  : 'Pending'}
              </dd>
            </div>
            {rpcDiag.failoverCount > 0 && (
              <div className="flex justify-between items-center py-1 text-amber-600 dark:text-amber-400">
                <dt>Failover Count</dt>
                <dd className="font-mono">{rpcDiag.failoverCount}</dd>
              </div>
            )}
          </div>
        </dl>
      </div>
    </>
  );
}
