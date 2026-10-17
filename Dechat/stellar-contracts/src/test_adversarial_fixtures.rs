#![cfg(test)]
use crate::{DataKey, Error, FiatBridge, FiatBridgeClient, TokenConfig};
use soroban_sdk::{contract, contractimpl, testutils::Address as _, Address, Bytes, Env, Symbol};

#[contract]
pub struct AdversarialOracle;

#[contractimpl]
impl AdversarialOracle {
    pub fn set_price(env: Env, price: Option<i128>) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "price"), &price);
    }

    pub fn set_should_panic(env: Env, should_panic: bool) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "panic"), &should_panic);
    }

    pub fn get_price(env: Env, _token: Address) -> Option<i128> {
        let should_panic = env
            .storage()
            .instance()
            .get::<_, bool>(&Symbol::new(&env, "panic"))
            .unwrap_or(false);
        if should_panic {
            panic!("Adversarial oracle simulated failure");
        }
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "price"))
            .unwrap_or(None)
    }
}

#[contract]
pub struct AdversarialToken;

#[contractimpl]
impl AdversarialToken {
    pub fn set_should_revert(env: Env, revert: bool) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "revert"), &revert);
    }

    pub fn transfer(env: Env, _from: Address, _to: Address, _amount: i128) {
        let revert = env
            .storage()
            .instance()
            .get::<_, bool>(&Symbol::new(&env, "revert"))
            .unwrap_or(false);
        if revert {
            panic!("Adversarial token simulated transfer revert");
        }
    }
}

fn setup_adversarial_test_env(
    env: &Env,
) -> (
    FiatBridgeClient<'_>,
    Address,
    Address,
    soroban_sdk::token::StellarAssetClient<'_>,
    Address,
    AdversarialOracleClient<'_>,
) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let contract_address = env.register_stellar_asset_contract_v2(admin.clone());
    let token_admin = soroban_sdk::token::StellarAssetClient::new(env, &contract_address.address());
    let token_addr = contract_address.address();

    let oracle_id = env.register(AdversarialOracle, ());
    let oracle_client = AdversarialOracleClient::new(env, &oracle_id);

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(env, &contract_id);

    bridge.init(
        &admin,
        &token_addr,
        &10_000_000,
        &100,
        &soroban_sdk::vec![env, admin.clone()],
        &1,
        &0,
    );

    // Set high fiat limit and oracle to enable price-checked flows
    bridge.set_oracle(&oracle_id);
    bridge.set_fiat_limit(&1_000_000_000);

    (
        bridge,
        admin,
        token_addr,
        token_admin,
        oracle_id,
        oracle_client,
    )
}

#[test]
fn test_deposit_rejected_on_negative_oracle_price() {
    let env = Env::default();
    let (bridge, _admin, token_addr, token_admin, _oracle_id, oracle) =
        setup_adversarial_test_env(&env);

    let user = Address::generate(&env);
    token_admin.mint(&user, &100_000);

    // Configure adversarial oracle with negative price
    oracle.set_price(&Some(-500_0000000));

    let res = bridge.try_deposit(&user, &1000, &token_addr, &Bytes::new(&env), &0, &0, &None);
    assert_eq!(res, Err(Ok(Error::OraclePriceInvalid)));

    // Verify atomic invariant: NO partial accounting survived
    let snapshot = bridge.get_config_snapshot();
    assert_eq!(snapshot.min_deposit, 100);

    let config = env.as_contract(&bridge.address, || {
        env.storage()
            .persistent()
            .get::<_, TokenConfig>(&DataKey::TokenRegistry(token_addr.clone()))
            .unwrap()
    });
    assert_eq!(config.total_deposited, 0);
    assert_eq!(config.total_liabilities, 0);
}

#[test]
fn test_deposit_rejected_on_zero_oracle_price() {
    let env = Env::default();
    let (bridge, _admin, token_addr, token_admin, _oracle_id, oracle) =
        setup_adversarial_test_env(&env);

    let user = Address::generate(&env);
    token_admin.mint(&user, &100_000);

    // Configure adversarial oracle with zero price
    oracle.set_price(&Some(0));

    let res = bridge.try_deposit(&user, &1000, &token_addr, &Bytes::new(&env), &0, &0, &None);
    assert_eq!(res, Err(Ok(Error::OraclePriceInvalid)));

    // Verify zero deposits recorded
    let config = env.as_contract(&bridge.address, || {
        env.storage()
            .persistent()
            .get::<_, TokenConfig>(&DataKey::TokenRegistry(token_addr.clone()))
            .unwrap()
    });
    assert_eq!(config.total_deposited, 0);
}

