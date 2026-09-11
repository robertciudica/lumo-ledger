/**
 * The invariants, asserted directly.
 *
 * Every test in this file is: added during extraction, not from Lumo.
 *
 * The behaviour each one covers is exercised somewhere in the ported suites as
 * a side effect of a feature test. This file states the rules on their own, so
 * that breaking one fails a test whose name says which rule broke. It also
 * characterizes the one place the ledger does less than you would expect.
 */

import {
  BillingService,
  LedgerService,
  InMemoryLedgerStore,
  computeLedgerTotals,
} from '../src'
import {
  accountFactory,
  invoiceFactory,
  transactionFactory,
  allocationFactory,
} from '../src/testing/factories'
import { MANAGER, TAXONOMY, PAYMENT_CATEGORY } from './helpers'

const ORG = 'org_1'

function setup() {
  const db = new InMemoryLedgerStore()
  db.reset()
  const billing = new BillingService(db, { paymentCategory: PAYMENT_CATEGORY })
  const cash = new LedgerService(db, TAXONOMY)
  db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: ORG }))
  return { db, billing, cash }
}

const pay = (billing: BillingService, key: string, amount: number, accountId = 'acc_1') =>
  billing.recordPayment({
    idempotencyKey:   key,
    accountId,
    payerId:          'payer_1',
    amount,
    currency:         'USD',
    paymentMethod:    'CASH',
    actorId:          'operator_1',
    actorPermissions: MANAGER,
    organizationId:   ORG,
  })

// ─────────────────────────────────────────────────────────────────────────────
// A payment can never have allocated more than it received
// ─────────────────────────────────────────────────────────────────────────────

