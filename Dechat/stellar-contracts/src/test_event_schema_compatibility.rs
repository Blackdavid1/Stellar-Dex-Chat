#![cfg(test)]
use crate::{
    AdminActionExecutedEvent, AdminActionQueuedEvent, AdminRoleCheckEvent, AdminTransferEvent,
    BatchFailEvent, BatchOkEvent, CircuitBreakerAutoResetEvent, CircuitBreakerResetEvent,
    CircuitBreakerTrippedEvent, DenyAddressEvent, DenyRemovedEvent, DeployHashEvent, DepositEvent,
    EmergencyRecoverySetEvent, FeeAccruedEvent, FeeRecipientSetEvent, FeeVaultReconciledEvent,
    FeeWithdrawalBatchNonceEvent, FeeWithdrawnEvent, HeartbeatBatchEvent, HeartbeatBatchFailEvent,
    HeartbeatEvent, LimitMaxCapSetEvent, MigrationEvent, NonceConsumedEvent, OperatorPrunedEvent,
    PausedEvent, QuotaResetEvent, QuotaSetEvent, ReceiptIssuedEvent, RefundEvent,
    RemoveWithdrawOperatorEvent, RescueEvent, SetLimitEvent, SetMaxOperatorsEvent,
    SetMinDepositEvent, SetOperatorEvent, SetWithdrawOperatorEvent, SlippageEvent,
    SlippageThresholdSetEvent, UnpausedEvent, WithdrawEvent, WithdrawalCancelledEvent,
    WithdrawalExecutedEvent, WithdrawalExpiredEvent, WithdrawalQuotaConsumedEvent,
    WithdrawalRequestedEvent, EVENT_VERSION,
};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Symbol};

#[test]
fn test_event_version_constant_is_one() {
    assert_eq!(EVENT_VERSION, 1);
}

#[test]
fn test_core_events_version_field_matches_policy() {
    let env = Env::default();
    let addr1 = Address::generate(&env);
    let addr2 = Address::generate(&env);
    let dummy_hash = BytesN::from_array(&env, &[1u8; 32]);

    let dep = DepositEvent {
        version: EVENT_VERSION,
        from: addr1.clone(),
        token: addr2.clone(),
        amount: 1000,
        receipt_id: dummy_hash.clone(),
        by: addr1.clone(),
        ledger: 100,
    };
    assert_eq!(dep.version, 1);
    assert_eq!(dep.amount, 1000);
    assert_eq!(dep.ledger, 100);

    let rcpt = ReceiptIssuedEvent {
        version: EVENT_VERSION,
        receipt_id: dummy_hash.clone(),
        memo_hash: Some(dummy_hash.clone()),
    };
    assert_eq!(rcpt.version, 1);

    let wdr = WithdrawEvent {
        version: EVENT_VERSION,
        to: addr1.clone(),
        token: addr2.clone(),
        amount: 500,
        by: addr2.clone(),
        ledger: 101,
    };
    assert_eq!(wdr.version, 1);

    let req = WithdrawalRequestedEvent {
        version: EVENT_VERSION,
        to: addr1.clone(),
        request_id: 1,
        memo_hash: None,
    };
    assert_eq!(req.version, 1);
    assert_eq!(req.request_id, 1);

    let exec = WithdrawalExecutedEvent {
        version: EVENT_VERSION,
        request_id: 1,
        to: addr1.clone(),
        amount: 250,
        nonce: 10,
    };
    assert_eq!(exec.version, 1);
    assert_eq!(exec.nonce, 10);

    let cancel = WithdrawalCancelledEvent {
        version: EVENT_VERSION,
        request_id: 1,
    };
    assert_eq!(cancel.version, 1);

    let expired = WithdrawalExpiredEvent {
        version: EVENT_VERSION,
        request_id: 1,
        to: addr1.clone(),
        amount: 250,
        queued_ledger: 50,
    };
    assert_eq!(expired.version, 1);

    let fee = FeeAccruedEvent {
        version: EVENT_VERSION,
        token: addr2.clone(),
        amount: 10,
    };
    assert_eq!(fee.version, 1);

    let fee_wdr = FeeWithdrawnEvent {
        version: EVENT_VERSION,
        to: addr1.clone(),
        amount: 10,
        token: addr2.clone(),
    };
    assert_eq!(fee_wdr.version, 1);

    let refund = RefundEvent {
        version: EVENT_VERSION,
        receipt_id: dummy_hash.clone(),
        to: addr1.clone(),
        amount: 1000,
    };
    assert_eq!(refund.version, 1);

    let paused = PausedEvent {
        version: EVENT_VERSION,
        by: addr1.clone(),
    };
    assert_eq!(paused.version, 1);

    let unpaused = UnpausedEvent {
        version: EVENT_VERSION,
        by: addr1.clone(),
    };
    assert_eq!(unpaused.version, 1);

    let set_limit = SetLimitEvent {
        version: EVENT_VERSION,
        token: addr2.clone(),
        limit: 5000,
        by: addr1.clone(),
        ledger: 105,
    };
    assert_eq!(set_limit.version, 1);

    let set_op = SetOperatorEvent {
        version: EVENT_VERSION,
        operator: addr1.clone(),
        active: true,
        previous_active: false,
        operator_count: 1,
        by: addr2.clone(),
        ledger: 110,
    };
    assert_eq!(set_op.version, 1);

    let nonce_evt = NonceConsumedEvent {
        version: EVENT_VERSION,
        scope: Symbol::new(&env, "operator"),
        owner: addr1.clone(),
        new_nonce: 2,
    };
    assert_eq!(nonce_evt.version, 1);

    let migration = MigrationEvent {
        version: EVENT_VERSION,
        cursor: 10,
        migrated_count: 5,
    };
    assert_eq!(migration.version, 1);

    let cb_trip = CircuitBreakerTrippedEvent {
        version: EVENT_VERSION,
        new_total: 10000,
        threshold: 8000,
    };
    assert_eq!(cb_trip.version, 1);

    let cb_reset = CircuitBreakerResetEvent {
        version: EVENT_VERSION,
        ledger: 120,
    };
    assert_eq!(cb_reset.version, 1);
}

