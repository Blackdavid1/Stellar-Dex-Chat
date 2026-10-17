# Upgrade and Rollback Compatibility Fixtures

## 1. Overview and Objective

During protocol upgrades and storage migrations (such as migrating ephemeral `Receipt` records to persistent `EscrowRecord` slots), testing against freshly initialized contract state is insufficient. Real-world contract state contains accumulated liabilities, queued withdrawals, pending nonces, and legacy storage keys.

This specification documents:
1. Representative pre-upgrade storage fixtures representing released contract versions.
2. Invariant preservation across migration (accounting, queue ordering, receipt lookups, and admin configuration).
3. Graceful handling and rejection of unsupported schema versions.
4. Safe recovery procedures after an interrupted or partial migration.
5. Fixture integrity enforcement to prevent unreviewed changes.

---

## 2. Storage Layout Fixtures

The canonical storage layout fixture is stored in:
`Dechat/stellar-contracts/fixtures/storage/v1_storage_fixture.json`

### Canonical Checksum
- **SHA-256**: `1de036751ad3681e317c9e2e0f3969b8cf4d946c11d222b45f48a9e26569908d`

Any pull request that modifies this fixture without updating its cryptographic checksum and documentation will fail automated test assertions.

### Covered State Dimensions
- **Token Configuration**: `total_deposited`, `total_withdrawn`, `total_liabilities`, `limit`, `min_deposit`.
- **Receipts**: Pre-migration `Receipt` entries and sequential `ReceiptIndex` keys.
- **Withdrawal Queue**: FIFO order, pending amounts, unlock ledgers, and priority tiers.
- **Administrative Settings**: Admin address, lock period, schema version, and timelock delays.

---

## 3. Migration and Rollback Guarantees

When applying upgrades or migrations:
1. **Balance Equivalence**: `total_deposited`, `total_withdrawn`, and contract on-chain token balance must remain strictly equal before and after migration.
2. **Queue Invariant**: Queued withdrawal positions must retain their exact order, IDs, timestamps, and amounts. No request may be dropped, duplicated, or reordered.
3. **Lookup Equivalence**: Any receipt index queryable before migration must remain accessible either through `get_receipt` or via `get_escrow_record`.
4. **Interrupted Upgrade Recovery**: The migration cursor (`EscrowMigrationCursor`) guarantees idempotent, incremental progress. If execution halts after batch $N$, the next invocation resumes from cursor $N$ without data loss or duplicate accounting.
5. **Rollback Safety**: If a proposed upgrade is cancelled via `cancel_upgrade`, the proposal is purged while all core business storage remains unchanged.
