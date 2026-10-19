#[cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, Env,
};

#[test]
fn test_set_migration_cursor_rejects_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject zero cursor
    let result = bridge.try_set_migration_cursor(&0);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_set_migration_cursor_rejects_negative() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject negative cursor
    let result = bridge.try_set_migration_cursor(&-1);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_set_migration_cursor_rejects_i128_max() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject i128::MAX
    let result = bridge.try_set_migration_cursor(&i128::MAX);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_set_migration_cursor_accepts_valid_value() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should accept valid cursor value
    bridge.set_migration_cursor(&100);
    assert_eq!(bridge.get_migration_cursor(), 100);
}

#[test]
fn test_set_migration_cursor_fence_post() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Test fence post: exactly at boundary (1 should be accepted)
    bridge.set_migration_cursor(&1);
    assert_eq!(bridge.get_migration_cursor(), 1);
}

#[test]
fn test_set_oracle_rejects_self_referential_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject setting oracle to admin address
    let result = bridge.try_set_oracle(&admin);
    assert_eq!(result, Err(Ok(Error::SelfReferentialAddress)));
}

#[test]
fn test_set_oracle_rejects_self_referential_contract() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject setting oracle to contract address
    let result = bridge.try_set_oracle(&contract_id);
    assert_eq!(result, Err(Ok(Error::SelfReferentialAddress)));
}

#[test]
fn test_set_oracle_accepts_valid_address() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let oracle = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should accept valid oracle address
    bridge.set_oracle(&oracle);
    let config = bridge.get_config_snapshot();
    assert_eq!(config.oracle, Some(oracle));
}

#[test]
fn test_set_anti_sandwich_delay_rejects_u32_max() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject u32::MAX
    let result = bridge.try_set_anti_sandwich_delay(&u32::MAX);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_set_anti_sandwich_delay_accepts_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should accept zero (disables the protection)
    bridge.set_anti_sandwich_delay(&0);
    assert_eq!(bridge.get_anti_sandwich_delay(), 0);
}

#[test]
fn test_set_anti_sandwich_delay_accepts_valid_value() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should accept valid value
    bridge.set_anti_sandwich_delay(&100);
    assert_eq!(bridge.get_anti_sandwich_delay(), 100);
}

#[test]
fn test_set_anti_sandwich_delay_fence_post() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Test fence post: u32::MAX - 1 should be accepted
    bridge.set_anti_sandwich_delay(&(u32::MAX - 1));
    assert_eq!(bridge.get_anti_sandwich_delay(), u32::MAX - 1);
}

#[test]
fn test_set_slippage_threshold_rejects_u32_max() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject u32::MAX
    let result = bridge.try_set_slippage_threshold(&u32::MAX);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_set_slippage_threshold_rejects_exceeds_10000() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject threshold > 10000 (100%)
    let result = bridge.try_set_slippage_threshold(&10001);
    assert_eq!(result, Err(Ok(Error::SlippageTooHigh)));
}

#[test]
fn test_set_slippage_threshold_accepts_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should accept zero
    bridge.set_slippage_threshold(&0);
    assert_eq!(bridge.get_slippage_threshold(), 0);
}

#[test]
fn test_set_slippage_threshold_accepts_valid_value() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should accept valid value
    bridge.set_slippage_threshold(&500); // 5%
    assert_eq!(bridge.get_slippage_threshold(), 500);
}

#[test]
fn test_set_slippage_threshold_fence_post() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Test fence post: exactly at boundary (10000 should be accepted)
    bridge.set_slippage_threshold(&10000); // 100%
    assert_eq!(bridge.get_slippage_threshold(), 10000);
}

#[test]
fn test_set_slippage_threshold_fence_post_boundary() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Test fence post: 10001 should be rejected (just over boundary)
    let result = bridge.try_set_slippage_threshold(&10001);
    assert_eq!(result, Err(Ok(Error::SlippageTooHigh)));
}

#[test]
fn test_set_fiat_limit_rejects_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject zero
    let result = bridge.try_set_fiat_limit(&0);
    assert_eq!(result, Err(Ok(Error::ZeroAmount)));
}

#[test]
fn test_set_fiat_limit_rejects_negative() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject negative
    let result = bridge.try_set_fiat_limit(&-1);
    assert_eq!(result, Err(Ok(Error::ZeroAmount)));
}

#[test]
fn test_set_fiat_limit_rejects_i128_max() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject i128::MAX
    let result = bridge.try_set_fiat_limit(&i128::MAX);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_set_fiat_limit_accepts_valid_value() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should accept valid value
    bridge.set_fiat_limit(&100_000);
    assert_eq!(bridge.get_fiat_limit(), Some(100_000));
}

