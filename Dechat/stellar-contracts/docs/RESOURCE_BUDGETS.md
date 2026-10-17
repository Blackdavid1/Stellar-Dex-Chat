# Soroban Resource Budgets and Regression Thresholds

## 1. Overview and Objective

Stellar Soroban smart contracts execute under strict, deterministic resource limits enforced by the Soroban host environment:
- **Maximum CPU Instructions per Invocation**: 100,000,000 instructions
- **Maximum Memory per Invocation**: 40 MB
- **Ledger Read and Write Footprint**: Strictly constrained per transaction

If an entrypoint exceeds host limits, the transaction fails immediately on-chain and cannot be processed. Furthermore, unmonitored resource growth increases user transaction fees.

This specification establishes:
1. Deterministic resource measurement for key entrypoints.
2. Reviewed baseline resource budgets stored in `budgets/baseline_budgets.json`.
3. Documented regression thresholds.
4. Continuous automated validation in CI without relying on machine-dependent wall-clock timing.

---

## 2. Deterministic Metering vs. Wall-Clock Timing

Traditional benchmarks measure elapsed wall-clock execution time (e.g., milliseconds). Wall-clock measurements fluctuate wildly based on runner CPU load, background processes, CPU frequency scaling, virtual machine noise, and cloud hypervisor jitter.

In contrast, the Soroban SDK test environment provides **deterministic host-level metering**:
- `env.cost_estimate().budget().cpu_instruction_cost()` meters abstract host CPU instructions executed.
- `env.cost_estimate().budget().memory_bytes_cost()` meters abstract host memory allocations and bytes tracked.

For any given input state and invocation parameters, these metrics produce **identical numbers** regardless of the host machine hardware, operating system, or execution speed.

---

## 3. Reviewed Baseline Budgets & Ceilings

The table below reflects the reviewed baselines and maximum allowable ceilings (+10% regression threshold):

| Entrypoint Family | Operation | Baseline CPU | Max CPU Ceiling (+10%) | Baseline Memory | Max Memory Ceiling (+10%) | Max Ledger Reads | Max Ledger Writes |
|:---|:---|:---|:---|:---|:---|:---|:---|
| **Deposit** | `deposit` | 803,441 | 883,785 | 282,015 B | 310,216 B | 10 | 6 |
| **Withdrawal** | `request_withdrawal` | 688,348 | 757,182 | 255,008 B | 280,508 B | 8 | 4 |
| **Withdrawal** | `execute_withdrawal` | 885,286 | 973,814 | 251,342 B | 276,476 B | 10 | 5 |
| **Admin** | `set_limit` | 354,744 | 390,218 | 142,217 B | 156,438 B | 5 | 3 |
| **Admin** | `pause` | 276,733 | 304,406 | 119,143 B | 131,057 B | 4 | 2 |
| **Query** | `get_config_snapshot` | 310,950 | 342,045 | 95,782 B | 105,360 B | 15 | 0 |

---

## 4. Documented Regression Threshold Policy

1. **CPU Instructions Threshold**:
   - Delta $\le 0\%$: Optimal (performance improvement).
   - $0\% < \text{Delta} \le 5\%$: Acceptable fluctuation from minor dependency updates.
   - $5\% < \text{Delta} \le 10\%$: Warning threshold; requires performance review in PR.
   - $\text{Delta} > 10\%$: **Hard regression blocker**; CI failure.

2. **Memory Bytes Threshold**:
   - Delta $\le 10\%$: Acceptable.
   - $\text{Delta} > 10\%$: **Hard regression blocker**; CI failure.

3. **Storage Footprint Invariants**:
   - Any query entrypoint (e.g., `get_config_snapshot`, `get_escrow_record`, `get_receipt`) MUST have `ledger_writes = 0`.
   - Modifying entrypoints must not increase storage slot reads/writes beyond authorized architectural changes.

---

## 5. Verification Suite

The budget benchmark suite is tested via:
- `src/test_resource_budgets.rs`:
  - Runs double clean-state executions and verifies identical deterministic reports.
  - Asserts that every entrypoint satisfies the maximum ceiling constraints.
  - Automatically flags regressions.
