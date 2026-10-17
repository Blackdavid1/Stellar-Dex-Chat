#![cfg(test)]
extern crate std;
use crate::{
    DataKey, FiatBridge, FiatBridgeClient, Receipt, TokenConfig, WithdrawRequest,
    ESCROW_STORAGE_VERSION,
};
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env};
use std::string::String;

const EXPECTED_FIXTURE_CHECKSUM: &str =
    "1de036751ad3681e317c9e2e0f3969b8cf4d946c11d222b45f48a9e26569908d";

#[test]
fn test_fixture_checksum_integrity() {
    let fixture_bytes = include_bytes!("../fixtures/storage/v1_storage_fixture.json");
    let env = Env::default();
    let hash = env
        .crypto()
        .sha256(&soroban_sdk::Bytes::from_slice(&env, fixture_bytes));

    // Convert to hex string
    let hash_array = hash.to_array();
    let mut hex = String::with_capacity(64);
    for byte in hash_array.iter() {
        use core::fmt::Write;
        let _ = write!(hex, "{:02x}", byte);
    }

    assert_eq!(
        hex, EXPECTED_FIXTURE_CHECKSUM,
        "Storage fixture content has changed without updating reviewed checksum"
    );
}

fn load_fixture_state(
    env: &Env,
) -> (
    FiatBridgeClient<'_>,
    Address,
    Address,
    BytesN<32>,
    BytesN<32>,
) {
    let admin = Address::generate(env);
    let contract_address = env.register_stellar_asset_contract_v2(admin.clone());
    let token_admin = soroban_sdk::token::StellarAssetClient::new(env, &contract_address.address());
    let token_addr = contract_address.address();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(env, &contract_id);

    bridge.init(
        &admin,
        &token_addr,
        &5_000_000_000,
        &100,
        &soroban_sdk::vec![env, admin.clone()],
        &1,
        &0,
    );

    // Fund contract balance to back deposits
    token_admin.mint(&contract_id, &1_000_000_000);

    let receipt_id1 = BytesN::from_array(env, &[1u8; 32]);
    let receipt_id2 = BytesN::from_array(env, &[2u8; 32]);
    let user = Address::generate(env);

    // Set pre-upgrade storage layout reflecting fixture
    env.as_contract(&contract_id, || {
        // Ephemeral receipts stored before migration
        env.storage().persistent().set(
            &DataKey::Receipt(receipt_id1.clone()),
            &Receipt {
                id: receipt_id1.clone(),
                depositor: user.clone(),
                amount: 500_000_000,
                ledger: 100,
                reference: Bytes::new(env),
                memo_hash: None,
            },
        );
        env.storage()
            .temporary()
            .set(&DataKey::ReceiptIndex(0), &receipt_id1);

        env.storage().persistent().set(
            &DataKey::Receipt(receipt_id2.clone()),
            &Receipt {
                id: receipt_id2.clone(),
                depositor: user.clone(),
                amount: 500_000_000,
                ledger: 105,
                reference: Bytes::new(env),
                memo_hash: None,
            },
        );
        env.storage()
            .temporary()
            .set(&DataKey::ReceiptIndex(1), &receipt_id2);

        env.storage()
            .instance()
            .set(&DataKey::ReceiptCounter, &2u64);
        env.storage()
            .instance()
            .set(&DataKey::EscrowStorageVersion, &0u32);

        // Pre-upgrade withdrawal queue state
        env.storage().persistent().set(
            &DataKey::WithdrawQueue(1),
            &WithdrawRequest {
                to: user.clone(),
                token: token_addr.clone(),
                amount: 200_000_000,
                unlock_ledger: 110,
                memo_hash: None,
                queued_ledger: 100,
                risk_tier: 0,
            },
        );
        env.storage()
            .instance()
            .set(&DataKey::WithdrawQueueHead, &Some(1u64));
        env.storage()
            .instance()
            .set(&DataKey::WithdrawQueueLen, &1u64);

        // TokenConfig
        env.storage().persistent().set(
            &DataKey::TokenRegistry(token_addr.clone()),
            &TokenConfig {
                limit: 5_000_000_000,
                daily_deposit_limit: 5_000_000_000,
                total_deposited: 1_000_000_000,
                total_withdrawn: 300_000_000,
                total_liabilities: 200_000_000,
            },
        );
    });

    (bridge, admin, token_addr, receipt_id1, receipt_id2)
}

