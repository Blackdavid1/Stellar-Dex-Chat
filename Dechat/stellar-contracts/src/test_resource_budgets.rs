#![cfg(test)]
extern crate std;
use crate::{FiatBridge, FiatBridgeClient};
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};
use std::println;

fn setup_benchmark_bridge(
    env: &Env,
) -> (
    FiatBridgeClient<'_>,
    Address,
    Address,
    soroban_sdk::token::StellarAssetClient<'_>,
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
        &10_000_000,
        &100,
        &soroban_sdk::vec![env, admin.clone()],
        &1,
        &0,
    );

    (bridge, admin, token_addr, token_admin)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationBudget {
    pub name: &'static str,
    pub cpu_instructions: u64,
    pub memory_bytes: u64,
}

pub fn measure_entrypoints(env: &Env) -> [OperationBudget; 6] {
    env.mock_all_auths();
    let (bridge, _admin, token_addr, token_admin) = setup_benchmark_bridge(env);
    let user = Address::generate(env);
    token_admin.mint(&user, &1_000_000);

    // 1. Measure deposit
    env.cost_estimate().budget().reset_default();
    bridge.deposit(&user, &1000, &token_addr, &Bytes::new(env), &0, &0, &None);
    let deposit_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let deposit_mem = env.cost_estimate().budget().memory_bytes_cost();

    // 2. Measure request_withdrawal
    env.cost_estimate().budget().reset_default();
    let req_id = bridge.request_withdrawal(&user, &500, &token_addr, &None, &0);
    let req_wdr_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let req_wdr_mem = env.cost_estimate().budget().memory_bytes_cost();

    // 3. Measure execute_withdrawal
    env.cost_estimate().budget().reset_default();
    bridge.execute_withdrawal(&req_id, &None, &0, &0, &0);
    let exec_wdr_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let exec_wdr_mem = env.cost_estimate().budget().memory_bytes_cost();

    // 4. Measure admin set_limit
    env.cost_estimate().budget().reset_default();
    bridge.set_limit(&token_addr, &20_000_000, &0);
    let set_limit_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let set_limit_mem = env.cost_estimate().budget().memory_bytes_cost();

    // 5. Measure admin pause
    env.cost_estimate().budget().reset_default();
    bridge.pause();
    let pause_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let pause_mem = env.cost_estimate().budget().memory_bytes_cost();

    // 6. Measure query get_config_snapshot
    env.cost_estimate().budget().reset_default();
    let _snapshot = bridge.get_config_snapshot();
    let query_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let query_mem = env.cost_estimate().budget().memory_bytes_cost();

    [
        OperationBudget {
            name: "deposit",
            cpu_instructions: deposit_cpu,
            memory_bytes: deposit_mem,
        },
        OperationBudget {
            name: "request_withdrawal",
            cpu_instructions: req_wdr_cpu,
            memory_bytes: req_wdr_mem,
        },
        OperationBudget {
            name: "execute_withdrawal",
            cpu_instructions: exec_wdr_cpu,
            memory_bytes: exec_wdr_mem,
        },
        OperationBudget {
            name: "admin_set_limit",
            cpu_instructions: set_limit_cpu,
            memory_bytes: set_limit_mem,
        },
        OperationBudget {
            name: "admin_pause",
            cpu_instructions: pause_cpu,
            memory_bytes: pause_mem,
        },
        OperationBudget {
            name: "query_config_snapshot",
            cpu_instructions: query_cpu,
            memory_bytes: query_mem,
        },
    ]
}

#[test]
fn test_resource_budgets_deterministic_execution() {
    let env1 = Env::default();
    let run1 = measure_entrypoints(&env1);

    let env2 = Env::default();
    let run2 = measure_entrypoints(&env2);

    assert_eq!(
        run1, run2,
        "Resource reports must be 100% deterministic across clean runs"
    );

    // Regression threshold check (within 10% of reviewed baseline ceiling)
    for op in run1.iter() {
        println!(
            "MEASURED: {} -> CPU: {}, MEM: {}",
            op.name, op.cpu_instructions, op.memory_bytes
        );
        assert!(
            op.cpu_instructions > 0,
            "{} must consume non-zero CPU instructions",
            op.name
        );
        assert!(
            op.memory_bytes > 0,
            "{} must consume non-zero memory bytes",
            op.name
        );

        let (max_cpu, max_mem) = match op.name {
            "deposit" => (883_785, 310_216),
            "request_withdrawal" => (757_182, 280_508),
            "execute_withdrawal" => (973_814, 276_476),
            "admin_set_limit" => (390_218, 156_438),
            "admin_pause" => (304_406, 131_057),
            "query_config_snapshot" => (342_045, 105_360),
            _ => (100_000_000, 40_000_000),
        };

        assert!(
            op.cpu_instructions <= max_cpu,
            "{} exceeded regression ceiling: {} > {}",
            op.name,
            op.cpu_instructions,
            max_cpu
        );
        assert!(
            op.memory_bytes <= max_mem,
            "{} exceeded memory ceiling: {} > {}",
            op.name,
            op.memory_bytes,
            max_mem
        );
    }
}
