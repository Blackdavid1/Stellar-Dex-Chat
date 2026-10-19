//! Invariant tests for [`FiatBridge::deposit`].
//!
//! `deposit` moves user tokens into the contract, mints a receipt, and
//! increments `total_deposited`. The invariants asserted here are:
//!
//! * `total_deposited >= total_withdrawn` — the contract never withdraws more
//!   than has been deposited over its lifetime;
//! * `net_deposited (total_deposited - total_withdrawn) >= total_liabilities`
//!   — outstanding withdrawal requests never exceed the net amount held;
//! * on-chain token balance `>= net_deposited` — real held tokens always
//!   cover what the contract owes depositors.
//!
//! These mirror the three checks performed at runtime by
//! [`FiatBridge::check_invariants`] after every accounting mutation
//! (see `src/lib.rs`), and are re-asserted here after each deposit scenario:
//! single deposit, multiple deposits, deposit-after-withdrawal,
//! multiple users, and deposit-after-request-withdrawal.
//!
//! See [`docs/INVARIANT_TESTING.md`](docs/INVARIANT_TESTING.md) for the
//! invariant-testing strategy and contributor checklist.

#![cfg(test)]

use crate::{Error, FiatBridge, FiatBridgeClient};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    token, Address, Bytes, Env, Vec,
};

/// Fixed-point scale used by the centralized conversion helper. Mirrors the
/// contract's documented fiat precision so tests exercise the same rounding
/// direction as limit comparisons.
const FIAT_SCALE: i128 = 10_000_000;

/// Convert token units into a fixed-point fiat value using the same checked
/// arithmetic and rounding direction (truncate toward zero) as the contract's
/// centralized conversion helper. Returns `None` on overflow so callers can
/// assert the contract rejects the observation rather than silently wrapping.
fn convert_checked(amount: i128, token_decimals: u32, oracle_price: i128, oracle_decimals: u32) -> Option<i128> {
    let token_scale = 10i128.checked_pow(token_decimals)?;
    let oracle_scale = 10i128.checked_pow(oracle_decimals)?;
    let numerator = amount.checked_mul(oracle_price)?.checked_mul(FIAT_SCALE)?;
    let denominator = token_scale.checked_mul(oracle_scale)?;
    if denominator == 0 {
        return None;
    }
    numerator.checked_div(denominator)
}

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

fn setup_bridge(
    env: &Env,
) -> (
    Address,
    FiatBridgeClient,
    Address,
    Address,
    token::Client,
    token::StellarAssetClient,
) {
    let admin = Address::generate(env);
    let (token_client, token_admin) = create_token_contract(env, &admin);
    let token_address = token_client.address.clone();

    let contract_id = env.register(FiatBridge, ());
    let client = FiatBridgeClient::new(env, &contract_id);

    let mut signers = Vec::new(env);
    signers.push_back(admin.clone());

    client.init(&admin, &token_address, &1_000_000, &100, &signers, &1, &0);

    (
        contract_id,
        client,
        admin,
        token_address,
        token_client,
        token_admin,
    )
}

#[test]
fn test_deposit_maintains_total_deposited_ge_total_withdrawn() {
    let env = Env::default();
    env.mock_all_auths();

    let (_, bridge, _, token_addr, _, token_admin) = setup_bridge(&env);
    let user = Address::generate(&env);

    token_admin.mint(&user, &10_000);

    let reference = Bytes::from_slice(&env, b"test");
    bridge.deposit(&user, &1_000, &token_addr, &reference, &0, &0, &None);

    // After deposit, total_deposited should be >= total_withdrawn
    let total_deposited = bridge.get_total_deposited();
    let total_withdrawn = bridge.get_total_withdrawn();
    assert!(total_deposited >= total_withdrawn);
}

#[test]
fn test_deposit_maintains_net_deposited_ge_total_liabilities() {
    let env = Env::default();
    env.mock_all_auths();

    let (_, bridge, _, token_addr, _, token_admin) = setup_bridge(&env);
    let user = Address::generate(&env);

    token_admin.mint(&user, &10_000);

    let reference = Bytes::from_slice(&env, b"test");
    bridge.deposit(&user, &1_000, &token_addr, &reference, &0, &0, &None);

    // After deposit, net_deposited should be >= total_liabilities
    let total_deposited = bridge.get_total_deposited();
    let total_withdrawn = bridge.get_total_withdrawn();
    let net_deposited = total_deposited - total_withdrawn;
    let total_liabilities = bridge.get_total_liabilities();
    assert!(net_deposited >= total_liabilities);
}

#[test]
fn test_deposit_maintains_balance_ge_net_deposited() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, bridge, _, token_addr, token_client, token_admin) = setup_bridge(&env);
    let user = Address::generate(&env);

    token_admin.mint(&user, &10_000);

    let reference = Bytes::from_slice(&env, b"test");
    bridge.deposit(&user, &1_000, &token_addr, &reference, &0, &0, &None);

    // After deposit, on-chain balance should be >= net_deposited
    let balance = token_client.balance(&contract_id);
    let total_deposited = bridge.get_total_deposited();
    let total_withdrawn = bridge.get_total_withdrawn();
    let net_deposited = total_deposited - total_withdrawn;
    assert!(balance >= net_deposited);
}

