# Changelog

Notable changes, newest first. This project follows [semantic
versioning](https://semver.org/), and the format is loosely [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/).

## 1.1.0

The first release after the package was reviewed as a public one rather than
as an extraction. Two themes: concurrency, which was undefended, and the
storage port, which was documented rather than enforced.

### Added

- **`LedgerStore.lockAccount`.** A row lock held until the enclosing
  transaction commits. Every operation that changes what is allocated on an
  account takes it first. Without it two concurrent payments read the same
  outstanding balance and both spend it, and the charge ends up overpaid with
  no error anywhere.
- **`PostgresLedgerStore`,** with `schema.sql`. Runs on `pg` through
  `pgPoolClient`, or on PGlite directly. Still no runtime dependencies: the
  store asks a driver for `query` and `transaction` and anything with them
  fits. Imported as `lumo-ledger/postgres`.
- **`runLedgerStoreContractTests`,** the port's rules as a runnable suite,
  exported from `lumo-ledger/testing`. Point it at your own store. It is
  runner-agnostic, so jest, vitest and `node:test` all work.
- **`planWaterfall` and `selectOpenInvoices`,** the allocation algorithm as
  pure functions. `recordPayment` and `previewAllocation` now call the same
  code rather than each implementing it.
- **`StoreError` and `UniqueViolationError`,** so a store reports failures in
  the ledger's own types instead of leaking a driver's.
- **`money()` and `isMoney()`,** for validating an amount at your own
  boundary. `money.ts` records why the type is not branded.
- **An injected clock** on both services, as `config.clock`.
- **Dual ESM and CommonJS builds,** three entry points, and full package
  metadata.

### Fixed

- **The in-memory store leaked allocations across tenants.**
  `findAllocationsByInvoice` and `findAllocationsByTransaction` filtered on the
  id alone and ignored `organizationId`, which is the exact failure the port
  document warns implementers about. Found by running the new contract suite
  against the store that shipped with the package.
- **A lost idempotency race surfaced as a raw constraint violation.** The
  pre-flight read of the event log can lose to a concurrent caller; the unique
  constraint then fires inside the transaction. That now reports
  `IdempotencyError`, the same as a repeated call, and a raced recurring
  posting reports zero rows created instead of failing the batch.
- **`applyCreditNote` had no pre-flight idempotency check,** unlike every other
  mutating method.
- **Account ids were globally unique in the schema,** so two tenants could not
  both have a "customer-1". The key is `(organization_id, id)`.
- **Charges created in one transaction shared a timestamp,** because the column
  defaulted to `now()`, which is the transaction's start time. "Oldest first"
  then had nothing to order by. It is `clock_timestamp()` with a `bigserial`
  tiebreak.
- **`PostgresLedgerStore.runTransaction` dropped subclass overrides.** It
  constructed the base class by name, so an override applied outside
  transactions and was silently ignored inside them.
- **One allocation query per account** instead of one per open charge.
- **The in-memory store's id counter was module-global,** so two stores in one
  process shared it and resetting one reset both.

### Changed

- **`calculateBalance` is documented as standing credit,** which is what it has
  always computed: payments minus allocations minus credit notes. It is not
  what the account owes, and open charges are not in the formula. The
  `CreditNote` doc no longer claims the opposite of the code.
- **The extraction documents** are one `docs/extraction.md` in the author's
  voice, rather than three files of an agent's working notes.
- **Jest configuration** is `jest.config.js`. PGlite needs
  `--experimental-vm-modules`, and with that flag Node reads a `.ts` config as
  an ES module and fails on `export default`.

### Compatibility

`lockAccount` is a new required method on `LedgerStore`. A store written
against 1.0 will not compile until it is added. Implementing it as
`findAccountById` restores exactly the old behaviour, which is what the
in-memory store does, but a store on a real database should take the row lock:
that is the whole point of the method.

## 1.0.0

The ledger extracted from Lumo as a standalone package: two ledgers sharing
one event log, one storage port, an in-memory implementation, and 169 tests.
See `docs/extraction.md` for what was taken, what was left, and why.
