# Decisions

Every judgement call made during the extraction, what was chosen, what was
rejected, and why. Written as the work happened.

## 1. Paths

The brief left the repository and output paths as placeholders. Resolved to
`/Users/robert/code/Lumo.dance` for the source (opened read-only, never written
to, never committed to) and `/Users/robert/code/lumo-ledger` for the output.

## 2. Scope: two ledgers, not one

Lumo has two money ledgers that share one event log:

- the receivables ledger in `BillingService` (what is owed, what was paid, and
  which payment covers which charge),
- the cash ledger in `LedgerService` (what money actually moved, in and out).

Taking only the cash ledger was tempting: it is 482 lines, self-contained, and
would have been done in an hour. It was rejected because most of what makes this
code worth reading lives on the other side: the waterfall, standing credit, the
reversal, the balance that is recomputed rather than stored. The two also touch
each other in exactly one place (a payment writes its own cash row), and that
seam is one of the more interesting things in the package. Splitting them would
have hidden it.

Everything that prices a charge is out: `generateInvoice`, `enrollment-invoice`,
`reprice`, `invoice-period`, `price-drift`. Those read a product's pricing model.
The ledger takes an amount and does not ask where it came from.

## 3. Class names kept, directories renamed

`BillingService` and `LedgerService` keep their Lumo names even though
"LedgerService" naming only half of a package called lumo-ledger is confusing at
first glance. Renaming them to `ReceivablesLedger` and `CashLedger` would have
read better and would have made the diff against Lumo harder to follow, which is
the opposite of what an extraction should do. The compromise: the files live in
`src/receivables/` and `src/cash/`, so the directory says the role and the class
still says where it came from.

## 4. Authorization: permissions in, roles out

Lumo passes `actorRole: UserRole` into every method and looks the role up in a
fixed six-role matrix. Three of those roles are domain (teacher, student,
parent), and the matrix is a product decision, not a ledger one.

Chosen: the caller passes `actorPermissions: readonly Permission[]` and the
ledger checks membership. The four permissions it actually checks
(`RECORD_PAYMENT`, `MANAGE_FINANCES`, `ADD_CASHBOOK`, `MANAGE_CASHBOOK`) are
generic accounting capabilities and came across unchanged.

Rejected: inventing a neutral role matrix (owner, manager, clerk). That would
have been a design decision the ledger has no business making, and every caller
would have had to map its real roles onto ours anyway.

Consequence for the tests: the ported permission tests now say "an actor without
RECORD_PAYMENT" where Lumo said "a TEACHER". The assertion is identical.

## 5. Categories: a taxonomy the caller supplies

Lumo's cash categories are a dance studio's chart of accounts, hardcoded as two
arrays: TUITION, PRIVATE_LESSON, HALL_RENTAL, COMPETITIONS, CAMP on the way in;
RENT, UTILITIES, PAYROLL, SUPPLIES, MARKETING on the way out.

Chosen: `LedgerCategory` is a plain string, and `LedgerService` takes a
`CategoryTaxonomy` (`{ in: string[], out: string[] }`) in its constructor. The
guard that made the original interesting is preserved exactly: a category must
be used in the direction its owner declared, and a recurring template must use
an OUT category.

Rejected: shipping a generic default taxonomy. Any list I invented would be
wrong for the next user and would have been a feature nobody in Lumo wrote.

Follow-on: `BillingService` writes a cash row alongside every payment, and in
Lumo that row is hardcoded to the TUITION category. It now takes the category
from a required `BillingConfig.paymentCategory`. No default, because a silently
wrong default would put income in the wrong place, and the failure would be a
quiet one in a monthly report.

## 6. The domain renames

| Lumo | Here | Why |
| --- | --- | --- |
| `studentId` | `accountId` | The party that owes money. |
| `Student` entity | `Account` (`{ id, organizationId }`) | Only the existence check survives; everything else about the party belongs to the host. |
| `payerUserId` | `payerId` | Who handed the money over, which is not always the account holder. |
| `staffUserId` | `counterpartyId` | On a payroll row this is who was paid; the generic name covers the vendor case too. |
| `"Dancer"` in errors | `"Account"` | Error message text only. |
| `classId`, `studentMembershipId`, `sessionId`, `cycleStart`, `cycleEnd` | one optional `reference: string` | Five foreign keys into Lumo tables. Nothing in the extracted logic reads them. |