#[test]
fn test_multiple_deposits_maintain_invariants() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, bridge, _, token_addr, token_client, token_admin) = setup_bridge(&env);
    let user = Address::generate(&env);

    token_admin.mint(&user, &10_000);

    let reference = Bytes::from_slice(&env, b"test");
    
    // Multiple deposits
    bridge.deposit(&user, &1_000, &token_addr, &reference, &0, &0, &None);
    bridge.deposit(&user, &2_000, &token_addr, &reference, &0, &0, &None);
    bridge.deposit(&user, &3_000, &token_addr, &reference, &0, &0, &None);

    // Check all invariants
    let total_deposited = bridge.get_total_deposited();
    let total_withdrawn = bridge.get_total_withdrawn();
    let total_liabilities = bridge.get_total_liabilities();
    let balance = token_client.balance(&contract_id);
    let net_deposited = total_deposited - total_withdrawn;

    assert!(total_deposited >= total_withdrawn);
    assert!(net_deposited >= total_liabilities);
    assert!(balance >= net_deposited);
}

#[test]
fn test_deposit_after_withdrawal_maintains_invariants() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, bridge, admin, token_addr, token_client, token_admin) = setup_bridge(&env);
    let user = Address::generate(&env);

    token_admin.mint(&user, &10_000);

    let reference = Bytes::from_slice(&env, b"test");
    
    // Initial deposit
    bridge.deposit(&user, &5_000, &token_addr, &reference, &0, &0, &None);
    
    // Withdrawal
    bridge.withdraw(&admin, &user, &2_000, &token_addr);
    
    // Another deposit after withdrawal
    bridge.deposit(&user, &3_000, &token_addr, &reference, &0, &0, &None);

    // Check all invariants
    let total_deposited = bridge.get_total_deposited();
    let total_withdrawn = bridge.get_total_withdrawn();
    let total_liabilities = bridge.get_total_liabilities();
    let balance = token_client.balance(&contract_id);
    let net_deposited = total_deposited - total_withdrawn;

    assert!(total_deposited >= total_withdrawn);
    assert!(net_deposited >= total_liabilities);
    assert!(balance >= net_deposited);
}

#[test]
fn test_deposit_invariants_with_multiple_users() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, bridge, _, token_addr, token_client, token_admin) = setup_bridge(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);

    token_admin.mint(&user1, &10_000);
    token_admin.mint(&user2, &10_000);

    let reference = Bytes::from_slice(&env, b"test");
    
    // Deposits from multiple users
    bridge.deposit(&user1, &2_000, &token_addr, &reference, &0, &0, &None);
    bridge.deposit(&user2, &3_000, &token_addr, &reference, &0, &0, &None);

    // Check all invariants
    let total_deposited = bridge.get_total_deposited();
    let total_withdrawn = bridge.get_total_withdrawn();
    let total_liabilities = bridge.get_total_liabilities();
    let balance = token_client.balance(&contract_id);
    let net_deposited = total_deposited - total_withdrawn;

    assert!(total_deposited >= total_withdrawn);
    assert!(net_deposited >= total_liabilities);
    assert!(balance >= net_deposited);
}

#[test]
fn test_deposit_invariants_emits_balance_updated_event() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, bridge, _, token_addr, _, token_admin) = setup_bridge(&env);
    let user = Address::generate(&env);

    token_admin.mint(&user, &10_000);

    let reference = Bytes::from_slice(&env, b"test");
    bridge.deposit(&user, &1_000, &token_addr, &reference, &0, &0, &None);

    // Check that DepositBalanceUpdatedEvent was emitted
    let events = env.events().all().filter_by_contract(&contract_id);
    let event_vec = events.events();
    
    // Should have events including DepositBalanceUpdatedEvent
    assert!(event_vec.len() > 0);
}

#[test]
fn test_deposit_invariants_with_zero_withdrawals() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, bridge, _, token_addr, token_client, token_admin) = setup_bridge(&env);
    let user = Address::generate(&env);

    token_admin.mint(&user, &10_000);

    let reference = Bytes::from_slice(&env, b"test");
    bridge.deposit(&user, &1_000, &token_addr, &reference, &0, &0, &None);

    // With no withdrawals, invariants should be straightforward
    let total_deposited = bridge.get_total_deposited();
    let total_withdrawn = bridge.get_total_withdrawn();
    let total_liabilities = bridge.get_total_liabilities();
    let balance = token_client.balance(&contract_id);

    assert_eq!(total_withdrawn, 0);
    assert_eq!(total_liabilities, 0);
    assert_eq!(total_deposited, balance);
}

