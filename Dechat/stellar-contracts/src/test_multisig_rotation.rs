//! Tests for Issue #19: Safe multisig signer and threshold rotation.

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, Bytes, Env, Symbol, Vec,
};

use crate::{Error, FiatBridge, FiatBridgeClient, BatchAdminOp};

fn setup_bridge(env: &Env) -> (FiatBridgeClient<'_>, Address, Address, Vec<Address>) {
    let contract_id = env.register(FiatBridge, ());
    let client = FiatBridgeClient::new(env, &contract_id);

    let admin = Address::generate(env);
    let token_admin = Address::generate(env);
    let token_addr = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();

    let s1 = Address::generate(env);
    let s2 = Address::generate(env);
    let s3 = Address::generate(env);
    let signers = vec![env, s1.clone(), s2.clone(), s3.clone()];

    // 2-of-3 multisig
    client.init(&admin, &token_addr, &10_000_000i128, &1i128, &signers, &2, &0);

    (client, admin, token_addr, signers)
}

#[test]
fn test_rotation_from_old_quorum_to_new_quorum_success() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, _admin, _token_addr, signers) = setup_bridge(&env);
    let s1 = signers.get(0).unwrap();
    let s2 = signers.get(1).unwrap();

    let new_s1 = Address::generate(&env);
    let new_s2 = Address::generate(&env);
    let new_s3 = Address::generate(&env);
    let new_signers = vec![&env, new_s1.clone(), new_s2.clone(), new_s3.clone()];
    let new_threshold = 2u32;
    let delay = 50u32;

    // s1 proposes rotation
    let proposal_id = client.propose_signer_rotation(&s1, &new_signers, &new_threshold, &delay);
    assert_eq!(proposal_id, 0);

    // Read-only proposal inspection
    let proposal = client.get_signer_rotation_proposal(&proposal_id).expect("proposal exists");
    assert_eq!(proposal.proposer, s1);
    assert_eq!(proposal.new_threshold, 2);
    assert_eq!(proposal.approvals.len(), 1);
    assert_eq!(proposal.approvals.get(0).unwrap(), s1);
    assert_eq!(proposal.eta, 150);
    assert!(!proposal.executed);
    assert!(!proposal.cancelled);

    // s2 approves rotation (reaching 2-of-3 threshold)
    client.approve_signer_rotation(&s2, &proposal_id);

    // Attempt to execute before delay -> fails with ActionNotReady
    let res = client.try_execute_signer_rotation(&proposal_id);
    assert_eq!(res, Err(Ok(Error::ActionNotReady)));

    // Advance ledger past delay
    env.ledger().with_mut(|l| l.sequence_number = 150);

    // Execution succeeds
    client.execute_signer_rotation(&proposal_id);

    // Verify current signers and threshold were rotated
    let current_signers = client.get_multisig_signers();
    assert_eq!(current_signers.len(), 3);
    assert_eq!(current_signers.get(0).unwrap(), new_s1);
    assert_eq!(current_signers.get(1).unwrap(), new_s2);
    assert_eq!(current_signers.get(2).unwrap(), new_s3);
    assert_eq!(client.get_multisig_threshold(), 2);

    // Proposal inspection shows executed
    let post_proposal = client.get_signer_rotation_proposal(&proposal_id).unwrap();
    assert!(post_proposal.executed);

    // Verify new quorum can now propose and execute multisig actions
    let action = BatchAdminOp {
        op_type: Symbol::new(&env, "set_cooldown"),
        payload: Bytes::from_slice(&env, &10u32.to_be_bytes()),
    };
    let ms_id = client.propose_multisig_action(&new_s1, &action);
    client.approve_multisig_action(&new_s2, &ms_id);
    client.execute_multisig_action(&ms_id);

    // Old signers can no longer propose or approve
    let old_res = client.try_propose_multisig_action(&s1, &action);
    assert_eq!(old_res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_rotation_validation_invalid_sets() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, _admin, _token_addr, signers) = setup_bridge(&env);
    let s1 = signers.get(0).unwrap();
    let stranger = Address::generate(&env);

    // 1. Non-signer cannot propose
    let res = client.try_propose_signer_rotation(&stranger, &signers, &2, &10);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));

    // 2. Empty signers set
    let empty_signers = vec![&env];
    let res = client.try_propose_signer_rotation(&s1, &empty_signers, &1, &10);
    assert_eq!(res, Err(Ok(Error::SignerNotFound)));

    // 3. Duplicate signers
    let dup_signers = vec![&env, s1.clone(), s1.clone()];
    let res = client.try_propose_signer_rotation(&s1, &dup_signers, &2, &10);
    assert_eq!(res, Err(Ok(Error::DuplicateSigner)));

    // 4. Threshold 0
    let new_s = vec![&env, Address::generate(&env)];
    let res = client.try_propose_signer_rotation(&s1, &new_s, &0, &10);
    assert_eq!(res, Err(Ok(Error::InvalidThreshold)));

    // 5. Threshold greater than signers count
    let res = client.try_propose_signer_rotation(&s1, &new_s, &2, &10);
    assert_eq!(res, Err(Ok(Error::InvalidThreshold)));

    // 6. Delay zero (must enforce delayed activation)
    let res = client.try_propose_signer_rotation(&s1, &new_s, &1, &0);
    assert_eq!(res, Err(Ok(Error::UpgradeDelayTooShort)));
}

