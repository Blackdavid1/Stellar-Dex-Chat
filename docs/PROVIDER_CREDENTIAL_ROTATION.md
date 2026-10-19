# Provider Credential Rotation & Recovery Runbook

## Overview
This runbook defines the policies, operational lifecycle, and runtime architecture for rotating payment provider credentials (such as Paystack API secret keys and webhook signing secrets) without interrupting in-flight payouts.

## Acceptance Criteria & Architecture Alignment (Issue #105)
- **Secret Ownership**: Platform Engineering & Security Operations team.
- **Secret Storage**: Dedicated Secrets Manager (e.g. AWS Secrets Manager, HashiCorp Vault) injected into runtime environment variables. Never stored in source code or client bundles.
- **Rotation Cadence**:
  - Regular cadence: Every 90 days.
  - Emergency cadence: Immediate upon suspect credential exposure or personnel offboarding.
- **Environment Separation**:
  - Strict isolation between Sandbox (`sk_test_*`) and Production (`sk_live_*`).
  - Production keys are strictly prohibited in local/CI test suites (enforced via `assertSandboxSecretKey`).
- **Revocation**:
  - Bounded overlap window (72 hours default) during which retiring keys remain valid for status reconciliation and webhook verification.
  - Revocation only occurs after verifying that zero in-flight payout intents remain un-reconciled under the retired key.

---

## Credential Keyring & Versioning

The application implements a versioned credential keyring in `src/lib/payout/credentialManager.ts`:

1. **Active Credential (`PAYSTACK_KEY_VERSION`, default `v1`)**:
   - Used for all new outbound provider calls (`verifyAccount`, `createRecipient`, `initiateTransfer`).
   - Every newly created transfer records `credentialVersion` in its `TransferStatusRecord`.
2. **Retiring Credential (`PAYSTACK_PREVIOUS_KEY_VERSION`, e.g. `v0`)**:
   - Maintained in the keyring during the bounded overlap window.
   - Used to recover transfer status for in-flight intents that were initiated under the previous key.
   - Validated against incoming webhook signatures so in-flight settlements signed with the older key are authenticated seamlessly.
3. **Audit & Logging Policy**:
   - Telemetry and server logs **MUST ONLY** record `{ credentialVersion: 'v1' }`.
   - Secret material (`sk_live_*`, `sk_test_*`, bearer tokens) is strictly stripped and never logged.

---

## Step-by-Step Rotation Runbook

### Phase 1: Pre-Rotation Validation
1. Verify sandbox functionality using test keys.
2. Confirm current active key status and inventory outstanding pending transfers in `transferStore`.

### Phase 2: Staging New Key in Secrets Manager
1. Generate new API key pair (`KEY_NEW`, version `v2`) in provider dashboard.
2. Update environment configuration:
   - `PAYSTACK_SECRET_KEY` = `<KEY_NEW>`
   - `PAYSTACK_KEY_VERSION` = `v2`
   - `PAYSTACK_PREVIOUS_SECRET_KEY` = `<KEY_OLD>`
   - `PAYSTACK_PREVIOUS_KEY_VERSION` = `v1`
3. Deploy application. The runtime now automatically:
   - Directs all new transfers through `v2`.
   - Reconciles existing in-flight transfers using `v1`.
   - Accepts webhooks signed by either `v1` or `v2`.

### Phase 3: Draining In-Flight Payouts
1. Monitor reconciliation metrics until all transfers initiated under `v1` reach terminal state (`success`, `failed`, `reversed`, or `cancelled`).
2. If transfers stall due to provider latency, trigger reconciliation via `/api/admin/reconciliation` using `v1`.

### Phase 4: Revocation of Old Key
1. Once all `v1` intents have reconciled, revoke `KEY_OLD` in the provider dashboard.
2. Remove `PAYSTACK_PREVIOUS_SECRET_KEY` from configuration during next deployment.

---

## Fallback: Providers Without Bounded Overlap
For providers that support only a single active key at any time:
1. Schedule a planned maintenance window (off-peak hours).
2. Drain in-flight payouts or wait until active queue reaches zero.
3. Generate new key, immediately update environment configuration, and test status endpoint.
4. Run automated reconciliation sweep for any intents that completed across the transition threshold.
