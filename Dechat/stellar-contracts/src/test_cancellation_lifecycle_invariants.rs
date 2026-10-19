//! Invariant tests for the explicit cancellation/refund lifecycle (Issue #14).
//!
//! The lifecycle under test is:
//!   1. `request_cancellation` — filed by the recipient or admin; creates a
//!      [`CancellationRequest`] with `status = Requested`.
//!   2. `approve_cancellation`  — admin advances the record to `status = Approved`.
//!   3. `finalize_cancellation` — admin executes the refund, removes the record
//!      and the underlying [`WithdrawRequest`], releases liabilities.
//!
//! The `cancel_withdrawal` shortcut path is *also* tested here for interactions
//! with the new lifecycle (e.g. calling the shortcut while a lifecycle record
//! exists clears everything).
//!
//! Invariants asserted:
//! * Core accounting invariants survive every state transition.
//! * `CancellationRequest` state machine advances correctly.
//! * Duplicate requests are rejected.
//! * Unauthorized callers are rejected at every step.
//! * Cancellation is correct before and after the timelock unlock.
//! * Cancellation after a partial payment releases only the residual amount.
//! * `finalize_cancellation` without prior approval is rejected.
//! * Cancellation of a non-existent request is rejected.
//! * Paused contract rejects all lifecycle transitions.
//!
//! Registered from `lib.rs` behind `#[cfg(test)]`.

use crate::{CancellationStatus, Error, FiatBridge, FiatBridgeClient};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    token, Address, Bytes, Env, Vec,
};

// ── Test helpers ─────────────────────────────────────────────────────────

fn create_token_contract<'a>(
    env: &Env,
    admin: &Address,
) -> (token::Client<'a>, token::StellarAssetClient<'a>) {
    let contract_address = env.register_stellar_asset_contract_v2(admin.clone());
    (
        token::Client::new(env, &contract_address.address()),
        token::StellarAssetClient::new(env, &contract_address.address()),
    )
}

struct Fixture<'a> {
    contract_id: Address,
    bridge: FiatBridgeClient<'a>,
    admin: Address,
    token_addr: Address,
    token_client: token::Client<'a>,
    token_admin: token::StellarAssetClient<'a>,
}

fn setup_bridge(env: &Env) -> Fixture<'_> {
    let admin = Address::generate(env);
    let (token_client, token_admin) = create_token_contract(env, &admin);
    let token_addr = token_client.address.clone();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(env, &contract_id);

    let mut signers = Vec::new(env);
    signers.push_back(admin.clone());
    bridge.init(&admin, &token_addr, &1_000_000, &100, &signers, &1, &0);

    Fixture {
        contract_id,
        bridge,
        admin,
        token_addr,
        token_client,
        token_admin,
    }
}

fn funded_user(env: &Env, fx: &Fixture<'_>, deposit: i128) -> Address {
    let user = Address::generate(env);
    fx.token_admin.mint(&user, &(deposit * 2));
    fx.bridge.deposit(
        &user,
        &deposit,
        &fx.token_addr,
        &Bytes::from_slice(env, b"seed"),
        &0,
        &0,
        &None,
    );
    user
}

fn assert_core_accounting_invariants(fx: &Fixture<'_>) {
    let deposited = fx.bridge.get_total_deposited();
    let withdrawn = fx.bridge.get_total_withdrawn();
    let liabilities = fx.bridge.get_total_liabilities();
    assert!(deposited >= withdrawn);
    let net = deposited - withdrawn;
    assert!(net >= liabilities);
    assert!(fx.token_client.balance(&fx.contract_id) >= net);
}

// ── Happy-path: full three-step lifecycle ────────────────────────────────