describe('invariant: allocations never exceed the payment they came from', () => {
  it('refuses to reverse a payment whose allocations exceed its amount', async () => {
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', amount: 5000, status: 'PAID', accountId: 'acc_1', organizationId: ORG })
    )
    db.seed.transactions.push(
      transactionFactory({ id: 'txn_1', amount: 1000, accountId: 'acc_1', organizationId: ORG })
    )
    // Corrupt state: 2000 allocated out of a 1000 payment.
    db.seed.allocations.push(
      allocationFactory({ id: 'alloc_1', amount: 2000, transactionId: 'txn_1', invoiceId: 'inv_1' })
    )

    // A plain Error, not a DomainError: this is a programming or data fault and
    // must not be caught and shown to somebody as a validation message.
    await expect(
      billing.voidInvoicePayments({
        idempotencyKey:   'undo_corrupt',
        invoiceId:        'inv_1',
        actorId:          'operator_1',
        actorPermissions: MANAGER,
        organizationId:   ORG,
      })
    ).rejects.toThrow(/invariant violation/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Entries are immutable
// ─────────────────────────────────────────────────────────────────────────────

describe('invariant: recorded amounts are never mutated', () => {
  it('keeps the original amount on a reversed payment', async () => {
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', amount: 2000, status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )
    await pay(billing, 'pay_1', 2000)

    await billing.voidInvoicePayments({
      idempotencyKey:   'undo_1',
      invoiceId:        'inv_1',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

    const txn = db.seed.transactions[0]
    expect(txn.amount).toBe(2000) // unchanged
    expect(txn.voidedAt).toBeInstanceOf(Date)
  })

  it('keeps the original amount on a voided cash row', async () => {
    const { db, cash } = setup()
    const added = await cash.addEntry({
      idempotencyKey:   'cash_1',
      direction:        'OUT',
      category:         'SUPPLIES',
      amount:           140,
      currency:         'USD',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

    await cash.voidEntry({
      idempotencyKey:   'cash_void_1',
      entryId:          added.id,
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

    const row = db.seed.ledgerEntries[0]
    expect(row.amount).toBe(140) // unchanged
    expect(row.voidedAt).toBeInstanceOf(Date)
    expect(computeLedgerTotals(db.seed.ledgerEntries).out).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The event log is the idempotency anchor
// ─────────────────────────────────────────────────────────────────────────────

describe('invariant: one event row per mutating operation, keyed for idempotency', () => {
  it('writes exactly one event row per operation', async () => {
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_1', amount: 2000, status: 'PENDING', accountId: 'acc_1', organizationId: ORG })
    )

    await pay(billing, 'pay_1', 2000)

    expect(db.seed.eventLogs).toHaveLength(1)
    expect(db.seed.eventLogs[0].idempotencyKey).toBe('pay_1')
  })

  it('relies on a store-level unique constraint, not only on the pre-flight read', async () => {
    // The pre-flight check can lose a race; the constraint cannot. A store that
    // does not enforce this would make every idempotency test here worthless.
    const { db } = setup()
    const row = {
      type:           'TRANSACTION_RECORDED' as const,
      payload:        {},
      actorId:        'operator_1',
      actorType:      'HUMAN' as const,
      idempotencyKey: 'racing_key',
    }
    await db.createEventLog(row, ORG)
    await expect(db.createEventLog(row, ORG)).rejects.toThrow(/unique constraint/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Tenant isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('invariant: a tenant cannot reach another tenant rows', () => {
  it('computes a balance from this tenant rows only', async () => {
    const { db, billing } = setup()
    db.seed.accounts.push(accountFactory({ id: 'acc_1', organizationId: 'org_2' }))
    db.seed.transactions.push(
      transactionFactory({ id: 'txn_1', amount: 1000, accountId: 'acc_1', organizationId: 'org_1' }),
      transactionFactory({ id: 'txn_2', amount: 9999, accountId: 'acc_1', organizationId: 'org_2' }),
    )

    expect(await billing.calculateBalance('acc_1', 'org_1')).toBe(1000)
    expect(await billing.calculateBalance('acc_1', 'org_2')).toBe(9999)
  })

  it('previews an allocation against this tenant charges only', async () => {
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_mine', amount: 1000, status: 'PENDING', accountId: 'acc_1', organizationId: 'org_1' }),
      invoiceFactory({ id: 'inv_theirs', amount: 9999, status: 'PENDING', accountId: 'acc_1', organizationId: 'org_2' }),
    )

    const preview = await billing.previewAllocation({
      accountId:      'acc_1',
      amount:         5000,
      organizationId: 'org_1',
    })

    expect(preview.steps.map(s => s.invoiceId)).toEqual(['inv_mine'])
    expect(preview.credit).toBe(4000)
  })

  it('reaches allocations through their charge, which is what scopes them', async () => {
    // An Allocation carries no tenant column. If a store filtered these by id
    // alone, the ledger could not catch it, so this asserts the contract the
    // port documents.
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({ id: 'inv_theirs', amount: 9999, status: 'PENDING', accountId: 'acc_1', organizationId: 'org_2' })
    )
    db.seed.allocations.push(
      allocationFactory({ id: 'alloc_theirs', amount: 9999, invoiceId: 'inv_theirs', transactionId: 'txn_theirs' })
    )

    const mine = await db.findAllocationsByAccount('acc_1', 'org_1')
    expect(mine).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// What the ledger does NOT check
// ─────────────────────────────────────────────────────────────────────────────

describe('known gap: currency is carried, never compared', () => {
  it('allocates a payment to a charge in a different currency', async () => {
    // This is what production does today. The currency string travels with
    // every row and nothing compares the two, so a payment in one currency will
    // settle a charge in another. It is recorded here as a characterization
    // test rather than fixed, because fixing it would be a behaviour change
    // that belongs in Lumo first, not in an extraction.
    const { db, billing } = setup()
    db.seed.invoices.push(
      invoiceFactory({
        id: 'inv_eur', amount: 5000, currency: 'EUR',
        status: 'PENDING', accountId: 'acc_1', organizationId: ORG,
      })
    )

    const result = await billing.recordPayment({
      idempotencyKey:   'pay_usd',
      accountId:        'acc_1',
      payerId:          'payer_1',
      amount:           5000,
      currency:         'USD', // not the charge currency
      paymentMethod:    'CASH',
      actorId:          'operator_1',
      actorPermissions: MANAGER,
      organizationId:   ORG,
    })

    expect(result.allocated).toBe(5000)
    expect(db.seed.invoices.find(i => i.id === 'inv_eur')?.status).toBe('PAID')
  })
})
