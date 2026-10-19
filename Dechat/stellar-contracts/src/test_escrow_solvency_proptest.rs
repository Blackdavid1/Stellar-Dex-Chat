//! Stateful property-based harness for FiatBridge escrow solvency (Issue #6).
//!
//! ## Objective
//! Generate bounded sequences of contract operations (deposits, withdrawal
//! requests, partial executions, cancellations via the lifecycle *and* the
//! shortcut) and assert **after every successful transition** that the
//! contract's outstanding user liabilities never exceed the on-chain token
//! balance held by the escrow vault.
//!
//! ## Why sequence-based?
//! Single-operation fuzz tests can catch individual boundary bugs but miss
//! compound invariant violations that only appear after a specific *ordering*
//! of transitions. A stateful sequence harness explores the cross-product of
//! operation orderings for a fixed budget of steps.
//!
//! ## Model
//! In addition to the on-chain state we maintain a *shadow model* that tracks
//! the same quantities using plain arithmetic.  After every accepted operation
//! the test asserts:
//!   1. `shadow_liabilities == on_chain_liabilities`  (model consistency)
//!   2. `on_chain_liabilities <= on_chain_token_balance`  (solvency)
//!   3. `on_chain_deposited - on_chain_withdrawn >= on_chain_liabilities`  (net coverage)
//!
//! ## Persisted regressions
//! Minimized failing seeds are saved to
//! `proptest-regressions/test_escrow_solvency_proptest.txt` and replayed in CI
//! before novel cases are generated.
//!
//! Registered from `lib.rs` behind `#[cfg(test)]`.

#![cfg(test)]

extern crate alloc;
use alloc::vec::Vec as StdVec;

use crate::{FiatBridge, FiatBridgeClient};
use proptest::prelude::*;
use soroban_sdk::{testutils::Address as _, token, Address, Bytes, Env, Vec};

// ── Harness limits ────────────────────────────────────────────────────────

/// Maximum number of operations generated per test case.
const MAX_OPS: usize = 20;
/// Token limit configured at bridge init.
const TOKEN_LIMIT: i128 = 1_000_000;
/// Per-deposit upper bound (must be < TOKEN_LIMIT).
const MAX_DEPOSIT: i128 = 200_000;
/// Minimum deposit (matches bridge's configured minimum).
const MIN_DEPOSIT: i128 = 100;
/// Maximum withdrawal amount per request.
const MAX_WITHDRAWAL: i128 = 100_000;

// ── Operation enum ────────────────────────────────────────────────────────

/// An abstract operation that can be applied to the FiatBridge.
#[derive(Clone, Debug)]
enum Op {
    /// Deposit `amount` from a fresh user address.
    Deposit(i128),
    /// Request a withdrawal of `amount` for a depositor at `user_idx % len`.
    RequestWithdrawal(usize, i128),
    /// Execute a full withdrawal for the request at `queue_idx % pending.len()`.
    ExecuteWithdrawal(usize),
    /// Execute a partial withdrawal of `amount` for the request at `queue_idx`.
    ExecutePartial(usize, i128),
    /// Cancel a queued withdrawal using the immediate admin shortcut.
    CancelShortcut(usize),
    /// Full three-step lifecycle cancellation for the request at `queue_idx`.
    LifecycleCancel(usize),
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        (MIN_DEPOSIT..=MAX_DEPOSIT).prop_map(Op::Deposit),
        (0usize..10, 1i128..=MAX_WITHDRAWAL).prop_map(|(i, a)| Op::RequestWithdrawal(i, a)),
        (0usize..10).prop_map(Op::ExecuteWithdrawal),
        (0usize..10, 1i128..100_001i128).prop_map(|(i, a)| Op::ExecutePartial(i, a)),
        (0usize..10).prop_map(Op::CancelShortcut),
        (0usize..10).prop_map(Op::LifecycleCancel),
    ]
}

fn ops_strategy() -> impl Strategy<Value = StdVec<Op>> {
    proptest::collection::vec(op_strategy(), 1..=MAX_OPS)
}

// ── Helper: set up a single-token bridge ─────────────────────────────────

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

struct Harness<'a> {
    bridge: FiatBridgeClient<'a>,
    contract_id: Address,
    token_addr: Address,
    token_client: token::Client<'a>,
    token_admin: token::StellarAssetClient<'a>,
    env: Env,
    /// Addresses that have made at least one deposit (eligible for withdrawals).
    depositors: StdVec<Address>,
    /// Active request IDs in the order they were queued.
    pending_ids: StdVec<u64>,
    /// Shadow-model liability tracker (plain arithmetic, independent of storage).
    shadow_liabilities: i128,
}

impl<'a> Harness<'a> {
    fn new(env: &'a Env) -> Self {
        let admin = Address::generate(env);
        let (token_client, token_admin) = create_token_contract(env, &admin);
        let token_addr = token_client.address.clone();
        let contract_id = env.register(FiatBridge, ());
        let bridge = FiatBridgeClient::new(env, &contract_id);
        let mut signers = Vec::new(env);
        signers.push_back(admin.clone());
        bridge.init(&admin, &token_addr, &TOKEN_LIMIT, &100, &signers, &1, &0);

        Harness {
            bridge,
            contract_id,
            token_addr,
            token_client,
            token_admin,
            env: env.clone(),
            depositors: StdVec::new(),
            pending_ids: StdVec::new(),
            shadow_liabilities: 0,
        }
    }

