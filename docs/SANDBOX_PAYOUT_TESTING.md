# Sandbox End-to-End Payout Lifecycle Testing

## Overview
This suite provides full-lifecycle validation for fiat payout provider integrations in sandbox mode without risking real funds or live-money transfers.

## Security Controls & Live Credential Refusal (Issue #106)
1. **Live-Mode Refusal Guard**:
   The test runner and runtime invoke `assertSandboxSecretKey()`. If any live key (`sk_live_*` or containing `live`) is detected:
   - Execution immediately halts with `LiveCredentialsRefusedError`.
   - No HTTP network requests are dispatched to any external or internal endpoints.
2. **CI Gating**:
   - The end-to-end sandbox lifecycle suite runs under automated testing with sandbox / stubbed credentials.
   - Live production keys are never provisioned into CI runners.

---

## Lifecycle Steps Tested
The lifecycle suite (`src/lib/payout/__tests__/sandboxPayoutLifecycle.test.ts`) covers:
1. **Live Credential Refusal**: Verifies that passing live credentials fails immediately with `LiveCredentialsRefusedError`.
2. **Account Verification**: Tests resolving valid vs invalid bank codes and account numbers.
3. **Recipient Creation**: Registers transfer recipients and returns recipient tokens.
4. **Transfer Initiation**: Dispatches initial transfer and confirms initial pending state.
5. **Idempotent Duplicate Initiation**: Attempts duplicate initiation with identical `X-Idempotency-Key` and ensures no secondary transfer is created.
6. **Delayed & Out-of-Order Webhooks**: Ingests webhook events before initiation records settle or out-of-sequence, validating HMAC-SHA512 signatures and replay cache.
7. **Timeout Budgets & Reconciliation**: Stalls provider connection/response, asserts outcome classification (`ambiguous` vs `known`), and executes status reconciliation without blind duplicate retries.
8. **Credential Rotation during In-Flight Payout**: Rotates key from `v1` to `v2` during an active payout and proves that status reconciliation remains intact for the existing intent.
9. **Authoritative Provider Verification**: Verifies final persisted state against authoritative provider status.
10. **Sandbox Artifact Cleanup**: Cleans up mock/sandbox test artifacts from in-memory stores after completion.