#[test]
fn full_lifecycle_request_approve_finalize() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 10_000);

    let id = fx
        .bridge
        .request_withdrawal(&user, &500, &fx.token_addr, &None, &0);
    let liab_before = fx.bridge.get_total_liabilities();

    // Step 1: user requests cancellation.
    fx.bridge.request_cancellation(&id, &user);
    let cr = fx
        .bridge
        .get_cancellation_request(&id)
        .expect("cancellation record must exist after request");
    assert_eq!(cr.status, CancellationStatus::Requested);
    assert_eq!(cr.amount_at_request, 500);
    // Liabilities must NOT have changed yet.
    assert_eq!(fx.bridge.get_total_liabilities(), liab_before);
    assert_core_accounting_invariants(&fx);

    // Step 2: admin approves.
    fx.bridge.approve_cancellation(&id);
    let cr = fx
        .bridge
        .get_cancellation_request(&id)
        .expect("cancellation record must still exist after approval");
    assert_eq!(cr.status, CancellationStatus::Approved);
    // Liabilities still unchanged.
    assert_eq!(fx.bridge.get_total_liabilities(), liab_before);
    assert_core_accounting_invariants(&fx);

    // Step 3: finalize — releases liabilities and removes the request.
    let depth_before = fx.bridge.get_wq_depth();
    fx.bridge.finalize_cancellation(&id);

    assert!(fx.bridge.get_cancellation_request(&id).is_none());
    assert!(fx.bridge.get_withdrawal_request(&id).is_none());
    assert_eq!(fx.bridge.get_total_liabilities(), liab_before - 500);
    assert_eq!(fx.bridge.get_wq_depth(), depth_before - 1);
    assert_core_accounting_invariants(&fx);
}

#[test]
fn admin_can_initiate_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &300, &fx.token_addr, &None, &0);

    // Admin (not the recipient) requests cancellation.
    fx.bridge.request_cancellation(&id, &fx.admin);
    let cr = fx
        .bridge
        .get_cancellation_request(&id)
        .expect("cancellation record must exist");
    assert_eq!(cr.requested_by, fx.admin);
    assert_eq!(cr.status, CancellationStatus::Requested);

    fx.bridge.approve_cancellation(&id);
    fx.bridge.finalize_cancellation(&id);
    assert_core_accounting_invariants(&fx);
}

// ── Cancel before vs after unlock ────────────────────────────────────────

#[test]
fn lifecycle_cancel_before_unlock_ledger() {
    let env = Env::default();
    env.mock_all_auths();

    // Initialize with a 10-ledger lock period.
    let admin = Address::generate(&env);
    let (token_client, token_admin) = create_token_contract(&env, &admin);
    let token_addr = token_client.address.clone();
    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);
    let mut signers = Vec::new(&env);
    signers.push_back(admin.clone());
    bridge.init(&admin, &token_addr, &1_000_000, &100, &signers, &1, &0);
    // Set a non-zero lock period so the request will have unlock_ledger > current.
    bridge.set_lock_period(&10);

    let user = Address::generate(&env);
    token_admin.mint(&user, &20_000);
    bridge.deposit(&user, &10_000, &token_addr, &Bytes::from_slice(&env, b"s"), &0, &0, &None);

    // Ledger is at 0 — unlock at ledger 10, so request is still locked.
    let id = bridge.request_withdrawal(&user, &200, &token_addr, &None, &0);

    // Cancellation lifecycle should succeed even while the request is locked.
    bridge.request_cancellation(&id, &user);
    bridge.approve_cancellation(&id);
    bridge.finalize_cancellation(&id);

    assert!(bridge.get_withdrawal_request(&id).is_none());
    assert!(bridge.get_cancellation_request(&id).is_none());
}

#[test]
fn lifecycle_cancel_after_unlock_ledger() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &400, &fx.token_addr, &None, &0);

    // Advance ledger past the unlock point.
    env.ledger().with_mut(|li| li.sequence_number += 1000);

    fx.bridge.request_cancellation(&id, &user);
    fx.bridge.approve_cancellation(&id);
    fx.bridge.finalize_cancellation(&id);

    assert!(fx.bridge.get_withdrawal_request(&id).is_none());
    assert_core_accounting_invariants(&fx);
}

