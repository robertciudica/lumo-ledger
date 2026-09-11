# AGENTS.md

## What this package is

An append-only, event-sourced, multi-tenant accounting core: charges, payments,
allocations, standing credit, reversal, and a cash in/out ledger. Extracted from
a production SaaS. No framework, no ORM, no HTTP, no runtime dependencies.

## Layout

- `src/receivables/BillingService.ts`: charges, payments, allocations, credit.
- `src/receivables/invoice-status.ts`: pure derivation of balance and status.
- `src/cash/LedgerService.ts`: cash rows, voiding, recurring templates.
- `src/store.ts`: the `LedgerStore` port and every entity type.
- `src/testing/InMemoryLedgerStore.ts`: the reference store implementation.
- `test/`: jest suites. `test/helpers.ts` holds the permission sets used there.

## Public API

```ts
new BillingService(store: LedgerStore, config: { paymentCategory: string })
  recordPayment(params): Promise<{ transactionId, allocated, credit }>
  recordPaymentForInvoice(params): Promise<{ transactionId, allocated, credit }>
  previewAllocation(params): Promise<{ steps, totalAllocated, credit }>
  applyCredit(params): Promise<{ applied, remainingCredit, invoicesTouched }>
  calculateBalance(accountId: string, organizationId: string): Promise<number>
  voidInvoicePayments(params): Promise<VoidInvoicePaymentsResult>
  applyCreditNote(params): Promise<CreditNote>
  createManualInvoice(params): Promise<Invoice>

new LedgerService(store: LedgerStore, taxonomy: { in: string[], out: string[] })
  addEntry(params): Promise<LedgerEntry>
  voidEntry(params): Promise<LedgerEntry>
  createTemplate(params): Promise<RecurringExpenseTemplate>
  updateTemplate(params): Promise<RecurringExpenseTemplate>
  deleteTemplate(params): Promise<void>
  materializeTemplatesForMonth(params): Promise<number>

sumAllocations(allocations): number
computeBalance(amount, paidAmount): number
computeEffectiveStatus(dbStatus, amount, paidAmount, dueDate, now): InvoiceStatus
computeLedgerTotals(entries): { inn, out, net }
categoryMatchesDirection(taxonomy, direction, category): boolean
monthKey(date): string
hasPermission(held, needed): boolean
requirePermission(held, needed): void   // throws ForbiddenError
```

Errors: `DomainError` and `NotFoundError`, `ForbiddenError`, `ValidationError`,
`ConflictError`, `IdempotencyError`.

## Rules you must not break

1. Amounts are integers in minor units. Never introduce floating-point
   arithmetic on money, never divide without deciding where the remainder goes.
2. Never mutate a recorded amount. Corrections are void plus re-add, or reverse
   plus re-record.
3. `allocated + credit` must equal the amount received. The runtime check in
   `recordPayment` throws a plain `Error`, not a `DomainError`, on purpose: it is
   a bug, not user input. Do not convert it.
4. Balances and effective status are derived on read. Do not add a stored balance
   column, and do not start trusting `Invoice.status`.
5. Every mutating method takes an `idempotencyKey`, checks the event log before
   the transaction, and writes the event row inside it. Keep that order.
6. Every storage call passes `organizationId`. Never add a method that omits it,
   and never take a tenant id from anything the end user controls.
7. VOID is terminal in both directions.
8. `previewAllocation` and `recordPayment` implement the same waterfall. Change
   one, change the other; `test/preview-allocation.test.ts` has the parity test.

## Easy mistakes

- **`findTransactionsByAccount` must exclude voided payments.** Any store that
  returns them makes a reversed payment reappear as standing credit that can be
  spent again. There is no guard in the service for this.
- **`createEventLog` must throw on a duplicate `(organizationId, idempotencyKey)`.**
  The pre-flight read is a fast path, not the guarantee. A store without the
  unique constraint makes every idempotency test in this repo meaningless.
- `createManualInvoice` has no permission check. That is how it is in
  production; authorization for that path lives in the caller. Do not "fix" it
  without being asked.
- Currency is carried on every row and never compared. That gap is deliberate
  and characterized in `test/invariants.test.ts`. Do not add a guard silently.
- `applyCredit` writes no cash row. The cash was booked when the payment was
  recorded; adding one double-counts income.
- A payment holds at most one allocation per charge. `applyCredit` skips a source
  that already touched the target charge for that reason.

## Running

```
npm install
npm test          # jest, no database, no network, no env vars
npm run typecheck # tsc --noEmit over src and test
npm run build     # dist/ with declarations
```