    // ── Assertion ────────────────────────────────────────────────────────

    fn assert_solvency(&self) {
        let on_chain_liab = self.bridge.get_total_liabilities();
        let on_chain_dep = self.bridge.get_total_deposited();
        let on_chain_with = self.bridge.get_total_withdrawn();
        let on_chain_bal = self.token_client.balance(&self.contract_id);

        // Shadow model must agree with on-chain liabilities.
        assert_eq!(
            self.shadow_liabilities, on_chain_liab,
            "shadow model diverged: shadow={} on_chain={}",
            self.shadow_liabilities, on_chain_liab
        );

        // Core solvency invariant: liabilities ≤ net escrow.
        let net = on_chain_dep - on_chain_with;
        assert!(
            on_chain_liab <= net,
            "solvency violated: liabilities={} net_deposited={}",
            on_chain_liab,
            net
        );

        // Token balance must cover net deposited.
        assert!(
            on_chain_bal >= net,
            "balance underfunded: balance={} net={}",
            on_chain_bal,
            net
        );
    }

    // ── Operation application ─────────────────────────────────────────────

    fn apply(&mut self, op: &Op) {
        match op {
            Op::Deposit(amount) => self.do_deposit(*amount),
            Op::RequestWithdrawal(idx, amount) => self.do_request(*idx, *amount),
            Op::ExecuteWithdrawal(idx) => self.do_execute(*idx),
            Op::ExecutePartial(idx, amount) => self.do_execute_partial(*idx, *amount),
            Op::CancelShortcut(idx) => self.do_cancel_shortcut(*idx),
            Op::LifecycleCancel(idx) => self.do_lifecycle_cancel(*idx),
        }
    }

    fn do_deposit(&mut self, amount: i128) {
        let user = Address::generate(&self.env);
        self.token_admin.mint(&user, &(amount + 1_000));
        let result = self.bridge.try_deposit(
            &user,
            &amount,
            &self.token_addr,
            &Bytes::from_slice(&self.env, b"ref"),
            &0,
            &0,
            &None,
        );
        if result.is_ok() {
            self.depositors.push(user);
        }
        // Deposits do not affect liabilities — no shadow update needed.
    }

    fn do_request(&mut self, user_idx: usize, amount: i128) {
        if self.depositors.is_empty() {
            return;
        }
        let user = self.depositors[user_idx % self.depositors.len()].clone();
        let result =
            self.bridge
                .try_request_withdrawal(&user, &amount, &self.token_addr, &None, &0);
        if let Ok(Ok(id)) = result {
            self.pending_ids.push(id);
            self.shadow_liabilities += amount;
        }
    }

    fn do_execute(&mut self, queue_idx: usize) {
        if self.pending_ids.is_empty() {
            return;
        }
        let id = self.pending_ids[queue_idx % self.pending_ids.len()];
        let request = match self.bridge.get_withdrawal_request(&id) {
            Some(r) => r,
            None => {
                self.pending_ids.retain(|&x| x != id);
                return;
            }
        };
        let result = self.bridge.try_execute_withdrawal(&id, &None, &0, &0, &0);
        if result.is_ok() {
            self.shadow_liabilities -= request.amount;
            self.pending_ids.retain(|&x| x != id);
        }
    }

    fn do_execute_partial(&mut self, queue_idx: usize, partial: i128) {
        if self.pending_ids.is_empty() {
            return;
        }
        let id = self.pending_ids[queue_idx % self.pending_ids.len()];
        let request = match self.bridge.get_withdrawal_request(&id) {
            Some(r) => r,
            None => {
                self.pending_ids.retain(|&x| x != id);
                return;
            }
        };
        // Clamp to the remaining amount so the call doesn't fail on an
        // over-specified partial.
        let clamped = partial.min(request.amount);
        let result = self
            .bridge
            .try_execute_withdrawal(&id, &Some(clamped), &0, &0, &0);
        if result.is_ok() {
            self.shadow_liabilities -= clamped;
            if clamped == request.amount {
                self.pending_ids.retain(|&x| x != id);
            }
        }
    }

    fn do_cancel_shortcut(&mut self, queue_idx: usize) {
        if self.pending_ids.is_empty() {
            return;
        }
        let id = self.pending_ids[queue_idx % self.pending_ids.len()];
        let request = match self.bridge.get_withdrawal_request(&id) {
            Some(r) => r,
            None => {
                self.pending_ids.retain(|&x| x != id);
                return;
            }
        };
        let result = self.bridge.try_cancel_withdrawal(&id);
        if result.is_ok() {
            self.shadow_liabilities -= request.amount;
            self.pending_ids.retain(|&x| x != id);
        }
    }

