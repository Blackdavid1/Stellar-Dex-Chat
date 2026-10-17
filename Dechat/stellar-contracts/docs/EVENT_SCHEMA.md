# Event Schema Compatibility and Version Policy

## 1. Overview and Objective

This document establishes the formal contract event schema specification, compatibility policy, and versioning rules for the Stellar Fiat Bridge contract (`FiatBridge`).

Off-chain indexers, analytics services, and frontend monitors rely on emitted contract events to construct user balances, audit transaction histories, track rate limits, and detect administrative actions. Unpredictable or silent changes to event topics, data payloads, or emission timing break downstream consumers.

This policy defines:
1. The **versioning model** and semantics of `EVENT_VERSION`.
2. Explicit criteria for **additive (backwards-compatible)** versus **breaking** event changes.
3. The **transaction ordering guarantee**: events are emitted strictly *after* all validations pass and state mutations succeed.
4. The authoritative reference schema for every public event family.
5. The structure of golden event fixtures consumable by indexer test suites.

---

## 2. Event Version Policy

Every contract event carries a version indicator:
- For events utilizing the Soroban SDK `#[contractevent]` macro, the struct payload includes `pub version: u32`, pinned to the constant `EVENT_VERSION = 1`.
- For raw published events (e.g., multisig and governance upgrades), `EVENT_VERSION` is emitted as the first element of the topic tuple: `(EVENT_VERSION, Symbol::new(&env, "event_name"))`.

### 2.1 Additive Changes (Non-Breaking)

An additive change preserves backward compatibility with existing indexers without requiring coordinated indexer deployments. Additive changes include:
- **New Event Families**: Introducing a new event type for a new entrypoint or feature. Existing indexers simply ignore unhandled event topics.
- **Optional Trailing Fields**: Adding optional metadata fields to data structures where indexers deserialize leniently.
- **Documentation Updates**: Clarifying field definitions or documentation comments without altering wire formats.

Additive changes **do not** require bumping `EVENT_VERSION`.

### 2.2 Breaking Changes

A breaking change alters the parsing assumptions or serialization layout of existing events. Breaking changes include:
- Renaming or removing existing topics or symbol names.
- Changing the topic tuple arity (e.g., changing `(EVENT_VERSION, symbol)` to `(EVENT_VERSION, symbol, address)`).
- Removing, renaming, or reordering fields in an event data payload.
- Changing the primitive type of a field (e.g., changing `u32` to `u64`, or `i128` to `Address`).
- Changing the semantic scale or units of an existing field (e.g., from stroops to base tokens).
- Changing the emission condition such that an existing event is emitted on a different state transition.

Breaking changes **strictly require**:
1. Incrementing `EVENT_VERSION` (e.g., from `1` to `2`).
2. Documenting the migration path in `VERSION_MIGRATION.md` and `CHANGELOG.md`.
3. Updating and validating all golden event fixtures.
4. Providing dual-version support in the indexer if historic event replay is required.

---

## 3. Emission Guarantee: Post-Validation and Mutation

Events communicate completed on-chain facts. To prevent indexers from recording uncommitted or rejected operations:
- **Validation Precedence**: All parameter validations, authentication checks (`require_auth`), limit validations, replay nonce checks, and invariant assertions (`Self::check_invariants`) **MUST** execute and pass prior to event emission.
- **Mutation Precedence**: All persistent and temporary storage writes (`env.storage().instance().set()`, `env.storage().persistent().set()`) **MUST** complete prior to event emission.
- **Atomic Rollback**: If any failure occurs during execution, the host transaction reverts, discarding all pending storage writes and event emissions. Events are never emitted for failed transactions.

---

## 4. Public Event Family Schema Reference

