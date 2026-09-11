# Discovery: what the ledger is, and what it is tangled with

Source: the Lumo repository, `lumo.dance/src`. Read-only. Nothing in Lumo was
modified during this extraction.

Verdict: **EXTRACTABLE**. Full reasoning in section 5.

## 1. The files that are the ledger

Lumo keeps two money ledgers that share one event log. Both live in `src/core/`,
which is a framework-free layer: no Prisma, no Next.js, no HTTP, no file I/O.
Every database call goes through a single port interface injected into the
constructor, and every method takes `organizationId` as an explicit argument.

### The receivables ledger (what is owed, what was paid, what covers what)

| File | Lines | What it holds |
| --- | ---: | --- |
| `src/core/billing/BillingService.ts` | 1567 | `recordPayment`, `recordPaymentForInvoice`, `previewAllocation`, `applyCredit`, `calculateBalance`, `voidInvoicePayments`, `applyCreditNote`, `createManualInvoice` are the ledger. `generateInvoice` is not (see section 2). |
| `src/core/billing/invoice-status.ts` | 80 | `sumAllocations`, `computeBalance`, `computeEffectiveStatus`. Pure. The single definition of what an invoice is worth and what state it is in. |

### The cash ledger (money that moved, in and out)

| File | Lines | What it holds |
| --- | ---: | --- |
| `src/core/ledger/LedgerService.ts` | 482 | `addEntry`, `voidEntry`, `createTemplate`, `updateTemplate`, `deleteTemplate`, `materializeTemplatesForMonth`, plus the pure `computeLedgerTotals`, `categoryMatchesDirection`, `monthKey`. |

### Shared spine

| File | Lines | What it holds |
| --- | ---: | --- |
| `src/ports/IDatabase.ts` | 1147 | The storage port and every entity type. About 190 lines of it are ledger entities and ledger methods; the rest is attendance, scheduling, memberships, classes. |
| `src/core/errors.ts` | 77 | `DomainError` and five subclasses. Used unchanged. |
| `src/core/constants.ts` | 207 | `EVENT_TYPES` (the event-log vocabulary) and `SYSTEM_ACTOR_ID`. Six event types belong to the ledger. |
| `src/core/policies.ts` | 362 | Role to permission matrix plus `requirePermission`. Four permissions are checked inside the ledger. |
| `src/core/types.ts` | 184 | The `Money` type (integer minor units) and `RecordPaymentResult`. |

### Tests

| File | `it()` blocks | Covers |
| --- | ---: | --- |
| `src/core/billing/BillingService.test.ts` | 60 | `recordPayment` (34), `recordPaymentForInvoice` (17), `previewAllocation` (9). Six of the 60 assert membership-cycle behaviour, which is domain. |
| `src/core/billing/BillingService.applyCredit.test.ts` | 16 | Standing credit applied to open invoices. |
| `src/core/billing/BillingService.voidInvoicePayments.test.ts` | 12 | Reversal. |
| `src/core/billing/BillingService.createManualInvoice.test.ts` | 14 | Ad-hoc charge creation. |
| `src/core/ledger/LedgerService.test.ts` | 29 | Cash ledger, recurring templates, and the payment-to-cash-ledger auto-sync. |
| `src/tests/helpers/MockDatabase.ts` | n/a | 1196-line in-memory implementation of the storage port. Roughly 350 lines are ledger tables. |
| `src/tests/helpers/factories.ts` | n/a | 394 lines of fixture builders, about 80 of them ledger-relevant. |

`invoice-status.ts` has no direct unit test. It is covered indirectly by
`src/tests/actions/invoice-status.characterization.test.ts`, which drives it
through two Next.js server actions with Prisma mocked, so that file cannot move.

Total: 131 `it()` blocks over the ledger surface, plus 12 indirect ones.

## 2. Dependency graph, classified

Walking outward from the two services:

| Dependency | Class | Verdict |
| --- | --- | --- |
| `../../ports/IDatabase` | persistence port (interface only) | Extract the ledger slice of it. No Prisma types leak into it, so this is a type-level cut, not a rewrite. |
| `../errors` | utility | Extract whole. Zero dependencies of its own. |
| `../constants` (`EVENT_TYPES`, `SYSTEM_ACTOR_ID`) | utility | Extract the six ledger event types and the system actor id. The other 30 event types are attendance, scheduling, enrollment. |
| `../policies` (`requirePermission`, `UserRole`) | domain-adjacent | Extract the guard, drop the matrix. See section 3 of DECISIONS.md. |
| `../types` (`Money`) | utility | Extract. It is a type alias plus a doc comment that is the reason the system has no floating-point money. |
| `./invoice-period` (`dueDateForMonth`) | domain | Not needed. Only `generateInvoice` calls it, and `generateInvoice` is out of scope. |
| `@prisma/client` | persistence | Never imported by `src/core`. Nothing to cut. |
| NestJS / any framework | framework | Not present. Lumo is Next.js, and `src/core` imports none of it. |
| Third-party runtime packages | third party | None. The two services import nothing outside `src/`. |

The only true coupling is the storage port, and it is already an interface.

### Domain concepts the ledger references

These are the renames the extraction has to make. Counted across the files
being taken:

| Lumo concept | Occurrences | Generic replacement |
| --- | ---: | --- |
| `studentId` (the party who owes money) | 50 | `accountId` |
| `actorRole` / `UserRole` | 37 | an explicit permission set |
| `classId`, `studentMembershipId`, `sessionId`, `cycleStart`, `cycleEnd` | 21 | dropped, replaced by one optional `reference` string |
| `staffUserId` (who a payroll expense is for) | 11 | `counterpartyId` |
| `payerUserId` (the human who handed over the money) | 10 | `payerId` |
| `findStudentById` / `Student` entity | 3 | `findAccountById` / `Account` (`{ id, organizationId }`) |
| `"Dancer"` in `NotFoundError` messages | 3 | `"Account"` |
| Ledger categories (`TUITION`, `PRIVATE_LESSON`, `HALL_RENTAL`, `COMPETITIONS`, `CAMP`) | 5 enum members | the taxonomy becomes caller-supplied |
| Membership cycle advance | 4 comment blocks, 0 live statements | deleted (v4 already removed the behaviour, only the comments remain) |

About 135 references in the two service files, nearly all of them a single
identifier rename. The same names recur in the storage port and in the tests.

## 3. Invariants the ledger enforces

Each is stated as the code states it, with the file that holds it. These become
the test list.

1. **A posting balances.** `allocated + credit === payment.amount`. Checked at
   runtime inside `recordPayment` with a hard `throw new Error` rather than a
   domain error, because a failure is a programming error, not a user error.
   (`BillingService.ts`, end of `recordPayment`.)
2. **A payment can never have allocated more than it received.** Asserted before
   any reversal work starts. (`BillingService.voidInvoicePayments`.)
3. **Credit cannot be overspent.** `applied <= creditBefore`, checked with a hard
   throw. (`BillingService.applyCredit`.)
4. **Money is integer minor units.** Every amount entry point rejects
   non-integers and non-positives with `ValidationError`. There is no
   floating-point arithmetic anywhere in the ledger. (`BillingService`,
   `LedgerService.assertAmount`.)
5. **Entries are immutable.** A recorded amount is never mutated. Correcting a
   cash row is void plus re-add; correcting a payment is reverse plus re-record.
   Voiding sets metadata and leaves the row. (`LedgerService.voidEntry`,
   `BillingService.voidInvoicePayments`.)
6. **Balances are derived, never stored as truth.** `calculateBalance` sums
   payments minus allocations minus credit notes on every call.
   `computeEffectiveStatus` recomputes an invoice's state from its allocations
   and ignores the stored status column unless the allocations say nothing.
   `computeLedgerTotals` sums the rows. The stored `Invoice.status` is a
   projection that is allowed to lag. (`invoice-status.ts`, `BillingService`,
   `LedgerService`.)
