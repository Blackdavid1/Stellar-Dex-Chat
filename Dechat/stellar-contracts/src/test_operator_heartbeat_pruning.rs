//! Tests for Issue #21: Bounded operator heartbeat and maintenance state.

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, Env,
};

use crate::{FiatBridge, FiatBridgeClient};

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
fn test_nonce_storage_key_isolation() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, _admin, _token_addr) = setup_bridge(&env);
    let op = Address::generate(&env);

    // Initial operator config: config nonce is 0
    assert_eq!(client.get_operator_config_nonce(&op), 0);
    assert_eq!(client.get_operator_nonce(&op), 0);

    // Admin sets operator active using config nonce 0
    client.set_operator(&op, &true, &0);
    assert_eq!(client.get_operator_config_nonce(&op), 1);
    // Heartbeat nonce MUST NOT have changed: still 0
    assert_eq!(client.get_operator_nonce(&op), 0);

    // Operator sends heartbeat with heartbeat nonce 0 -> succeeds!
    client.heartbeat(&op, &0);
    assert_eq!(client.get_operator_nonce(&op), 1);
    // Config nonce MUST NOT have changed: still 1
    assert_eq!(client.get_operator_config_nonce(&op), 1);

    // Operator sends second heartbeat with heartbeat nonce 1 -> succeeds!
    client.heartbeat(&op, &1);
    assert_eq!(client.get_operator_nonce(&op), 2);
    assert_eq!(client.get_operator_config_nonce(&op), 1);

    // Admin updates operator config with config nonce 1 -> succeeds!
    client.set_operator(&op, &false, &1);
    assert_eq!(client.get_operator_config_nonce(&op), 2);
    // Heartbeat nonce untouched: still 2
    assert_eq!(client.get_operator_nonce(&op), 2);
}

#[test]
fn test_initial_heartbeat_and_never_active_pruning_rule() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, _admin, _token_addr) = setup_bridge(&env);
    let active_op = Address::generate(&env);
    let never_active_op = Address::generate(&env);

    client.set_operator(&active_op, &true, &0);
    client.set_operator(&never_active_op, &true, &0);

    // Both operators start with initial heartbeat set to registration ledger 100
    assert_eq!(client.get_operator_heartbeat(&active_op), Some(100));
    assert_eq!(client.get_operator_heartbeat(&never_active_op), Some(100));

    // active_op sends heartbeat at ledger 1000
    env.ledger().with_mut(|l| l.sequence_number = 1000);
    client.heartbeat(&active_op, &0);
    assert_eq!(client.get_operator_heartbeat(&active_op), Some(1000));

    // Advance beyond inactivity threshold for never_active_op, but not active_op.
    // Default threshold is 1_555_200 ledgers (~3 months).
    // never_active_op last activity: 100 -> inactive when ledger > 1_555_300.
    // active_op last activity: 1000 -> inactive when ledger > 1_556_200.
    // Set ledger to 1_555_500:
    env.ledger().with_mut(|l| l.sequence_number = 1_555_500);

    let batch_res = client.prune_inactive_operators_bounded(&10);
    assert_eq!(batch_res.pruned, 1);
    assert_eq!(client.is_operator(&never_active_op), false);
    assert_eq!(client.is_operator(&active_op), true);
}

#[test]
fn test_bounded_pruning_with_resumable_cursor() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, _admin, _token_addr) = setup_bridge(&env);

    // Register 6 operators
    let mut ops = vec![&env];
    for _ in 0..6 {
        let op = Address::generate(&env);
        client.set_operator(&op, &true, &0);
        ops.push_back(op);
    }

    // Advance ledger beyond inactivity threshold (1_555_200 ledgers) so all 6 are inactive
    env.ledger().with_mut(|l| l.sequence_number = 2_000_000);

    // Initial prune cursor is 0
    assert_eq!(client.get_operator_prune_cursor(), 0);

    // Process batch 1: batch_size = 2
    let res1 = client.prune_inactive_operators_bounded(&2);
    assert_eq!(res1.processed, 2);
    assert_eq!(res1.pruned, 2);
    assert_eq!(res1.next_cursor, 2);
    assert!(!res1.is_complete);
    assert_eq!(client.get_operator_prune_cursor(), 2);

    // Process batch 2: batch_size = 2
    let res2 = client.prune_inactive_operators_bounded(&2);
    assert_eq!(res2.processed, 2);
    assert_eq!(res2.pruned, 2);
    assert_eq!(res2.next_cursor, 4);
    assert!(!res2.is_complete);
    assert_eq!(client.get_operator_prune_cursor(), 4);

    // Process batch 3: batch_size = 3 (remaining 2)
    let res3 = client.prune_inactive_operators_bounded(&3);
    assert_eq!(res3.processed, 2);
    assert_eq!(res3.pruned, 2);
    assert_eq!(res3.next_cursor, 0); // wrapped to 0
    assert!(res3.is_complete);
    assert_eq!(client.get_operator_prune_cursor(), 0);

    // All operators should now be inactive
    for op in ops.iter() {
        assert_eq!(client.is_operator(&op), false);
    }

    // Running on empty/all-pruned set succeeds gracefully
    let res_empty = client.prune_inactive_operators_bounded(&5);
    assert_eq!(res_empty.processed, 0);
    assert_eq!(res_empty.pruned, 0);
    assert!(res_empty.is_complete);
}