| Event Name | Schema Type | Topic Format | Data Payload Fields | Emission Site |
|:---|:---|:---|:---|:---|
| **DeployHashEvent** | `#[contractevent]` | `[Symbol("DeployHashEvent")]` | `{ version: u32, config_hash: BytesN<32> }` | `init` |
| **DepositEvent** | `#[contractevent]` | `[Symbol("DepositEvent")]` | `{ version: u32, from: Address, token: Address, amount: i128, receipt_id: BytesN<32>, by: Address, ledger: u32 }` | `deposit` |
| **ReceiptIssuedEvent** | `#[contractevent]` | `[Symbol("ReceiptIssuedEvent")]` | `{ version: u32, receipt_id: BytesN<32>, memo_hash: Option<BytesN<32>> }` | `deposit` |
| **WithdrawEvent** | `#[contractevent]` | `[Symbol("WithdrawEvent")]` | `{ version: u32, to: Address, token: Address, amount: i128, by: Address, ledger: u32 }` | `withdraw` |
| **WithdrawalRequestedEvent** | `#[contractevent]` | `[Symbol("WithdrawalRequestedEvent")]` | `{ version: u32, to: Address, request_id: u64, amount: i128, token: Address, memo_hash: Option<BytesN<32>> }` | `request_withdrawal` |
| **WithdrawalExecutedEvent** | `#[contractevent]` | `[Symbol("WithdrawalExecutedEvent")]` | `{ version: u32, request_id: u64, to: Address, amount: i128, nonce: u64 }` | `execute_withdrawal` |
| **WithdrawalCancelledEvent** | `#[contractevent]` | `[Symbol("WithdrawalCancelledEvent")]` | `{ version: u32, request_id: u64 }` | `cancel_withdrawal` |
| **WithdrawalExpiredEvent** | `#[contractevent]` | `[Symbol("WithdrawalExpiredEvent")]` | `{ version: u32, request_id: u64, to: Address, amount: i128, queued_ledger: u32 }` | `reclaim_expired_withdrawal` |
| **FeeAccruedEvent** | `#[contractevent]` | `[Symbol("FeeAccruedEvent")]` | `{ version: u32, token: Address, amount: i128 }` | `deposit`, `execute_withdrawal` |
| **FeeWithdrawnEvent** | `#[contractevent]` | `[Symbol("FeeWithdrawnEvent")]` | `{ version: u32, to: Address, amount: i128, token: Address }` | `withdraw_fees`, `withdraw_fees_batch` |
| **FeeVaultReconciledEvent** | `#[contractevent]` | `[Symbol("FeeVaultReconciledEvent")]` | `{ version: u32, token: Address, vault_ledger: i128, on_chain_balance: i128 }` | fee audit reconciler |
| **RefundEvent** | `#[contractevent]` | `[Symbol("RefundEvent")]` | `{ version: u32, receipt_id: BytesN<32>, to: Address, amount: i128 }` | `refund` |
| **PausedEvent** | `#[contractevent]` | `[Symbol("PausedEvent")]` | `{ version: u32, by: Address }` | `pause` |
| **UnpausedEvent** | `#[contractevent]` | `[Symbol("UnpausedEvent")]` | `{ version: u32, by: Address }` | `unpause` |
| **AdminTransferEvent** | `#[contractevent]` | `[Symbol("AdminTransferEvent")]` | `{ version: u32, old_admin: Address, new_admin: Address }` | `transfer_admin`, `accept_admin` |
| **SetMinDepositEvent** | `#[contractevent]` | `[Symbol("SetMinDepositEvent")]` | `{ version: u32, min: i128 }` | `set_min_deposit` |
| **SetLimitEvent** | `#[contractevent]` | `[Symbol("SetLimitEvent")]` | `{ version: u32, token: Address, limit: i128, by: Address, ledger: u32 }` | `set_limit` |
| **SetOperatorEvent** | `#[contractevent]` | `[Symbol("SetOperatorEvent")]` | `{ version: u32, operator: Address, active: bool, previous_active: bool, operator_count: u32, by: Address, ledger: u32 }` | `set_operator` |
| **DenyAddressEvent** | `#[contractevent]` | `[Symbol("DenyAddressEvent")]` | `{ version: u32, address: Address }` | `deny_address` |
| **DenyRemovedEvent** | `#[contractevent]` | `[Symbol("DenyRemovedEvent")]` | `{ version: u32, address: Address }` | `remove_denied` |
| **HeartbeatEvent** | `#[contractevent]` | `[Symbol("HeartbeatEvent")]` | `{ version: u32, operator: Address, ledger: u32 }` | `heartbeat` |
| **HeartbeatBatchEvent** | `#[contractevent]` | `[Symbol("HeartbeatBatchEvent")]` | `{ version: u32, total_items: u32, success_count: u32, failure_count: u32, ledger: u32 }` | `heartbeat_batch` |
| **NonceConsumedEvent** | `#[contractevent]` | `[Symbol("NonceConsumedEvent")]` | `{ version: u32, scope: Symbol, owner: Address, new_nonce: u64 }` | `consume_nonce` |
| **MigrationEvent** | `#[contractevent]` | `[Symbol("MigrationEvent")]` | `{ version: u32, cursor: u64, migrated_count: u32 }` | `migrate_escrow` |
| **CircuitBreakerTrippedEvent** | `#[contractevent]` | `[Symbol("CircuitBreakerTrippedEvent")]` | `{ version: u32, new_total: i128, threshold: i128 }` | `execute_withdrawal`, `withdraw` |
| **CircuitBreakerResetEvent** | `#[contractevent]` | `[Symbol("CircuitBreakerResetEvent")]` | `{ version: u32, ledger: u32 }` | `reset_circuit_breaker` |
| **upg_prop** | Raw tuple | `(EVENT_VERSION, Symbol("upg_prop"))` | `(BytesN<32>, u32)` | `propose_upgrade` |
| **upg_exec** | Raw tuple | `(EVENT_VERSION, Symbol("upg_exec"))` | `BytesN<32>` | `execute_upgrade` |
| **multisig_proposed** | Raw tuple | `(EVENT_VERSION, Symbol("multisig_proposed"))` | `u64` | `propose_multisig_action` |
| **multisig_approved** | Raw tuple | `(EVENT_VERSION, Symbol("multisig_approved"))` | `(u64, Address)` | `approve_multisig_action` |
| **multisig_executed** | Raw tuple | `(EVENT_VERSION, Symbol("multisig_executed"))` | `u64` | `execute_multisig_action` |

---

## 5. Golden Fixtures & Testing Integration

Golden fixtures are published in:
- `Dechat/stellar-contracts/fixtures/events/golden_events.json`
- `Dechat/dex_with_fiat_frontend/fixtures/events/golden_events.json`

The contract invariant test suite (`test_event_schema_compatibility.rs`) compares all emitted event topics and data structures against these fixtures. The frontend indexer tests parse the golden fixtures to guarantee schema compatibility across backend contract upgrades.