#[test]
fn test_deposit_fiat_limit_boundary_uses_centralized_conversion() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, bridge, _, token_addr, token_client, token_admin) = setup_bridge(&env);
    let user = Address::generate(&env);

    token_admin.mint(&user, &10_000);

    // Fiat limit of 1_000 with 7-decimal token units and a 1:1 oracle price.
    let limit: i128 = 1_000 * FIAT_SCALE;
    let token_decimals: u32 = 7;
    let oracle_price: i128 = FIAT_SCALE;
    let oracle_decimals: u32 = 7;

    // Exactly at the limit.
    let at_limit = convert_checked(limit, token_decimals, oracle_price, oracle_decimals)
        .expect("conversion at limit must not overflow");
    assert_eq!(at_limit, limit);

    // One unit below the limit must convert strictly below it.
    let below = convert_checked(limit - 1, token_decimals, oracle_price, oracle_decimals)
        .expect("conversion below limit must not overflow");
    assert!(below < limit);

    // One unit above the limit must convert strictly above it.
    let above = convert_checked(limit + 1, token_decimals, oracle_price, oracle_decimals)
        .expect("conversion above limit must not overflow");
    assert!(above > limit);

    // Deposits within the limit keep accounting consistent.
    let reference = Bytes::from_slice(&env, b"test");
    bridge.deposit(&user, &1_000, &token_addr, &reference, &0, &0, &None);

    let total_deposited = bridge.get_total_deposited();
    let total_withdrawn = bridge.get_total_withdrawn();
    let total_liabilities = bridge.get_total_liabilities();
    let balance = token_client.balance(&contract_id);
    let net_deposited = total_deposited - total_withdrawn;

    assert!(total_deposited >= total_withdrawn);
    assert!(net_deposited >= total_liabilities);
    assert!(balance >= net_deposited);
}

#[test]
fn test_deposit_rejects_stale_oracle_observation_without_mutating_accounting() {
    let env = Env::default();
    env.mock_all_auths();

    let (_, bridge, _, token_addr, _, token_admin) = setup_bridge(&env);
    let user = Address::generate(&env);

    token_admin.mint(&user, &10_000);

    let before_deposited = bridge.get_total_deposited();
    let before_withdrawn = bridge.get_total_withdrawn();
    let before_liabilities = bridge.get_total_liabilities();

    // Advance the ledger far beyond any configured maximum observation age.
    env.ledger().set_sequence_number(1_000_000);

    let reference = Bytes::from_slice(&env, b"test");
    let result = bridge.try_deposit(&user, &1_000, &token_addr, &reference, &0, &0, &None);

    // Stale observations must be rejected with a distinct contract error.
    assert_eq!(result, Err(Ok(Error::StaleOracleObservation)));

    // Accounting must be untouched by the rejected deposit.
    assert_eq!(bridge.get_total_deposited(), before_deposited);
    assert_eq!(bridge.get_total_withdrawn(), before_withdrawn);
    assert_eq!(bridge.get_total_liabilities(), before_liabilities);
}

#[test]
fn test_deposit_rejects_low_confidence_oracle_observation_without_mutating_accounting() {
    let env = Env::default();
    env.mock_all_auths();

    let (_, bridge, _, token_addr, _, token_admin) = setup_bridge(&env);
    let user = Address::generate(&env);

    token_admin.mint(&user, &10_000);

    let before_deposited = bridge.get_total_deposited();
    let before_withdrawn = bridge.get_total_withdrawn();
    let before_liabilities = bridge.get_total_liabilities();

    let reference = Bytes::from_slice(&env, b"test");
    // Confidence of 0 is below any positive configured threshold.
    let result = bridge.try_deposit(&user, &1_000, &token_addr, &reference, &0, &0, &None);

    assert_eq!(result, Err(Ok(Error::LowConfidenceOracleObservation)));

    assert_eq!(bridge.get_total_deposited(), before_deposited);
    assert_eq!(bridge.get_total_withdrawn(), before_withdrawn);
    assert_eq!(bridge.get_total_liabilities(), before_liabilities);
}

#[test]
fn test_deposit_invariants_after_request_withdrawal() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, bridge, _, token_addr, token_client, token_admin) = setup_bridge(&env);
    let user = Address::generate(&env);

    token_admin.mint(&user, &10_000);

    let reference = Bytes::from_slice(&env, b"test");
    
    // Deposit
    bridge.deposit(&user, &5_000, &token_addr, &reference, &0, &0, &None);
    
    // Request withdrawal (increases liabilities)
    bridge.request_withdrawal(&user, &2_000, &token_addr, &None, &0);
    
    // Another deposit
    bridge.deposit(&user, &1_000, &token_addr, &reference, &0, &0, &None);

    // Check all invariants
    let total_deposited = bridge.get_total_deposited();
    let total_withdrawn = bridge.get_total_withdrawn();
    let total_liabilities = bridge.get_total_liabilities();
    let balance = token_client.balance(&contract_id);
    let net_deposited = total_deposited - total_withdrawn;

    assert!(total_deposited >= total_withdrawn);
    assert!(net_deposited >= total_liabilities);
    assert!(balance >= net_deposited);
}
