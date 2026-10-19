/**
 * Credential guard to prevent live-money operations in non-production environments.
 * Addresses Issue #106:
 * - Refuses live-mode credentials in sandbox and test suites.
 * - Protects against accidental live transfers.
 */

export class LiveCredentialsRefusedError extends Error {
  public readonly code = 'LIVE_CREDENTIALS_REFUSED';

  constructor(
    message = 'Live credentials (sk_live_*) are strictly forbidden in sandbox/test environments!',
  ) {
    super(message);
    this.name = 'LiveCredentialsRefusedError';
  }
}

/**
 * Checks whether a secret key matches live-mode provider patterns.
 */
export function isLiveSecretKey(key?: string): boolean {
  if (!key) return false;
  const trimmed = key.trim();
  return (
    trimmed.startsWith('sk_live_') ||
    trimmed.startsWith('live_') ||
    trimmed.includes('_live_')
  );
}

/**
 * Asserts that the provided key is a sandbox/test key.
 * Throws LiveCredentialsRefusedError if a live key is detected.
 */
export function assertSandboxSecretKey(key?: string): void {
  if (isLiveSecretKey(key)) {
    throw new LiveCredentialsRefusedError(
      'Live credentials are not permitted in sandbox or test runs. Refusing execution to prevent live-money transfers.',
    );
  }
}