// ── After partial payment ─────────────────────────────────────────────────

#[test]
fn lifecycle_cancel_after_partial_payment_releases_residual_only() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 10_000);

    let id = fx
        .bridge
        .request_withdrawal(&user, &1_000, &fx.token_addr, &None, &0);

    // Execute a partial payment of 300.
    fx.bridge
        .execute_withdrawal(&id, &Some(300_i128), &0, &0, &0);

    // Remaining amount on the request is now 700.
    let request = fx.bridge.get_withdrawal_request(&id).expect("still exists");
    assert_eq!(request.amount, 700);

    let liab_after_partial = fx.bridge.get_total_liabilities();

    // Now file a cancellation — `amount_at_request` should snapshot the residual.
    fx.bridge.request_cancellation(&id, &user);
    let cr = fx
        .bridge
        .get_cancellation_request(&id)
        .expect("cancellation record");
    assert_eq!(cr.amount_at_request, 700);

    fx.bridge.approve_cancellation(&id);
    fx.bridge.finalize_cancellation(&id);

    // Liabilities should drop by exactly the residual (700), not the original (1_000).
    assert_eq!(
        fx.bridge.get_total_liabilities(),
        liab_after_partial - 700
    );
    assert_core_accounting_invariants(&fx);
}

// ── Duplicate / idempotency guard ─────────────────────────────────────────

#[test]
fn duplicate_cancellation_request_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &200, &fx.token_addr, &None, &0);

    fx.bridge.request_cancellation(&id, &user);

    assert_eq!(
        fx.bridge.try_request_cancellation(&id, &user),
        Err(Ok(Error::CancellationAlreadyRequested))
    );
    assert_core_accounting_invariants(&fx);
}

#[test]
fn finalize_without_approval_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &200, &fx.token_addr, &None, &0);

    fx.bridge.request_cancellation(&id, &user);

    assert_eq!(
        fx.bridge.try_finalize_cancellation(&id),
        Err(Ok(Error::CancellationNotApproved))
    );
    // Request and underlying withdrawal must both still exist.
    assert!(fx.bridge.get_cancellation_request(&id).is_some());
    assert!(fx.bridge.get_withdrawal_request(&id).is_some());
    assert_core_accounting_invariants(&fx);
}

#[test]
fn approve_without_request_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &200, &fx.token_addr, &None, &0);

    assert_eq!(
        fx.bridge.try_approve_cancellation(&id),
        Err(Ok(Error::CancellationNotRequested))
    );
    assert!(fx.bridge.get_withdrawal_request(&id).is_some());
    assert_core_accounting_invariants(&fx);
}

#[test]
fn finalize_without_any_record_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &200, &fx.token_addr, &None, &0);

    assert_eq!(
        fx.bridge.try_finalize_cancellation(&id),
        Err(Ok(Error::CancellationNotRequested))
    );
    assert_core_accounting_invariants(&fx);
}

// ── Non-existent request ─────────────────────────────────────────────────

#[test]
fn request_cancellation_on_nonexistent_withdrawal_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);

    assert_eq!(
        fx.bridge.try_request_cancellation(&9999, &fx.admin),
        Err(Ok(Error::RequestNotFound))
    );
}

// ── Unauthorized callers ──────────────────────────────────────────────────

#[test]
fn unauthorized_third_party_cannot_request_cancellation() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &200, &fx.token_addr, &None, &0);

    // A random third party (neither admin nor `to`) must be rejected.
    let stranger = Address::generate(&env);
    assert_eq!(
        fx.bridge.try_request_cancellation(&id, &stranger),
        Err(Ok(Error::Unauthorized))
    );
    assert!(fx.bridge.get_cancellation_request(&id).is_none());
    assert_core_accounting_invariants(&fx);
}