`Invoice`, `FinancialTransaction`, `Allocation`, `CreditNote`, `LedgerEntry` and
`EventLog` kept their names: those are accounting words, not domain ones. It is
worth saying out loud that `Invoice` here means "a charge somebody owes" and
carries no document, no numbering, no tax handling.

## 7. `IDatabase` narrowed to `LedgerStore`

Lumo's storage port is 1147 lines covering attendance, scheduling, memberships
and classes. Only the ledger slice came across, renamed to `LedgerStore`: 29
methods, every one taking `organizationId`.

Two contract notes that were comments in Lumo are now part of the interface
documentation, because an implementer who misses them gets a silent bug rather
than a compile error:

- `findTransactionsByAccount` must exclude voided payments. If it does not, a
  reversed payment comes back as standing credit and can be spent again.
- `createEventLog` must enforce uniqueness on `(organizationId, idempotencyKey)`
  and throw on a duplicate. The pre-flight idempotency read can lose a race; the
  constraint cannot.

There is a test that asserts the second one against the shipped store, because
if a store does not do it, every idempotency test in the suite is theatre.

## 8. In-memory store ships in `src`, not in `test`

Lumo's `MockDatabase` lives under `src/tests/helpers`. Here the equivalent is
`src/testing/InMemoryLedgerStore.ts` and is exported from the package root. Two
reasons: the brief asks for a shipped in-memory implementation, and anyone
writing their own store needs a reference implementation more than they need a
test fixture.

Rollback is still not emulated, exactly as in Lumo: `runTransaction` calls the
callback with `this`. The doc comment says so. This store proves logic, not
atomicity.

## 9. What was deliberately not fixed

**Currency is never compared.** Every row carries a currency string and nothing
checks that a payment's currency matches the charge it settles. A payment in USD
will settle a charge in EUR at face value. This is real, it is in production, and
it is not fixed here: adding the guard would be inventing a feature and changing
behaviour I cannot test against production. It is characterized instead, in
`test/invariants.test.ts` under "known gap", so the behaviour is documented and
any future fix has a test to flip.

**`OVERDUE` is never written to the stored status.** It is derived from the due
date at read time in `computeEffectiveStatus`. The waterfall still accepts
OVERDUE as an input status, because rows imported from another system can carry
it. Kept as-is.

**`createManualInvoice` has no permission check.** In Lumo the authorization for
that path lives in the calling layer. Preserved, and noted in AGENTS.md so it is
not mistaken for an oversight.

## 10. Test porting

131 `it()` blocks cover this surface in Lumo. What happened to them:

- Ported with renames only: the large majority.
- Dropped: 6 tests asserting that paying does not advance a subscription cycle.
  The feature is not here, so the assertion has nothing to hold.
- Rewritten: the ones that seeded a domain field (a class id, a membership) now
  seed the generic equivalent or nothing.
- Written new, all marked `// added during extraction, not from Lumo`: the
  `invoice-status` suite (Lumo covers it only through a test that drives two
  Next.js server actions with the ORM mocked, which cannot travel), the
  invariants suite, the README example, and a handful of tenant-isolation cases.

The parity test between `previewAllocation` and `recordPayment` came across as-is.
It is the single most valuable test in the package: two code paths implement the
same waterfall, and that test is what stops them drifting.

## 11. Tooling matches Lumo

jest with `ts-jest`, `testEnvironment: 'node'`, `testMatch: ['**/*.test.ts']`,
and a `jest.config.ts` written in TypeScript, because that is what Lumo uses.
TypeScript is strict, target ES2017, same as Lumo's `tsconfig.json`. The build
adds `rootDir`/`outDir`/`declaration` in a separate `tsconfig.build.json` so the
test directory stays out of `dist`.

No runtime dependencies. The ledger imports nothing outside its own `src`.

## 12. Tests live in `test/`, not beside the source

Lumo keeps `*.test.ts` next to the file under test. Here they are in `test/`, so
that `tsconfig.build.json` can include `src` wholesale and `dist` contains only
shipped code. It is the one structural break from the original.