#[test]
#[should_panic(expected = "Adversarial oracle simulated failure")]
fn test_deposit_reverts_when_oracle_panics() {
    let env = Env::default();
    let (bridge, _admin, token_addr, token_admin, _oracle_id, oracle) =
        setup_adversarial_test_env(&env);

    let user = Address::generate(&env);
    token_admin.mint(&user, &100_000);

    // Configure oracle to panic
    oracle.set_should_panic(&true);

    bridge.deposit(&user, &1000, &token_addr, &Bytes::new(&env), &0, &0, &None);
}

#[test]
fn test_withdrawal_execution_rejected_on_extreme_slippage() {
    let env = Env::default();
    let (bridge, _admin, token_addr, token_admin, _oracle_id, oracle) =
        setup_adversarial_test_env(&env);

    let user = Address::generate(&env);
    token_admin.mint(&user, &100_000);

    // Valid price for deposit ($1.00 = 10_000_000 with 7 decimals)
    oracle.set_price(&Some(10_0000000));
    bridge.deposit(&user, &2000, &token_addr, &Bytes::new(&env), &0, &0, &None);

    // Request withdrawal
    let req_id = bridge.request_withdrawal(&user, &1000, &token_addr, &None, &0);
    assert_eq!(bridge.get_wq_depth(), 1);

    // Verify initial liability recorded
    let config_before = env.as_contract(&bridge.address, || {
        env.storage()
            .persistent()
            .get::<_, TokenConfig>(&DataKey::TokenRegistry(token_addr.clone()))
            .unwrap()
    });
    assert_eq!(config_before.total_liabilities, 1000);

    // Adversarial price drop: expected $1.00 (10_000_000), actual $0.50 (5_000_000)
    // with 100 bps (1%) max slippage
    oracle.set_price(&Some(5_0000000));
    let res = bridge.try_execute_withdrawal(&req_id, &None, &10_0000000, &100, &0);
    assert_eq!(res, Err(Ok(Error::SlippageTooHigh)));

    // Verify invariant: Request remains queued, liability not dropped, accounting preserved
    assert_eq!(bridge.get_wq_depth(), 1);
    let queued = bridge.get_withdrawal_request(&req_id).unwrap();
    assert_eq!(queued.amount, 1000);

    let config_after = env.as_contract(&bridge.address, || {
        env.storage()
            .persistent()
            .get::<_, TokenConfig>(&DataKey::TokenRegistry(token_addr.clone()))
            .unwrap()
    });
    assert_eq!(config_after.total_liabilities, 1000);
    assert_eq!(config_after.total_withdrawn, 0);
}

#[test]
fn test_withdrawal_rejected_when_token_fails_transfer() {
    let env = Env::default();
    let (bridge, admin, token_addr, token_admin, _oracle_id, oracle) =
        setup_adversarial_test_env(&env);

    let user = Address::generate(&env);
    token_admin.mint(&user, &100_000);
    oracle.set_price(&Some(10_0000000));

    bridge.deposit(&user, &2000, &token_addr, &Bytes::new(&env), &0, &0, &None);
    let req_id = bridge.request_withdrawal(&user, &1000, &token_addr, &None, &0);

    // Drain bridge balance so token transfer fails due to InsufficientBalance
    env.as_contract(&bridge.address, || {
        let contract_bal = token_admin.balance(&bridge.address);
        token_admin.transfer(&bridge.address, &admin, &contract_bal);
    });

    // Attempt execution with drained token balance
    let res = bridge.try_execute_withdrawal(&req_id, &None, &0, &0, &0);
    assert!(res.is_err());

    // Invariant: request is preserved, queue is not dropped
    assert_eq!(bridge.get_wq_depth(), 1);
    let queued = bridge.get_withdrawal_request(&req_id);
    assert!(queued.is_some());
}

#[test]
fn test_fee_withdrawal_fails_safely_when_insufficient_or_zero() {
    let env = Env::default();
    let (bridge, admin, token_addr, _token_admin, _oracle_id, _oracle) =
        setup_adversarial_test_env(&env);

    // Attempt zero fee withdrawal
    let res = bridge.try_withdraw_fees(&admin, &token_addr, &0, &0);
    assert_eq!(res, Err(Ok(Error::ZeroAmount)));

    // Attempt fee withdrawal exceeding available fee vault (0 available)
    let res2 = bridge.try_withdraw_fees(&admin, &token_addr, &100, &0);
    assert_eq!(res2, Err(Ok(Error::NoFeesToWithdraw)));

    // Invariant: Nonce is NOT burned, fee vault remains 0
    assert_eq!(bridge.get_fee_withdrawal_nonce(&admin), 0);
}