#[test]
fn test_administrative_and_governance_event_versions() {
    let env = Env::default();
    let addr1 = Address::generate(&env);
    let addr2 = Address::generate(&env);
    let dummy_hash = BytesN::from_array(&env, &[2u8; 32]);

    let deploy_hash = DeployHashEvent {
        version: EVENT_VERSION,
        config_hash: dummy_hash.clone(),
    };
    assert_eq!(deploy_hash.version, 1);

    let admin_tx = AdminTransferEvent {
        version: EVENT_VERSION,
        old_admin: addr1.clone(),
        new_admin: addr2.clone(),
    };
    assert_eq!(admin_tx.version, 1);

    let min_dep = SetMinDepositEvent {
        version: EVENT_VERSION,
        min: 100,
    };
    assert_eq!(min_dep.version, 1);

    let slip = SlippageEvent {
        version: EVENT_VERSION,
        slippage_bps: 50,
    };
    assert_eq!(slip.version, 1);

    let slip_thresh = SlippageThresholdSetEvent {
        version: EVENT_VERSION,
        threshold_bps: 100,
    };
    assert_eq!(slip_thresh.version, 1);

    let fee_recip = FeeRecipientSetEvent {
        version: EVENT_VERSION,
        old_recipient: None,
        new_recipient: Some(addr1.clone()),
    };
    assert_eq!(fee_recip.version, 1);

    let q_action = AdminActionQueuedEvent {
        version: EVENT_VERSION,
        action_type: Symbol::new(&env, "fee"),
        action_id: 1,
        target_ledger: 200,
    };
    assert_eq!(q_action.version, 1);

    let exec_action = AdminActionExecutedEvent {
        version: EVENT_VERSION,
        action_id: 1,
    };
    assert_eq!(exec_action.version, 1);

    let max_ops = SetMaxOperatorsEvent {
        version: EVENT_VERSION,
        previous: 5,
        max_operators: 10,
        active_operators: 3,
    };
    assert_eq!(max_ops.version, 1);

    let deny = DenyAddressEvent {
        version: EVENT_VERSION,
        address: addr1.clone(),
    };
    assert_eq!(deny.version, 1);

    let deny_rem = DenyRemovedEvent {
        version: EVENT_VERSION,
        address: addr1.clone(),
    };
    assert_eq!(deny_rem.version, 1);

    let hb = HeartbeatEvent {
        version: EVENT_VERSION,
        operator: addr1.clone(),
        ledger: 150,
    };
    assert_eq!(hb.version, 1);

    let hb_batch = HeartbeatBatchEvent {
        version: EVENT_VERSION,
        total_items: 10,
        success_count: 9,
        failure_count: 1,
        ledger: 151,
    };
    assert_eq!(hb_batch.version, 1);

    let hb_fail = HeartbeatBatchFailEvent {
        version: EVENT_VERSION,
        index: 4,
        total_items: 10,
    };
    assert_eq!(hb_fail.version, 1);

    let op_pruned = OperatorPrunedEvent {
        version: EVENT_VERSION,
        operator: addr1.clone(),
        ledger: 160,
    };
    assert_eq!(op_pruned.version, 1);

    let vault_rec = FeeVaultReconciledEvent {
        version: EVENT_VERSION,
        token: addr2.clone(),
        vault_ledger: 500,
        on_chain_balance: 500,
    };
    assert_eq!(vault_rec.version, 1);

    let role_chk = AdminRoleCheckEvent {
        version: EVENT_VERSION,
        admin: addr1.clone(),
        is_operator: false,
    };
    assert_eq!(role_chk.version, 1);

    let rescue = RescueEvent {
        version: EVENT_VERSION,
        token: addr2.clone(),
        to: addr1.clone(),
        amount: 1000,
    };
    assert_eq!(rescue.version, 1);

    let q_set = QuotaSetEvent {
        version: EVENT_VERSION,
        quota: 5000,
    };
    assert_eq!(q_set.version, 1);

    let q_reset = QuotaResetEvent {
        version: EVENT_VERSION,
        user: addr1.clone(),
        window_start: 100,
    };
    assert_eq!(q_reset.version, 1);

    let q_cons = WithdrawalQuotaConsumedEvent {
        version: EVENT_VERSION,
        user: addr1.clone(),
        amount: 500,
        total: 1000,
    };
    assert_eq!(q_cons.version, 1);

    let b_fail = BatchFailEvent {
        version: EVENT_VERSION,
        index: 2,
        total_ops: 5,
    };
    assert_eq!(b_fail.version, 1);

    let b_ok = BatchOkEvent {
        version: EVENT_VERSION,
        success_count: 4,
        failure_count: 1,
        total_ops: 5,
    };
    assert_eq!(b_ok.version, 1);

    let set_wdr_op = SetWithdrawOperatorEvent {
        version: EVENT_VERSION,
        operator: addr1.clone(),
    };
    assert_eq!(set_wdr_op.version, 1);

    let rem_wdr_op = RemoveWithdrawOperatorEvent {
        version: EVENT_VERSION,
    };
    assert_eq!(rem_wdr_op.version, 1);

    let emerg = EmergencyRecoverySetEvent {
        version: EVENT_VERSION,
        recovery: addr1.clone(),
        cap: 10000,
        admin: addr2.clone(),
    };
    assert_eq!(emerg.version, 1);

    let cb_auto = CircuitBreakerAutoResetEvent {
        version: EVENT_VERSION,
        tripped_at: 100,
        reset_at: 150,
    };
    assert_eq!(cb_auto.version, 1);

    let cap_set = LimitMaxCapSetEvent {
        version: EVENT_VERSION,
        cap: 20000,
    };
    assert_eq!(cap_set.version, 1);

    let batch_nonce = FeeWithdrawalBatchNonceEvent {
        version: EVENT_VERSION,
        caller: addr1.clone(),
        new_nonce: 3,
    };
    assert_eq!(batch_nonce.version, 1);
}
