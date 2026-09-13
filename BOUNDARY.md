# Public API

Three entry points. `lumo-ledger` is the ledger, `lumo-ledger/testing` is the
in-memory store and the contract suite, `lumo-ledger/postgres` is the SQL
store. Nothing else is exported.

## Services

| Export | Signature | Purpose |
| --- | --- | --- |
| `BillingService` | `new BillingService(store: LedgerStore, config: BillingConfig)` | The receivables ledger: charges, payments, allocations, credit. `config` carries the cash category payments are booked under, and an optional `clock`. |
| `BillingService#recordPayment` | `(params: RecordPaymentParams) => Promise<RecordPaymentResult>` | Take money from an account and waterfall it across open charges, oldest first. The remainder stays as credit. |
| `BillingService#recordPaymentForInvoice` | `(params: RecordPaymentForInvoiceParams) => Promise<RecordPaymentResult>` | Take money against one named charge. Overpayment is rejected. |
| `BillingService#previewAllocation` | `(params: PreviewAllocationParams) => Promise<PreviewAllocationResult>` | Dry run of the waterfall. Writes nothing. |
| `BillingService#applyCredit` | `(params: ApplyCreditParams) => Promise<ApplyCreditResult>` | Spend an account's standing credit against its open charges. |
| `BillingService#calculateBalance` | `(accountId: string, organizationId: string) => Promise<Money>` | Standing credit: payments minus allocations minus credit notes. Not what the account owes; open charges are not in the formula. |
| `BillingService#voidInvoicePayments` | `(params: VoidInvoicePaymentsParams) => Promise<VoidInvoicePaymentsResult>` | Reverse every live payment on one charge. The unit is the charge, not the payment. |
| `BillingService#applyCreditNote` | `(params: ApplyCreditNoteParams) => Promise<CreditNote>` | Reduce what an account owes without money moving. |
| `BillingService#createManualInvoice` | `(params: CreateManualInvoiceParams) => Promise<Invoice>` | Create a charge with an explicit amount. No pricing logic. |
| `LedgerService` | `new LedgerService(store: LedgerStore, taxonomy: CategoryTaxonomy, options?: LedgerServiceOptions)` | The cash ledger: what came in, what went out. |
| `LedgerService#addEntry` | `(params: AddLedgerEntryParams) => Promise<LedgerEntry>` | Record one manual cash row. |
| `LedgerService#voidEntry` | `(params: VoidLedgerEntryParams) => Promise<LedgerEntry>` | Void a manual row. Rows written by a payment are refused here. |
| `LedgerService#createTemplate` | `(params: CreateTemplateParams) => Promise<RecurringExpenseTemplate>` | Define a monthly recurring expense. |
| `LedgerService#updateTemplate` | `(params: UpdateTemplateParams) => Promise<RecurringExpenseTemplate>` | Edit a template. Future postings only. |
| `LedgerService#deleteTemplate` | `(params: DeleteTemplateParams) => Promise<void>` | Deactivate a template. Posted rows survive. |
| `LedgerService#materializeTemplatesForMonth` | `(params: MaterializeTemplatesParams) => Promise<number>` | Post every due template for a month. Idempotent. |

## Pure functions

| Export | Signature | Purpose |
| --- | --- | --- |
| `planWaterfall` | `(open: readonly OpenCharge[], amount: Money) => WaterfallPlan` | Where a payment would land. The one implementation of the algorithm; `recordPayment` commits it and `previewAllocation` displays it. |
| `selectOpenInvoices` | `(invoices: readonly Invoice[]) => Invoice[]` | The charges still owed, oldest first. |
| `sumAllocationsByInvoice` | `(allocations) => Map<string, Money>` | Groups allocation amounts by charge, so one query serves every charge. |
| `money` | `(amount: number, field?: string) => Money` | Validates an amount at your own boundary. Throws `ValidationError`. |
| `isMoney` | `(value: unknown) => boolean` | The same question without throwing. |
| `sumAllocations` | `(allocations: readonly HasAmount[]) => number` | What has landed on a charge. |
| `computeBalance` | `(amount: number, paidAmount: number) => number` | What is still owed. Never negative. |
| `computeEffectiveStatus` | `(dbStatus, amount, paidAmount, dueDate, now) => InvoiceStatus` | The state to show a human, derived from allocations rather than trusted from the stored column. |
| `computeLedgerTotals` | `(entries: readonly LedgerEntry[]) => LedgerTotals` | Signed in / out / net over cash rows, voided rows excluded. |
| `categoryMatchesDirection` | `(taxonomy, direction, category) => boolean` | Is this category valid for this direction. |
| `monthKey` | `(date: Date) => string` | `"YYYY-MM"` in UTC. |
| `hasPermission` | `(held: readonly Permission[], needed: Permission) => boolean` | No side effects. |
| `requirePermission` | `(held: readonly Permission[], needed: Permission) => void` | Throws `ForbiddenError`. |