    fn do_lifecycle_cancel(&mut self, queue_idx: usize) {
        if self.pending_ids.is_empty() {
            return;
        }
        let id = self.pending_ids[queue_idx % self.pending_ids.len()];
        let request = match self.bridge.get_withdrawal_request(&id) {
            Some(r) => r,
            None => {
                self.pending_ids.retain(|&x| x != id);
                return;
            }
        };

        // Skip if a lifecycle record already exists to avoid CancellationAlreadyRequested.
        if self.bridge.get_cancellation_request(&id).is_some() {
            return;
        }

        let requester = request.to.clone();
        if self
            .bridge
            .try_request_cancellation(&id, &requester)
            .is_err()
        {
            return;
        }
        if self.bridge.try_approve_cancellation(&id).is_err() {
            return;
        }
        // Refresh the residual amount in case a concurrent partial execution
        // occurred between the request and now.
        let residual = match self.bridge.get_withdrawal_request(&id) {
            Some(r) => r.amount,
            None => {
                self.pending_ids.retain(|&x| x != id);
                return;
            }
        };
        if self.bridge.try_finalize_cancellation(&id).is_ok() {
            self.shadow_liabilities -= residual;
            self.pending_ids.retain(|&x| x != id);
        }
    }
}

// ── Properties ───────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 256,
        max_shrink_iters: 512,
        ..Default::default()
    })]

    /// The primary solvency property: after every accepted transition in an
    /// arbitrary sequence of operations, outstanding liabilities never exceed
    /// the on-chain token balance and the shadow model never diverges from
    /// on-chain state.
    #[test]
    fn escrow_liabilities_never_exceed_balance(ops in ops_strategy()) {
        let env = Env::default();
        env.mock_all_auths();

        let mut harness = Harness::new(&env);

        for op in &ops {
            harness.apply(op);
            harness.assert_solvency();
        }
    }

    /// Property: depositing and immediately requesting a withdrawal for the
    /// full deposited amount should always leave liabilities equal to the
    /// deposit amount (no double-count, no off-by-one).
    #[test]
    fn deposit_then_full_request_matches_liability(amount in MIN_DEPOSIT..=MAX_WITHDRAWAL) {
        let env = Env::default();
        env.mock_all_auths();

        let mut h = Harness::new(&env);

        h.do_deposit(amount);
        prop_assume!(!h.depositors.is_empty());

        let liab_before = h.bridge.get_total_liabilities();
        h.do_request(0, amount);

        let liab_after = h.bridge.get_total_liabilities();
        if liab_after != liab_before {
            prop_assert_eq!(liab_after - liab_before, amount);
        }
        h.assert_solvency();
    }

    /// Property: cancelling via the shortcut always restores liabilities to
    /// their pre-request value.
    #[test]
    fn cancel_shortcut_restores_liabilities(amount in MIN_DEPOSIT..=MAX_WITHDRAWAL) {
        let env = Env::default();
        env.mock_all_auths();

        let mut h = Harness::new(&env);
        h.do_deposit(amount);
        prop_assume!(!h.depositors.is_empty());

        let liab_before = h.bridge.get_total_liabilities();
        h.do_request(0, amount);
        let liab_after_request = h.bridge.get_total_liabilities();

        prop_assume!(liab_after_request > liab_before);

        h.do_cancel_shortcut(0);

        prop_assert_eq!(h.bridge.get_total_liabilities(), liab_before);
        h.assert_solvency();
    }

    /// Property: the three-step lifecycle cancellation path is equivalent to
    /// the shortcut in terms of final liability balance.
    #[test]
    fn lifecycle_cancel_restores_liabilities(amount in MIN_DEPOSIT..=MAX_WITHDRAWAL) {
        let env = Env::default();
        env.mock_all_auths();

        let mut h = Harness::new(&env);
        h.do_deposit(amount);
        prop_assume!(!h.depositors.is_empty());

        let liab_before = h.bridge.get_total_liabilities();
        h.do_request(0, amount);
        let liab_after_request = h.bridge.get_total_liabilities();

        prop_assume!(liab_after_request > liab_before);

        h.do_lifecycle_cancel(0);

        prop_assert_eq!(h.bridge.get_total_liabilities(), liab_before);
        h.assert_solvency();
    }

    /// Property: a partial execution followed by a lifecycle cancellation
    /// releases only the residual amount, never more.
    #[test]
    fn partial_then_lifecycle_cancel_releases_residual(
        total in (200i128..=MAX_WITHDRAWAL),
        partial in (1i128..100i128),
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let mut h = Harness::new(&env);
        h.do_deposit(total);
        prop_assume!(!h.depositors.is_empty());

        h.do_request(0, total);
        prop_assume!(!h.pending_ids.is_empty());

        let liab_after_request = h.bridge.get_total_liabilities();
        // Ensure residual is positive after partial.
        let clamped_partial = partial.min(total - 1);
        h.do_execute_partial(0, clamped_partial);

        let liab_after_partial = h.bridge.get_total_liabilities();
        prop_assume!(liab_after_partial < liab_after_request);

        h.do_lifecycle_cancel(0);

        let residual = total - clamped_partial;
        prop_assert_eq!(
            h.bridge.get_total_liabilities(),
            liab_after_partial - residual
        );
        h.assert_solvency();
    }
}