#[test]
fn test_successful_migration_and_equivalence() {
    let env = Env::default();
    env.mock_all_auths();
    let (bridge, _admin, token_addr, _r1, _r2) = load_fixture_state(&env);

    // Initial pre-migration checks
    assert_eq!(bridge.get_escrow_storage_version(), 0);
    assert_eq!(bridge.get_migration_cursor(), 0);
    assert_eq!(bridge.get_escrow_record(&0), None);

    // Run migration
    let migrated_count = bridge.migrate_escrow(&10);
    assert_eq!(migrated_count, 2);

    // Verify version and cursor updated
    assert_eq!(bridge.get_escrow_storage_version(), ESCROW_STORAGE_VERSION);
    assert_eq!(bridge.get_migration_cursor(), 2);

    // Verify migrated records exist and are equivalent
    let record0 = bridge.get_escrow_record(&0).expect("Record 0 must exist");
    assert_eq!(record0.amount, 500_000_000);
    assert_eq!(record0.ledger, 100);
    assert!(record0.migrated);

    let record1 = bridge.get_escrow_record(&1).expect("Record 1 must exist");
    assert_eq!(record1.amount, 500_000_000);
    assert_eq!(record1.ledger, 105);
    assert!(record1.migrated);

    // Verify balances and accounting remain equivalent
    let config = bridge.get_config_snapshot();
    assert_eq!(config.min_deposit, 100);
    assert_eq!(bridge.get_wq_depth(), 1);

    // Original receipt lookups remain functional
    assert!(bridge.get_receipt_by_index(&0).is_some());
    assert!(bridge.get_receipt_by_index(&1).is_some());

    // Queue request details remain intact
    let queued = bridge
        .get_withdrawal_request(&1)
        .expect("Queued request 1 must exist");
    assert_eq!(queued.amount, 200_000_000);
    assert_eq!(queued.token, token_addr);
}

#[test]
fn test_recovery_after_interrupted_upgrade() {
    let env = Env::default();
    env.mock_all_auths();
    let (bridge, _admin, _token_addr, _r1, _r2) = load_fixture_state(&env);

    // 1. First batch migrated partially (batch_size = 1)
    let batch1 = bridge.migrate_escrow(&1);
    assert_eq!(batch1, 1);
    assert_eq!(bridge.get_migration_cursor(), 1);
    assert_eq!(bridge.get_escrow_storage_version(), 0); // Not completed yet

    // Record 0 migrated, record 1 not yet
    assert!(bridge.get_escrow_record(&0).is_some());
    assert_eq!(bridge.get_escrow_record(&1), None);

    // 2. Recovery: Resume second batch (batch_size = 1)
    let batch2 = bridge.migrate_escrow(&1);
    assert_eq!(batch2, 1);
    assert_eq!(bridge.get_migration_cursor(), 2);
    assert_eq!(bridge.get_escrow_storage_version(), ESCROW_STORAGE_VERSION);

    // Both records now migrated
    assert!(bridge.get_escrow_record(&0).is_some());
    assert!(bridge.get_escrow_record(&1).is_some());
}

#[test]
fn test_unsupported_version_rejection() {
    let env = Env::default();
    env.mock_all_auths();
    let (bridge, _admin, _token_addr, _r1, _r2) = load_fixture_state(&env);

    // Simulate unsupported future schema version in storage
    env.as_contract(&bridge.address, || {
        env.storage()
            .instance()
            .set(&DataKey::EscrowStorageVersion, &999u32);
    });

    assert_eq!(bridge.get_escrow_storage_version(), 999);

    // Migration must reject if storage version is already at or beyond current supported version
    let result = bridge.try_migrate_escrow(&10);
    assert_eq!(result, Err(Ok(crate::Error::MigrationAlreadyComplete)));
}

#[test]
fn test_rollback_upgrade_proposal_preserves_state() {
    let env = Env::default();
    env.mock_all_auths();
    let (bridge, admin, _token_addr, _r1, _r2) = load_fixture_state(&env);

    let wasm_hash = BytesN::from_array(&env, &[9u8; 32]);
    bridge.propose_upgrade(&wasm_hash, &1000, &2);

    assert!(bridge.get_upgrade_proposal().is_some());

    // Cancel upgrade proposal
    bridge.cancel_upgrade(&0);
    assert_eq!(bridge.get_upgrade_proposal(), None);

    // Verify core storage and queues are preserved
    assert_eq!(bridge.get_wq_depth(), 1);
    let snapshot = bridge.get_config_snapshot();
    assert_eq!(snapshot.admin, admin);
}
