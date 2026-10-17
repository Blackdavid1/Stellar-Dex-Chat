# Adversarial Token and Oracle Contract Fixtures

## 1. Overview and Objective

Smart contract integrations frequently encounter faulty, hostile, or misconfigured external contracts. Happy-path unit tests using standard tokens and benign oracles fail to model:
- Reverts during transfers or price lookups.
- Stale, zero, or negative price feeds.
- Extreme values causing overflow or unbounded slippage.
- Dynamic inconsistencies (e.g., frontrunning or rapid price shifts between expectation and settlement).

This specification documents:
1. Configurable mock contracts (`AdversarialToken` and `AdversarialOracle`).
2. Supported versus rejected external behaviors across deposit, withdrawal, fee, and migration flows.
3. Invariant guarantees: no partial accounting state survives external failure.

---

## 2. External Behavior Matrix

| External Dependency | Behavior Mode | Supported vs Rejected | Expected Contract Behavior | State Invariant |
|:---|:---|:---|:---|:---|
| **Price Oracle** | Returns valid positive price within slippage | Supported | Deposit / withdrawal settles normally | Accounting updated atomically |
| **Price Oracle** | Returns negative price (`price < 0`) | **Rejected** | Aborts with `Error::OraclePriceInvalid` | No receipt issued; balances unchanged |
| **Price Oracle** | Returns zero price (`price == 0`) | **Rejected** | Aborts with `Error::OraclePriceInvalid` | No receipt issued; balances unchanged |
| **Price Oracle** | Panics / reverts on `get_price` | **Rejected** | Transaction reverts | Host discards all state modifications |
| **Price Oracle** | Extreme price shift beyond `max_slippage` | **Rejected** | Aborts with `Error::SlippageExceeded` | Request remains queued; liabilities intact |
| **Token Contract** | Standard transfer success | Supported | Funds move; accounting updated | Total deposits / withdrawals match |
| **Token Contract** | Reverts on deposit transfer | **Rejected** | Transaction reverts | No receipt issued; nonce not burned |
| **Token Contract** | Reverts on withdrawal transfer | **Rejected** | Transaction reverts | Queue position preserved; liability intact |
| **Token Contract** | Reverts on fee withdrawal transfer | **Rejected** | Transaction reverts | Fee remains accrued; nonce not burned |

---

## 3. Atomic State Rollback Guarantee

A core invariant of the `FiatBridge` protocol is transactional atomicity:
- If a dependency reverts at any point during execution, the host environment rolls back all storage writes and event emissions.
- When an operation returns a handled `Err(Error::...)`, the contract does not mutate accumulators, burn nonces, or drop queued items.
- In tests, state invariants (`total_deposited`, `total_withdrawn`, `total_liabilities`, `queue_len`, `nonces`) are verified before and after each adversarial scenario to ensure zero state corruption.