7. **VOID is terminal.** Money landing on a voided invoice never resurrects it,
   in either direction: `computeEffectiveStatus` returns VOID first, and the
   reversal re-projection skips VOID invoices. (`invoice-status.ts`,
   `voidInvoicePayments` step 2.)
8. **Voided rows leave the totals.** `computeLedgerTotals` skips rows with
   `voidedAt`; `findTransactionsByStudent` excludes voided payments so a reversed
   payment cannot come back as standing credit. (`LedgerService`, storage port
   contract.)
9. **Every write is idempotent through the event log.** Each mutating method
   takes a caller-supplied `idempotencyKey`, checks the event log before opening
   the transaction, and writes the event log row inside it. The event row is the
   anchor: if the transaction rolls back, so does the key. The storage layer
   enforces uniqueness on `(organizationId, idempotencyKey)`. (Both services.)
10. **A tenant cannot see another tenant's rows.** Every port method takes
    `organizationId` and filters on it. Rows without their own tenant column
    (`Allocation`) are reached only through a parent that has one. The tenant
    comes from the session in the calling app, never from an argument the user
    controls.
11. **Allocation order is oldest first.** The waterfall allocates to the oldest
    open charge before newer ones, and applying credit consumes the oldest
    unspent payment first.
12. **Preview matches commit.** `previewAllocation` must produce exactly the
    steps `recordPayment` would commit for the same inputs. Lumo tests this
    explicitly as the "parity invariant".
13. **Reversal is all or nothing per payment.** A payment that waterfalled
    across three charges reopens all three. There is no way to un-receive part
    of a payment, because that would break invariant 1.
14. **A recurring template never posts before its day of month**, and never
    twice for the same `(template, month)`.
15. **Editing a template does not touch already-posted rows.** Templates affect
    future materializations only.

Two things that look like invariants but are not, and are reported as found:

- **Currency is not checked.** Amounts carry a currency string, and nothing
  compares the currency of a payment with the currency of the charge it settles.
  A ledger is multi-currency in the sense that the currency travels with every
  row and is never assumed, but there is no guard against mixing. This is
  extracted as-is and documented, not fixed. Adding a guard would be inventing a
  feature.
- **`OVERDUE` is never written.** Nothing in Lumo stores `OVERDUE` on an invoice;
  it is derived from the due date at read time. The waterfall still accepts it as
  an input status, because rows imported from elsewhere might carry it.

## 4. Extraction estimate

- 8 source files to write (5 of them mostly mechanical: errors, money, event
  types, permissions, the storage port).
- About 135 domain identifier references to rename in the services, plus the
  same names again in the port and the test fixtures.
- 131 existing tests over the surface. Of those, roughly 110 port with renames
  only; 6 assert membership behaviour and are dropped with the feature; the rest
  need small rewrites where they seeded a domain field.
- 1 file (`invoice-status.ts`) has no portable test and needs new tests written.
- No adapter shims, no stubs, no behaviour changes expected.

## 5. Verdict: EXTRACTABLE

The ledger was already written to be extractable, for reasons that had nothing
to do with this exercise. `src/core` was built under a rule the codebase calls
the golden rule: no ORM imports, no HTTP, no file I/O, all storage through one
injected port, tenant id passed explicitly on every call. That rule is what makes
this a rename job rather than a rewrite.

What has to change is naming, not structure:

- The party that owes money is called a student. It becomes an account.
- The expense categories are a dance studio's chart of accounts. The taxonomy
  becomes an argument.
- Authorization arrives as a role from a fixed six-role matrix. It becomes a
  permission set, so the caller keeps its own roles.

One genuine loss: `Invoice` carries five foreign keys to Lumo tables (class,
membership, session, cycle start and end). They are dropped rather than
genericised, and a single optional `reference` string replaces them. Nothing in
the extracted logic reads them except the reversal result, which reports
`invoice.month`, and that field survives.
