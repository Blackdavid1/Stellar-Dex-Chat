//! Tests for Issue #22: Ledger-window rate limits on deposits and withdrawals.

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    vec, Address, Bytes, Env, Symbol,
};

use crate::{Error, FiatBridge, FiatBridgeClient};

fn setup_bridge(env: &Env) -> (FiatBridgeClient<'_>, Address, Address) {
    let contract_id = env.register(FiatBridge, ());
    let client = FiatBridgeClient::new(env, &contract_id);

    let admin = Address::generate(env);
    let token_admin = Address::generate(env);
    let token_addr = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();

    let signers = vec![env, admin.clone()];
    client.init(&admin, &token_addr, &10_000_000i128, &1i128, &signers, &1, &0);

    (client, admin, token_addr)
}

#[test]
fn test_deposit_rate_limit_capacity_and_capacity_plus_one() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, _admin, token_addr) = setup_bridge(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let user3 = Address::generate(&env);

    StellarAssetClient::new(&env, &token_addr).mint(&user1, &100_000);
    StellarAssetClient::new(&env, &token_addr).mint(&user2, &100_000);
    StellarAssetClient::new(&env, &token_addr).mint(&user3, &100_000);

    // Set per-ledger deposit rate limit = 2
    client.set_deposit_rate_limit(&2);
    assert_eq!(client.get_rate_limit(&Symbol::new(&env, "deposit")), 2);

    let ref_bytes = Bytes::from_slice(&env, b"ref1");

    // Deposit 1 (exact capacity item 1)
    client.deposit(&user1, &100, &token_addr, &ref_bytes, &0, &0, &None);
    let usage1 = client.get_rate_limit_usage(&Symbol::new(&env, "deposit"));
    assert_eq!(usage1.current_count, 1);
    assert_eq!(usage1.limit, 2);

    // Deposit 2 (exact capacity item 2, different user - cannot be bypassed by caller switching!)
    client.deposit(&user2, &100, &token_addr, &ref_bytes, &0, &0, &None);
    let usage2 = client.get_rate_limit_usage(&Symbol::new(&env, "deposit"));
    assert_eq!(usage2.current_count, 2);

    // Deposit 3 (capacity plus one) -> MUST FAIL with DepositRateLimitExceeded
    let res = client.try_deposit(&user3, &100, &token_addr, &ref_bytes, &0, &0, &None);
    assert_eq!(res, Err(Ok(Error::DepositRateLimitExceeded)));

    // Structured retry timing exposed
    let timing = client.get_rate_limit_retry_timing(&Symbol::new(&env, "deposit")).expect("retry timing");
    assert_eq!(timing.current_ledger, 100);
    assert_eq!(timing.retry_after_ledger, 101);
    assert_eq!(timing.wait_ledgers, 1);
    assert_eq!(timing.current_count, 2);
    assert_eq!(timing.limit, 2);
}

#[test]
fn test_ledger_rollover_resets_rate_limit() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 200);

    let (client, _admin, token_addr) = setup_bridge(&env);
    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token_addr).mint(&user, &100_000);

    client.set_deposit_rate_limit(&1);
    let ref_bytes = Bytes::from_slice(&env, b"ref");

    // Fill capacity at ledger 200
    client.deposit(&user, &100, &token_addr, &ref_bytes, &0, &0, &None);

    // Further deposit at 200 blocked
    let res = client.try_deposit(&user, &100, &token_addr, &ref_bytes, &0, &0, &None);
    assert_eq!(res, Err(Ok(Error::DepositRateLimitExceeded)));

    // Rollover to ledger 201
    env.ledger().with_mut(|l| l.sequence_number = 201);

    // Usage before call at new ledger shows 0 count
    let usage = client.get_rate_limit_usage(&Symbol::new(&env, "deposit"));
    assert_eq!(usage.current_count, 0);

    // Deposit succeeds immediately on new ledger
    client.deposit(&user, &100, &token_addr, &ref_bytes, &0, &0, &None);
}

#[test]
fn test_withdrawal_request_and_execution_rate_limits() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 300);

    let (client, _admin, token_addr) = setup_bridge(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    // Mint tokens to users and deposit to establish deposited balances
    StellarAssetClient::new(&env, &token_addr).mint(&recipient1, &1000);
    StellarAssetClient::new(&env, &token_addr).mint(&recipient2, &1000);
    let ref_bytes = Bytes::from_slice(&env, b"ref");
    client.deposit(&recipient1, &500, &token_addr, &ref_bytes, &0, &0, &None);
    client.deposit(&recipient2, &500, &token_addr, &ref_bytes, &0, &0, &None);

    // Configure separate limits for withdrawal requests and executions
    client.set_withdraw_req_rate_limit(&1);
    client.set_withdraw_exec_rate_limit(&1);

    // Request 1 succeeds
    let req_id1 = client.request_withdrawal(&recipient1, &50, &token_addr, &None, &0);
    assert_eq!(req_id1, 0);

    // Request 2 in same ledger fails with RateLimitExceeded
    let res = client.try_request_withdrawal(&recipient2, &50, &token_addr, &None, &0);
    assert_eq!(res, Err(Ok(Error::RateLimitExceeded)));

    // Advance ledger to 301
    env.ledger().with_mut(|l| l.sequence_number = 301);
    let req_id2 = client.request_withdrawal(&recipient2, &50, &token_addr, &None, &0);
    assert_eq!(req_id2, 1);

    // Execution 1 succeeds
    client.execute_withdrawal(&req_id1, &None, &0, &0, &0);

    // Execution 2 in same ledger fails with RateLimitExceeded
    let res = client.try_execute_withdrawal(&req_id2, &None, &0, &0, &0);
    assert_eq!(res, Err(Ok(Error::RateLimitExceeded)));

    // Advance ledger to 302
    env.ledger().with_mut(|l| l.sequence_number = 302);
    // Execution 2 now succeeds
    client.execute_withdrawal(&req_id2, &None, &0, &0, &0);
}

#[test]
fn test_rate_limit_disabled_and_boundaries() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 400);

    let (client, _admin, token_addr) = setup_bridge(&env);
    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token_addr).mint(&user, &100_000);

    // Setting limit to 0 disables it
    client.set_deposit_rate_limit(&0);
    let ref_bytes = Bytes::from_slice(&env, b"ref");

    for _ in 0..5 {
        client.deposit(&user, &100, &token_addr, &ref_bytes, &0, &0, &None);
    }

    // When limit is 0 (or not reached), retry timing is None
    let timing = client.get_rate_limit_retry_timing(&Symbol::new(&env, "deposit"));
    assert_eq!(timing, None);
}
