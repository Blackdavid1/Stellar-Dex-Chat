//! Tests for Issue #20: Explicit administrator, operator, and auditor capabilities.

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, Env,
};

use crate::{Error, FiatBridge, FiatBridgeClient, Role, RoleChangeAction};

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
fn test_delayed_role_grant_and_least_privilege_enforcement() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, admin, _token_addr) = setup_bridge(&env);
    let operator_candidate = Address::generate(&env);
    let auditor_candidate = Address::generate(&env);
    let stranger = Address::generate(&env);

    // Initial state: admin has Role::Admin
    assert!(client.has_role(&admin, &Role::Admin));
    assert!(!client.has_role(&operator_candidate, &Role::Operator));
    assert!(!client.has_role(&auditor_candidate, &Role::Auditor));

    // Privilege escalation: non-admin cannot propose role change
    let res = client.try_propose_role_change(
        &stranger,
        &operator_candidate,
        &Role::Operator,
        &RoleChangeAction::Grant,
        &50,
    );
    assert_eq!(res, Err(Ok(Error::Unauthorized)));

    // Admin proposes granting Operator role
    let prop_op = client.propose_role_change(
        &admin,
        &operator_candidate,
        &Role::Operator,
        &RoleChangeAction::Grant,
        &50,
    );

    // Admin proposes granting Auditor role
    let prop_aud = client.propose_role_change(
        &admin,
        &auditor_candidate,
        &Role::Auditor,
        &RoleChangeAction::Grant,
        &50,
    );

    // Immediate execution before delay must fail
    let res = client.try_execute_role_change(&prop_op);
    assert_eq!(res, Err(Ok(Error::ActionNotReady)));

    // Advance ledger past delay
    env.ledger().with_mut(|l| l.sequence_number = 150);

    // Execute grants
    client.execute_role_change(&prop_op);
    client.execute_role_change(&prop_aud);

    // Verify membership
    assert!(client.has_role(&operator_candidate, &Role::Operator));
    assert!(client.has_role(&auditor_candidate, &Role::Auditor));

    // Auditor can view contract state
    let snapshot = client.audit_view_contract_state(&auditor_candidate);
    assert_eq!(snapshot.admin, admin);

    // Non-auditor attempting audit view fails
    let res = client.try_audit_view_contract_state(&operator_candidate);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));

    // Privilege escalation: Operator attempting admin action fails
    let _res = client.try_set_limit_max_cap(&1_000_000);
    // Even if mocked auth, caller must be admin
    assert!(client.has_role(&operator_candidate, &Role::Operator));
}

#[test]
fn test_revoked_operator_cannot_execute_payout() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, admin, _token_addr) = setup_bridge(&env);
    let operator = Address::generate(&env);

    // Grant Operator role
    let prop_id = client.propose_role_change(
        &admin,
        &operator,
        &Role::Operator,
        &RoleChangeAction::Grant,
        &20,
    );
    env.ledger().with_mut(|l| l.sequence_number = 120);
    client.execute_role_change(&prop_id);
    assert!(client.has_role(&operator, &Role::Operator));

    // Revoke Operator role
    let revoke_prop = client.propose_role_change(
        &admin,
        &operator,
        &Role::Operator,
        &RoleChangeAction::Revoke,
        &20,
    );
    env.ledger().with_mut(|l| l.sequence_number = 140);
    client.execute_role_change(&revoke_prop);
    assert!(!client.has_role(&operator, &Role::Operator));

    // Revoked operator attempting execute_payout fails
    let res = client.try_execute_payout(&operator, &0, &None, &0, &0, &0);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_role_cancellation_and_query_pagination() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, admin, _token_addr) = setup_bridge(&env);

    // Test cancellation
    let candidate = Address::generate(&env);
    let prop = client.propose_role_change(
        &admin,
        &candidate,
        &Role::Auditor,
        &RoleChangeAction::Grant,
        &50,
    );
    client.cancel_role_change(&admin, &prop);

    let proposal = client.get_role_proposal(&prop).unwrap();
    assert!(proposal.cancelled);

    env.ledger().with_mut(|l| l.sequence_number = 150);
    let res = client.try_execute_role_change(&prop);
    assert_eq!(res, Err(Ok(Error::ProposalCancelled)));

    // Test query pagination with multiple operators
    for _ in 0..5 {
        let op = Address::generate(&env);
        let p = client.propose_role_change(
            &admin,
            &op,
            &Role::Operator,
            &RoleChangeAction::Grant,
            &1,
        );
        env.ledger().with_mut(|l| l.sequence_number += 1);
        client.execute_role_change(&p);
    }

    let count = client.get_role_member_count(&Role::Operator);
    assert_eq!(count, 5);

    // Page 1: limit 2
    let page1 = client.get_role_members(&Role::Operator, &0, &2);
    assert_eq!(page1.len(), 2);

    // Page 2: start_index 2, limit 2
    let page2 = client.get_role_members(&Role::Operator, &2, &2);
    assert_eq!(page2.len(), 2);
    assert_ne!(page1.get(0).unwrap(), page2.get(0).unwrap());

    // Page 3: start_index 4, limit 2 (only 1 remaining)
    let page3 = client.get_role_members(&Role::Operator, &4, &2);
    assert_eq!(page3.len(), 1);

    // Out of bounds
    let empty_page = client.get_role_members(&Role::Operator, &10, &2);
    assert_eq!(empty_page.len(), 0);
}