#[test]
fn test_set_fiat_limit_fence_post() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Test fence post: i128::MAX - 1 should be accepted
    bridge.set_fiat_limit(&(i128::MAX - 1));
    assert_eq!(bridge.get_fiat_limit(), Some(i128::MAX - 1));
}

#[test]
fn test_set_cooldown_rejects_u32_max() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject u32::MAX
    let result = bridge.try_set_cooldown(&u32::MAX);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_set_cooldown_accepts_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should accept zero (disables cooldown)
    bridge.set_cooldown(&0);
    assert_eq!(bridge.get_cooldown(), 0);
}

#[test]
fn test_set_cooldown_accepts_valid_value() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should accept valid value
    bridge.set_cooldown(&100);
    assert_eq!(bridge.get_cooldown(), 100);
}

#[test]
fn test_set_cooldown_fence_post() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Test fence post: u32::MAX - 1 should be accepted
    bridge.set_cooldown(&(u32::MAX - 1));
    assert_eq!(bridge.get_cooldown(), u32::MAX - 1);
}

#[test]
fn test_set_withdrawal_cooldown_rejects_u32_max_ledgers() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject u32::MAX for ledgers
    let result = bridge.try_set_withdrawal_cooldown(&u32::MAX, &1000);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_set_withdrawal_cooldown_rejects_negative_threshold() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject negative threshold
    let result = bridge.try_set_withdrawal_cooldown(&100, &-1);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_set_withdrawal_cooldown_rejects_i128_max_threshold() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should reject i128::MAX for threshold
    let result = bridge.try_set_withdrawal_cooldown(&100, &i128::MAX);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_set_withdrawal_cooldown_accepts_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should accept zero (disables the guard)
    bridge.set_withdrawal_cooldown(&0, &0);
    assert_eq!(bridge.get_withdrawal_cooldown_ledgers(), 0);
    assert_eq!(bridge.get_withdrawal_cooldown_threshold(), 0);
}

#[test]
fn test_set_withdrawal_cooldown_accepts_valid_values() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Should accept valid values
    bridge.set_withdrawal_cooldown(&100, &5000);
    assert_eq!(bridge.get_withdrawal_cooldown_ledgers(), 100);
    assert_eq!(bridge.get_withdrawal_cooldown_threshold(), 5000);
}

#[test]
fn test_set_withdrawal_cooldown_fence_post_ledgers() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Test fence post: u32::MAX - 1 should be accepted for ledgers
    bridge.set_withdrawal_cooldown(&(u32::MAX - 1), &1000);
    assert_eq!(bridge.get_withdrawal_cooldown_ledgers(), u32::MAX - 1);
}

#[test]
fn test_set_withdrawal_cooldown_fence_post_threshold() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Test fence post: i128::MAX - 1 should be accepted for threshold
    bridge.set_withdrawal_cooldown(&100, &(i128::MAX - 1));
    assert_eq!(bridge.get_withdrawal_cooldown_threshold(), i128::MAX - 1);
}

#[test]
fn test_set_oracle_decimals_accepts_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // Zero decimals is a valid oracle precision.
    bridge.set_oracle_decimals(&0);
    assert_eq!(bridge.get_oracle_decimals(), 0);
}

#[test]
fn test_set_oracle_decimals_accepts_max_supported() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // The maximum supported oracle precision must be accepted.
    bridge.set_oracle_decimals(&MAX_SUPPORTED_DECIMALS);
    assert_eq!(bridge.get_oracle_decimals(), MAX_SUPPORTED_DECIMALS);
}

#[test]
fn test_set_oracle_decimals_rejects_above_max_supported() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    // One unit past the supported maximum must be rejected.
    let result = bridge.try_set_oracle_decimals(&(MAX_SUPPORTED_DECIMALS + 1));
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_set_token_decimals_accepts_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    bridge.set_token_decimals(&0);
    assert_eq!(bridge.get_token_decimals(), 0);
}

#[test]
fn test_set_token_decimals_accepts_max_supported() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    bridge.set_token_decimals(&MAX_SUPPORTED_DECIMALS);
    assert_eq!(bridge.get_token_decimals(), MAX_SUPPORTED_DECIMALS);
}

#[test]
fn test_set_token_decimals_rejects_above_max_supported() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);

    let result = bridge.try_set_token_decimals(&(MAX_SUPPORTED_DECIMALS + 1));
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_convert_to_fiat_zero_decimals() {
    let env = Env::default();

    // With zero token and oracle decimals the price is used as-is.
    let fiat = FiatBridge::convert_to_fiat(&env, &7, &3, &0, &0).unwrap();
    assert_eq!(fiat, 21);
}