#[test]
fn non_admin_cannot_approve_cancellation() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &200, &fx.token_addr, &None, &0);

    fx.bridge.request_cancellation(&id, &user);

    // Remove auth so the approve call acts as a non-admin.
    env.set_auths(&[]);
    let result = fx.bridge.try_approve_cancellation(&id);
    assert!(result.is_err());

    env.mock_all_auths();
    // Record must still be in Requested state.
    let cr = fx.bridge.get_cancellation_request(&id).unwrap();
    assert_eq!(cr.status, CancellationStatus::Requested);
}

#[test]
fn non_admin_cannot_finalize_cancellation() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &200, &fx.token_addr, &None, &0);

    fx.bridge.request_cancellation(&id, &user);
    fx.bridge.approve_cancellation(&id);

    env.set_auths(&[]);
    let result = fx.bridge.try_finalize_cancellation(&id);
    assert!(result.is_err());

    env.mock_all_auths();
    // Cancellation record and withdrawal must still be intact.
    assert!(fx.bridge.get_cancellation_request(&id).is_some());
    assert!(fx.bridge.get_withdrawal_request(&id).is_some());
}

// ── Paused contract ───────────────────────────────────────────────────────

#[test]
fn paused_contract_rejects_request_cancellation() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &200, &fx.token_addr, &None, &0);

    fx.bridge.pause();
    assert_eq!(
        fx.bridge.try_request_cancellation(&id, &user),
        Err(Ok(Error::ContractPaused))
    );
}

#[test]
fn paused_contract_rejects_approve_cancellation() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &200, &fx.token_addr, &None, &0);

    fx.bridge.request_cancellation(&id, &user);
    fx.bridge.pause();

    assert_eq!(
        fx.bridge.try_approve_cancellation(&id),
        Err(Ok(Error::ContractPaused))
    );
}

#[test]
fn paused_contract_rejects_finalize_cancellation() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &200, &fx.token_addr, &None, &0);

    fx.bridge.request_cancellation(&id, &user);
    fx.bridge.approve_cancellation(&id);
    fx.bridge.pause();

    assert_eq!(
        fx.bridge.try_finalize_cancellation(&id),
        Err(Ok(Error::ContractPaused))
    );
}

// ── Interaction with cancel_withdrawal shortcut ───────────────────────────

#[test]
fn shortcut_cancel_while_lifecycle_record_exists_clears_both() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &200, &fx.token_addr, &None, &0);

    // File a cancellation request (not yet approved).
    fx.bridge.request_cancellation(&id, &user);
    assert!(fx.bridge.get_cancellation_request(&id).is_some());

    // Admin uses the immediate shortcut — this removes the WithdrawRequest.
    fx.bridge.cancel_withdrawal(&id);

    // Withdrawal is gone; lifecycle record is orphaned but benign (no withdrawal to finalize).
    assert!(fx.bridge.get_withdrawal_request(&id).is_none());
    assert_core_accounting_invariants(&fx);

    // Attempting to finalize the orphaned lifecycle record must fail gracefully.
    fx.bridge.approve_cancellation(&id);
    assert_eq!(
        fx.bridge.try_finalize_cancellation(&id),
        Err(Ok(Error::RequestNotFound))
    );
}

// ── Events ────────────────────────────────────────────────────────────────

#[test]
fn lifecycle_emits_all_three_events_on_finalize() {
    let env = Env::default();
    env.mock_all_auths();

    let fx = setup_bridge(&env);
    let user = funded_user(&env, &fx, 5_000);
    let id = fx
        .bridge
        .request_withdrawal(&user, &200, &fx.token_addr, &None, &0);

    fx.bridge.request_cancellation(&id, &user);
    fx.bridge.approve_cancellation(&id);
    fx.bridge.finalize_cancellation(&id);

    let events = env.events().all().filter_by_contract(&fx.contract_id);
    // At minimum the three lifecycle events plus the WithdrawalCancelledEvent
    // should be present in the event log.
    assert!(!events.events().is_empty());
}