#[test]
fn test_rotation_replay_protection() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, _admin, _token_addr, signers) = setup_bridge(&env);
    let s1 = signers.get(0).unwrap();
    let s2 = signers.get(1).unwrap();

    let new_signers = vec![&env, Address::generate(&env)];
    let proposal_id = client.propose_signer_rotation(&s1, &new_signers, &1, &10);
    client.approve_signer_rotation(&s2, &proposal_id);

    env.ledger().with_mut(|l| l.sequence_number = 115);
    client.execute_signer_rotation(&proposal_id);

    // Replay: executing again must fail
    let res = client.try_execute_signer_rotation(&proposal_id);
    assert_eq!(res, Err(Ok(Error::ProposalAlreadyExecuted)));
}

#[test]
fn test_rotation_cancellation() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, _admin, _token_addr, signers) = setup_bridge(&env);
    let s1 = signers.get(0).unwrap();
    let s2 = signers.get(1).unwrap();
    let stranger = Address::generate(&env);

    let new_signers = vec![&env, Address::generate(&env)];
    let proposal_id = client.propose_signer_rotation(&s1, &new_signers, &1, &10);

    // Stranger cannot cancel
    let res = client.try_cancel_signer_rotation(&stranger, &proposal_id);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));

    // Proposer can cancel
    client.cancel_signer_rotation(&s1, &proposal_id);

    let proposal = client.get_signer_rotation_proposal(&proposal_id).unwrap();
    assert!(proposal.cancelled);

    // Approving or executing cancelled proposal fails
    let res = client.try_approve_signer_rotation(&s2, &proposal_id);
    assert_eq!(res, Err(Ok(Error::ProposalCancelled)));

    env.ledger().with_mut(|l| l.sequence_number = 115);
    let res = client.try_execute_signer_rotation(&proposal_id);
    assert_eq!(res, Err(Ok(Error::ProposalCancelled)));
}

#[test]
fn test_loss_of_quorum_prevention() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, _admin, _token_addr, signers) = setup_bridge(&env);
    let s1 = signers.get(0).unwrap();

    let new_signers = vec![&env, Address::generate(&env)];
    let proposal_id = client.propose_signer_rotation(&s1, &new_signers, &1, &10);

    env.ledger().with_mut(|l| l.sequence_number = 120);

    // Only s1 approved (1 approval, current threshold is 2)
    let res = client.try_execute_signer_rotation(&proposal_id);
    assert_eq!(res, Err(Ok(Error::ThresholdNotMet)));
}