#[test]
fn test_convert_to_fiat_max_supported_decimals() {
    let env = Env::default();

    // 1 token unit at max decimals scaled by 1 oracle unit at max decimals
    // must round-trip to exactly 1 fiat unit.
    let one = 10i128.pow(MAX_SUPPORTED_DECIMALS as u32);
    let fiat =
        FiatBridge::convert_to_fiat(&env, &one, &one, &MAX_SUPPORTED_DECIMALS, &MAX_SUPPORTED_DECIMALS)
            .unwrap();
    assert_eq!(fiat, one);
}

#[test]
fn test_convert_to_fiat_rounds_down_for_limit_comparisons() {
    let env = Env::default();

    // 1 token unit at 2 decimals (0.01) priced at 1 oracle unit with 0
    // decimals yields 0.01 fiat, which must round DOWN to 0 so that limit
    // comparisons never overstate the fiat value.
    let fiat = FiatBridge::convert_to_fiat(&env, &1, &1, &2, &0).unwrap();
    assert_eq!(fiat, 0);

    // 3 token units at 2 decimals (0.03) priced at 1 yields 0.03 -> 0.
    let fiat = FiatBridge::convert_to_fiat(&env, &3, &1, &2, &0).unwrap();
    assert_eq!(fiat, 0);

    // 199 units at 2 decimals (1.99) priced at 1 yields 1.99 -> 1.
    let fiat = FiatBridge::convert_to_fiat(&env, &199, &1, &2, &0).unwrap();
    assert_eq!(fiat, 1);
}

#[test]
fn test_convert_to_fiat_extreme_price() {
    let env = Env::default();

    // A very large price with zero decimals must not overflow when the
    // product still fits in i128.
    let price = i128::MAX / 2;
    let fiat = FiatBridge::convert_to_fiat(&env, &2, &price, &0, &0).unwrap();
    assert_eq!(fiat, price * 2);
}

#[test]
fn test_convert_to_fiat_overflow_returns_error() {
    let env = Env::default();

    // Multiplying two large values must be caught by checked arithmetic.
    let result = FiatBridge::convert_to_fiat(&env, &i128::MAX, &2, &0, &0);
    assert_eq!(result, Err(Error::Overflow));
}

#[test]
fn test_convert_to_fiat_overflow_on_scale_returns_error() {
    let env = Env::default();

    // Scaling up by the oracle decimals must also be checked.
    let result = FiatBridge::convert_to_fiat(&env, &i128::MAX, &1, &0, &1);
    assert_eq!(result, Err(Error::Overflow));
}

#[test]
fn test_deposit_limit_one_unit_below_boundary() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);
    bridge.set_fiat_limit(&100);

    // 99 fiat units is strictly below the configured limit.
    let fiat = FiatBridge::convert_to_fiat(&env, &99, &1, &0, &0).unwrap();
    assert_eq!(fiat, 99);
    assert!(fiat < 100);
}

#[test]
fn test_deposit_limit_exactly_at_boundary() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);
    bridge.set_fiat_limit(&100);

    // Exactly at the limit is allowed (limit is inclusive).
    let fiat = FiatBridge::convert_to_fiat(&env, &100, &1, &0, &0).unwrap();
    assert_eq!(fiat, 100);
    assert!(fiat <= 100);
}

#[test]
fn test_deposit_limit_one_unit_above_boundary() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);
    bridge.set_fiat_limit(&100);

    // 101 fiat units is strictly above the configured limit.
    let fiat = FiatBridge::convert_to_fiat(&env, &101, &1, &0, &0).unwrap();
    assert_eq!(fiat, 101);
    assert!(fiat > 100);
}

#[test]
fn test_withdrawal_limit_rounding_never_overstates() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let signers = vec![&env, admin.clone()];

    bridge.init(&admin, &token, &1_000_000, &1, &signers, &1);
    bridge.set_fiat_limit(&100);

    // 100.99 fiat rounds DOWN to 100, so it is still within the limit.
    let fiat = FiatBridge::convert_to_fiat(&env, &10_099, &1, &2, &0).unwrap();
    assert_eq!(fiat, 100);
    assert!(fiat <= 100);

    // 101.00 fiat is exactly one unit above the limit.
    let fiat = FiatBridge::convert_to_fiat(&env, &10_100, &1, &2, &0).unwrap();
    assert_eq!(fiat, 101);
    assert!(fiat > 100);
}
