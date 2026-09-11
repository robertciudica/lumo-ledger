# lumo-ledger

The accounting core of [Lumo](https://lumo.dance), a multi-tenant SaaS for dance
studios, extracted as a standalone package. It runs in production behind paying
customers, recording what people owe, what they paid, and what money moved. It
was written and is maintained by one person. This is the same logic, with the
studio-specific names replaced by generic ones, not a demo.

There are two ledgers and one event log. `BillingService` is the receivables
side: charges, payments, allocations, standing credit, reversal. `LedgerService`
is the cash side: money in, money out, recurring expenses. A payment writes to
both in one transaction, and every mutating call also writes one event row keyed
by an idempotency key the caller supplies.

## The rules it enforces

1. **A posting balances.** `allocated + credit === amount received`, checked at
   runtime. If it fails, money has gone missing inside one function.
2. **Money is integer minor units.** Every entry point rejects a non-integer,
   because 0.1 + 0.2 has no business near somebody's balance.
3. **Entries are immutable.** Correcting a cash row is void plus re-add;
   correcting a payment is reverse plus re-record. Voided rows stay, flagged, and
   drop out of the totals.
4. **Balances are derived, never stored.** A balance is payments minus
   allocations minus credit notes, recomputed on every call.
5. **VOID is terminal.** Money landing on a voided charge never resurrects it.
6. **Every write is idempotent through the event log.** The key is checked before
   the transaction and written inside it, so a rollback releases it.
7. **A tenant cannot reach another tenant's rows.** Every storage call takes a
   tenant id; rows without a tenant column are reached through a parent.
8. **Allocation is oldest first**, for payments and for standing credit.
9. **Reversal is all or nothing per payment.** A payment that covered three
   charges reopens all three. Un-receiving part of one would break rule 1.

## Usage

```ts
import { BillingService, InMemoryLedgerStore } from 'lumo-ledger'

const store = new InMemoryLedgerStore()
const billing = new BillingService(store, { paymentCategory: 'SALES' })

const actor = {
  actorId: 'user_7',
  actorPermissions: ['RECORD_PAYMENT'] as const,
  organizationId: 'tenant_a',
}

// An account is an id inside a tenant. Everything else about the party lives
// in your system, not here.
store.seed.accounts.push({ id: 'acc_1', organizationId: 'tenant_a' })

await billing.createManualInvoice({
  accountId: 'acc_1',
  amount: 5000,          // 50.00, in minor units
  currency: 'EUR',
  dueDate: new Date('2026-01-31'),
  description: 'January',
  month: '2026-01',
  createdBy: actor.actorId,
  organizationId: actor.organizationId,
})
// ...and the same again for February.

// 70.00 arrives: it covers January in full and 20.00 of February.
const result = await billing.recordPayment({
  ...actor,
  idempotencyKey: 'payment-2026-02-03-a1b2',
  accountId: 'acc_1',
  payerId: 'person_9',
  amount: 7000,
  currency: 'EUR',
  paymentMethod: 'BANK_TRANSFER',
})
// result.allocated === 7000, result.credit === 0
// Replaying that key throws IdempotencyError instead of taking the money twice.
```

The runnable version, with the cash ledger and assertions, is
`test/readme-example.test.ts`.

## Design decisions

**Allocations are deleted on reversal, not flagged.** An allocation is a derived
join; the money facts are the payment and the charge. Every read path answers "is
this charge paid?" by summing allocations for one charge id, so deleting them
makes every view self-heal. A flag would need each of those paths to remember to
exclude it, and one that forgot would show a charge as paid by money that never
arrived. The event row keeps a full snapshot, which is what makes the delete
acceptable.

**The unit of reversal is the charge, not the payment.** A charge settled by two
partial payments is cleared in one call. People think "this charge is wrong", not
"the second of these two payments is wrong". Picking one payment out of several
was rejected because it invites the half-reversal that breaks rule 1. In
production this turns fixing a mistyped amount into one action.

**The stored status is a projection, and the allocations are the truth.** Writing
a status and then ignoring it on read sounds redundant until the column drifts:
it is written by one path and read by five. `computeEffectiveStatus` is what
stopped four screens disagreeing about the same charge. Overdue is part of that:
nothing writes it, it falls out of the due date at read time, and before that an
account three weeks late looked identical to one due at month end.

**Tenant id is an argument, never ambient.** No request context, no
async-local storage. Every call site has to say which tenant it means, which is
the point: a tenant cannot be inherited by accident. Lumo once leaked across
tenants through a table that had no tenant column of its own, and being explicit
is what made that findable.

**Currency travels with every row but is never compared.** A payment in one
currency will settle a charge in another, at face value. This is a real gap. It
is characterized by a test rather than fixed here, because fixing it would be
inventing behaviour the production system does not have. If you run more than one
currency per tenant, guard it at your edge.

## What is not here

- **The domain.** Nothing that prices a charge. Pricing decides an amount; this
  takes the amount.
- **A persistence choice.** One interface, `LedgerStore`, and one in-memory
  implementation. Lumo's real one is Postgres behind the same interface.
- **An HTTP layer.** The package throws typed errors and lets the caller
  translate them.
- **Read models.** The ledger writes events; reporting is built on top.

## Running it

```
npm install
npm test        # no database, no network, no env vars
npm run build   # dist/ with type declarations
```

`DISCOVERY.md` is the extraction survey, `BOUNDARY.md` the public API,
`DECISIONS.md` every judgement call made along the way, and `AGENTS.md` the short
version for a coding agent.

MIT.