## Storage

| Export | Entry point | Kind | Purpose |
| --- | --- | --- | --- |
| `LedgerStore` | `.` | interface | The one port. 30 methods, every one takes `organizationId`. |
| `InMemoryLedgerStore` | `.`, `./testing` | class | A complete implementation with no dependencies. Proves logic, not atomicity: `runTransaction` does not roll back. |
| `PostgresLedgerStore` | `./postgres` | class | Postgres, on any driver with `query` and `transaction`. Real transactions, real `SELECT ... FOR UPDATE`. |
| `pgPoolClient` | `./postgres` | function | Wraps a `pg` pool so a transaction pins one connection. |
| `SqlClient`, `SqlQueryable`, `PgPoolLike`, `PgClientLike` | `./postgres` | interfaces | The driver shape, so the package depends on no driver. |
| `runLedgerStoreContractTests` | `./testing` | function | The port's rules as a runnable suite. Point it at your own store. |
| Entity factories | `./testing` | functions | `accountFactory` and friends, for seeding the in-memory store. |
| `schema.sql` | `lumo-ledger/schema.sql` | file | The Postgres schema, every constraint annotated with what breaks without it. |

## Errors

`DomainError` (base, carries `code`), and `NotFoundError`, `ForbiddenError`,
`ValidationError`, `ConflictError`, `IdempotencyError`.

Thrown by a store rather than by the ledger: `StoreError` (carries `cause`) and
`UniqueViolationError` (carries `constraint`). `EVENT_LOG_KEY_CONSTRAINT` is
the name a store must report for a duplicate `(organizationId,
idempotencyKey)`; the services translate that one into `IdempotencyError`.

## Types and constants

`Money`, `Permission`, `PERMISSIONS`, `CategoryTaxonomy`, `BillingConfig`,
`EVENT_TYPES`, `EventType`, `SYSTEM_ACTOR_ID`, `ActorType`.

Entities: `Account`, `Invoice`, `FinancialTransaction`, `Allocation`,
`CreditNote`, `LedgerEntry`, `RecurringExpenseTemplate`, `EventLog`.

Waterfall types: `OpenCharge`, `WaterfallPlan`, `AllocationStep`.

Enums: `InvoiceStatus`, `PaymentMethod`, `CreditNoteReason`, `LedgerDirection`,
`LedgerSource`.

Parameter and result types for every service method listed above, plus the
storage input types (`CreateInvoiceInput` and friends) that an implementer of
`LedgerStore` has to satisfy.

## Out of scope, deliberately

These exist in Lumo and are not here. Each one is a place where the ledger stops
and the product starts.

| Lumo entry point | Why it is not here |
| --- | --- |
| `BillingService.generateInvoice` | Prices a charge from an enrollment in a class with a pricing type. All product, no ledger. |
| `core/billing/enrollment-invoice.ts` | Decides whether signing someone up should bill them. |
| `core/billing/reprice.ts` | Rewrites open charges after a price change. Depends on the pricing model. |
| `core/billing/invoice-period.ts` | Derives billing periods and due dates from a calendar the product owns. |
| `core/billing/price-drift.ts` | Compares a charge against the current price list. |
| The monthly summary projector | A read model over the ledger, built from the event log. It belongs to whoever is reading. |
| Anything that reads the event log | The ledger writes events. Replaying them is the caller's job. |
