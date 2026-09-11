/**
 * BillingService: the receivables ledger.
 *
 * Owns: recording payments, waterfall allocation, standing credit, reversal,
 * credit notes, and charge creation.
 *
 * No storage driver, no HTTP, no file I/O. All storage goes through the
 * LedgerStore port injected via the constructor.
 *
 * All monetary values are minor currency units (integers). See Money.
 *
 * The tenant arrives as an explicit `organizationId` parameter on every method.
 * There is no ambient context, no async-local storage, no closure over a
 * request. That is deliberate: it means a tenant can never be inherited by
 * accident, and every call site has to say which tenant it means.
 */

import type {
  LedgerStore,
  PaymentMethod,
  Invoice,
  InvoiceStatus,
  CreditNote,
  CreditNoteReason,
  LedgerCategory,
} from '../store'
import {
  NotFoundError,
  ValidationError,
  IdempotencyError,
  ForbiddenError,
} from '../errors'
import { EVENT_TYPES } from '../events'
import type { Permission } from '../permissions'
import { requirePermission } from '../permissions'
import type { Money } from '../money'
import { monthKey } from '../cash/LedgerService'

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface BillingConfig {
  /**
   * The cash-ledger category used for the IN row written alongside every
   * payment. It must be an income category in the taxonomy the cash ledger was
   * built with, otherwise the two ledgers will disagree about direction.
   */
  readonly paymentCategory: LedgerCategory
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter and result types
// ─────────────────────────────────────────────────────────────────────────────

export interface RecordPaymentParams {
  /**
   * Caller-supplied idempotency key. Must be unique per payment attempt.
   * If the same key is submitted twice, IdempotencyError is thrown and the
   * caller can safely return the previously-recorded result.
   */
  idempotencyKey: string
  accountId: string
  /**
   * Who physically handed the money over. This is NOT the actor: the actor is
   * whoever is operating the system.
   */
  payerId: string
  /** Payment amount in minor currency units (integer). Must be > 0. */
  amount: Money
  currency: string
  paymentMethod: PaymentMethod
  notes?: string
  /** Who is recording this payment. */
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

/**
 * Result of recording a payment.
 * `allocated` is the total amount matched to open charges.
 * `credit` is the unallocated remainder that stays on account.
 * Invariant: allocated + credit === payment amount.
 */
export interface RecordPaymentResult {
  readonly transactionId: string
  readonly allocated: Money
  readonly credit: Money
}

export interface RecordPaymentForInvoiceParams {
  idempotencyKey: string
  /** The charge to pay. Amount must not exceed its outstanding balance. */
  invoiceId: string
  /** Payment amount in minor currency units. Must be > 0 and <= outstanding. */
  amount: Money
  currency: string
  paymentMethod: PaymentMethod
  notes?: string
  payerId: string
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

export interface PreviewAllocationParams {
  accountId: string
  amount: Money
  organizationId: string
}

export interface AllocationStep {
  invoiceId: string
  month: string | null
  /** Outstanding balance before this step's allocation. */
  outstanding: Money
  /** Amount to allocate in this step. */
  toAllocate: Money
  /** Predicted status after this step. */
  newStatus: InvoiceStatus
}

export interface PreviewAllocationResult {
  steps: AllocationStep[]
  totalAllocated: Money
  credit: Money
}

export interface VoidInvoicePaymentsParams {
  idempotencyKey: string
  /** The charge to clear. EVERY live payment on it is reversed. */
  invoiceId: string
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

export interface VoidInvoicePaymentsResult {
  invoiceId: string
  /** Sum of the FULL amount of every payment reversed, never a partial figure. */
  amountReversed: Money
  paymentsReversed: number
  allocationsRemoved: number
  /**
   * Every charge the reversal touched: normally just the one, but a payment
   * that waterfalled across several is reversed in full, so the others reopen.
   *
   * `month` is the charge's billing period, and the caller needs it: a read
   * model that buckets figures by billing period has to recompute that period,
   * not the current one. Undoing a payment against a March charge moves
   * March's figures even if it happens in August.
   */
  invoicesReopened: Array<{
    invoiceId: string
    month: string | null
    status: InvoiceStatus
  }>
  ledgerEntriesVoided: number
}

export interface ApplyCreditNoteParams {
  idempotencyKey: string
  accountId: string
  amount: Money
  currency: string
  reason: CreditNoteReason
  notes?: string
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

export interface ApplyCreditParams {
  idempotencyKey: string
  accountId: string
  /**
   * Target a single charge. When omitted, credit waterfalls across every open
   * charge for the account, oldest first, the same rule as `recordPayment`.
   */
  invoiceId?: string
  actorId: string
  actorPermissions: readonly Permission[]
  organizationId: string
}

/**
 * Outcome of applying an account's standing credit.
 *
 * Invariant: `applied + remainingCredit === spendable credit before the call`.
 */
export interface ApplyCreditResult {
  /** Credit consumed by this call, in minor units. */
  readonly applied: Money
  /** Spendable credit still sitting on the account afterwards. */
  readonly remainingCredit: Money
  /** Ids of the charges that received an allocation. */
  readonly invoicesTouched: string[]
}

export interface CreateManualInvoiceParams {
  accountId: string
  /** Amount in minor currency units. Must be a positive integer. */
  amount: Money
  currency: string
  dueDate: Date
  /** Short human-readable description. */
  description: string
  /** Opaque caller reference, an order id, a contract id, anything. */
  reference?: string
  /** Billing period this charge belongs to, as "YYYY-MM". */
  month?: string
  /** Internal memo. */
  notes?: string
  /** Who is creating the charge. Used for the event-log audit row. */
  createdBy: string
  organizationId: string
}

// ─────────────────────────────────────────────────────────────────────────────
// BillingService
// ─────────────────────────────────────────────────────────────────────────────

export class BillingService {
  constructor(
    private readonly db: LedgerStore,
    private readonly config: BillingConfig
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // recordPayment
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Records a payment from a payer and performs waterfall allocation against
   * the account's open charges, oldest first.
   *
   * WATERFALL ALLOCATION ALGORITHM
   * ─────────────────────────────
   * Given: payment amount P, open charges I1, I2, … In sorted by createdAt asc
   *
   * remaining = P
   * for each charge Ii (oldest first):
   *   outstanding = Ii.amount - sum(existing allocations for Ii)
   *   toAllocate  = min(remaining, outstanding)
   *   write Allocation(transactionId, Ii.id, toAllocate)
   *   remaining  -= toAllocate
   *   if remaining == 0: break
   * credit = remaining  // unallocated portion, stays on account
   *
   * Invariant (must always hold): allocated + credit === params.amount
   *
   * WORKED EXAMPLE
   * ──────────────
   * Account has two open charges:
   *   Charge A (Jan): amount=5000, allocated=0    -> outstanding=5000
   *   Charge B (Feb): amount=5000, allocated=2000 -> outstanding=3000
   * Payment received: 7000
   *
   * Step 1: toAllocate = min(7000, 5000) = 5000 -> Charge A fully paid
   *         remaining = 7000 - 5000 = 2000
   * Step 2: toAllocate = min(2000, 3000) = 2000 -> Charge B partially paid
   *         remaining = 2000 - 2000 = 0
   *
   * Result: allocated=7000, credit=0
   *
   * @throws {ForbiddenError}     if the actor lacks RECORD_PAYMENT
   * @throws {ValidationError}    if amount <= 0 or is not an integer
   * @throws {IdempotencyError}   if this idempotencyKey was already processed
   * @throws {NotFoundError}      if the account is not in this organization
   */
  async recordPayment(params: RecordPaymentParams): Promise<RecordPaymentResult> {
    // ── Guard: permission check ──────────────────────────────────────────────
    requirePermission(params.actorPermissions, 'RECORD_PAYMENT')

    // ── Guard: amount must be positive ──────────────────────────────────────
    if (params.amount <= 0) {
      throw new ValidationError('Payment amount must be positive', 'amount')
    }

    // ── Guard: amount must be an integer (minor currency units) ─────────────
    if (!Number.isInteger(params.amount)) {
      throw new ValidationError(
        'Payment amount must be an integer (minor currency units, no decimals)',
        'amount'
      )
    }

    // ── Idempotency check (outside transaction, cheap read) ─────────────────
    // We check before opening the transaction to avoid holding a lock during
    // the read. The event-log write inside the transaction is the atomic
    // idempotency anchor; this check is the fast path, not the guarantee.
    const existing = await this.db.findEventLogByKey(
      params.idempotencyKey,
      params.organizationId
    )
    if (existing) {
      throw new IdempotencyError(params.idempotencyKey)
    }

    // ── Load account (outside transaction, read-only check) ─────────────────
    const account = await this.db.findAccountById(
      params.accountId,
      params.organizationId
    )
    if (!account) {
      throw new NotFoundError('Account', params.accountId)
    }

    // ── Atomic transaction: payment, allocations, event log, cash row ────────
    return this.db.runTransaction(async (tx: LedgerStore): Promise<RecordPaymentResult> => {
      // ── Step 1: Create the payment record ─────────────────────────────────
      const now = new Date()
      const transaction = await tx.createTransaction(
        {
          amount:         params.amount,
          currency:       params.currency,
          paymentMethod:  params.paymentMethod,
          paymentDate:    now,
          notes:          params.notes,
          idempotencyKey: params.idempotencyKey,
          recordedBy:     params.actorId,
          payerId:        params.payerId,
          accountId:      params.accountId,
        },
        params.organizationId
      )

      // ── Step 2: Load open charges for waterfall allocation ────────────────
      // Filter to PENDING, PARTIALLY_PAID or OVERDUE, sort oldest first.
      // "Oldest first" means allocating to the most overdue debt before newer
      // debt: the standard accounting waterfall.
      const allInvoices = await tx.findInvoicesByAccount(
        params.accountId,
        params.organizationId
      )
      const openInvoices = allInvoices
        .filter(inv =>
          inv.status === 'PENDING' ||
          inv.status === 'PARTIALLY_PAID' ||
          // OVERDUE charges are still owed and must be included in the
          // waterfall. Excluding them would record the payment as credit while
          // leaving the overdue charge outstanding, which is a reconciliation
          // bug that only shows up at month end.
          inv.status === 'OVERDUE'
        )
        // Ascending by createdAt: oldest unpaid charge first.
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

      // ── Step 3: Waterfall allocation ─────────────────────────────────────
      // `remaining` tracks how much of the payment is still unallocated.
      // `allocated` accumulates the total matched to charges.
      // Integers throughout: no floating-point arithmetic.
      //
      // `invoiceStatusUpdates` collects charges that need a status change
      // after allocation (step 4, the projection update).
      let remaining: Money = params.amount
      let allocated: Money = 0
      const invoiceStatusUpdates: Array<{ id: string; newStatus: InvoiceStatus }> = []

      for (const invoice of openInvoices) {
        // Short-circuit: nothing left to allocate
        if (remaining <= 0) break

        // Compute true outstanding by summing prior allocations. This is what
        // prevents double-allocation on a partially paid charge.
        const priorAllocations = await tx.findAllocationsByInvoice(
          invoice.id,
          params.organizationId
        )
        const priorAllocated: Money = priorAllocations.reduce(
          (sum, a) => sum + a.amount,
          0
        )
        const outstanding: Money = invoice.amount - priorAllocated

        // Skip fully-paid charges that still carry a stale status
        if (outstanding <= 0) continue

        const toAllocate: Money = Math.min(remaining, outstanding)

        await tx.createAllocation(
          {
            amount:        toAllocate,
            createdBy:     params.actorId,
            transactionId: transaction.id,
            invoiceId:     invoice.id,
          },
          params.organizationId
        )

        remaining -= toAllocate
        allocated += toAllocate

        // Track the new total allocated for this charge to determine status
        const newTotalAllocated = priorAllocated + toAllocate
        const newStatus: InvoiceStatus =
          newTotalAllocated >= invoice.amount ? 'PAID' : 'PARTIALLY_PAID'

        // Only update if the status actually changes
        if (newStatus !== invoice.status) {
          invoiceStatusUpdates.push({ id: invoice.id, newStatus })
        }
      }

      // ── Step 4: Update the status projection ──────────────────────────────
      // After creating allocations, project the new status onto each affected
      // charge, so a reader gets the right answer without recomputing from
      // allocations. The allocations remain the truth; this is a cache.
      for (const { id, newStatus } of invoiceStatusUpdates) {
        await tx.updateInvoice(id, { status: newStatus }, params.organizationId)
      }

      // ── Step 5: Write the event log, the idempotency anchor ──────────────
      // If the transaction commits, the key is anchored and any retry hits the
      // check above. If the transaction rolls back, the event row rolls back
      // with it, and the operation is safe to retry.
      await tx.createEventLog(
        {
          type:           EVENT_TYPES.TRANSACTION_RECORDED,
          payload: {
            transactionId: transaction.id,
            amount:        params.amount,
            currency:      params.currency,
            allocated,
            credit:        remaining,
            accountId:     params.accountId,
            payerId:       params.payerId,
          },
          actorId:        params.actorId,
          actorType:      'HUMAN',
          idempotencyKey: params.idempotencyKey,
        },
        params.organizationId
      )

      // ── Step 6: Write the matching cash-ledger IN row ─────────────────────
      // Every payment lands here regardless of method: the cash ledger is the
      // money-in view, not a physical-cash-only till. It records the FULL
      // amount received, not just the allocated portion, because that is what
      // arrived. Idempotency is covered by the event row above.
      await tx.createLedgerEntry(
        {
          direction:     'IN',
          category:      this.config.paymentCategory,
          amount:        params.amount,
          currency:      params.currency,
          occurredAt:    now,
          month:         monthKey(now),
          note:          null,
          source:        'PAYMENT',
          createdBy:     params.actorId,
          transactionId: transaction.id,
        },
        params.organizationId
      )

      // ── Invariant: allocated + credit must equal the original amount ──────
      // A failure here is a programming error, not a domain error, so it
      // throws a plain Error rather than a DomainError: it must not be caught
      // and rendered to a user as though they did something wrong.
      const total: Money = allocated + remaining
      if (total !== params.amount) {
        throw new Error(
          `BillingService invariant violation: allocated(${allocated}) + credit(${remaining}) = ${total} !== amount(${params.amount})`
        )
      }

      return {
        transactionId: transaction.id,
        allocated,
        credit: remaining,
      }
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // recordPaymentForInvoice
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Records a payment targeted at one specific charge.
   *
   * Targeted, not waterfall. Unlike `recordPayment`, which distributes across
   * all open charges oldest-first, this allocates the entire payment to exactly
   * one charge. Overpayment beyond that charge's outstanding balance is
   * rejected; use `recordPayment` for the "money came in, spread it" case.
   *
   * WORKED EXAMPLE
   * ──────────────
   * Charge B (Feb): amount=5000, previously allocated=2000 -> outstanding=3000
   * Payment received: 3000
   *
   * toAllocate = 3000 (exact outstanding)
   * Charge B status -> PAID
   * credit = 0  (targeted can never produce credit by contract)
   *
   * @throws {ForbiddenError}     if the actor lacks RECORD_PAYMENT
   * @throws {ValidationError}    if amount <= 0, non-integer, or exceeds outstanding
   * @throws {IdempotencyError}   if this idempotencyKey was already processed
   * @throws {NotFoundError}      if the charge is not in this organization
   * @throws {ValidationError}    if the charge is PAID or VOID (not payable)
   */
  async recordPaymentForInvoice(
    params: RecordPaymentForInvoiceParams
  ): Promise<RecordPaymentResult> {
    // ── Guard: permission check ──────────────────────────────────────────────
    requirePermission(params.actorPermissions, 'RECORD_PAYMENT')

    // ── Guard: amount must be positive ──────────────────────────────────────
    if (params.amount <= 0) {
      throw new ValidationError('Payment amount must be positive', 'amount')
    }

    // ── Guard: amount must be an integer (minor currency units) ─────────────
    if (!Number.isInteger(params.amount)) {
      throw new ValidationError(
        'Payment amount must be an integer (minor currency units, no decimals)',
        'amount'
      )
    }

    // ── Idempotency check (outside transaction, cheap read) ─────────────────
    const existing = await this.db.findEventLogByKey(
      params.idempotencyKey,
      params.organizationId
    )
    if (existing) {
      throw new IdempotencyError(params.idempotencyKey)
    }

    // ── Load the charge ──────────────────────────────────────────────────────
    const invoice = await this.db.findInvoiceById(
      params.invoiceId,
      params.organizationId
    )
    if (!invoice) {
      throw new NotFoundError('Invoice', params.invoiceId)
    }

    // ── Reject unpayable statuses ────────────────────────────────────────────
    if (invoice.status === 'PAID' || invoice.status === 'VOID') {
      throw new ValidationError('Invoice is not payable', 'invoiceId')
    }

    // ── Compute outstanding balance from prior allocations ───────────────────
    const priorAllocations = await this.db.findAllocationsByInvoice(
      params.invoiceId,
      params.organizationId
    )
    const priorAllocated: Money = priorAllocations.reduce(
      (sum, a) => sum + a.amount,
      0
    )
    const outstanding: Money = invoice.amount - priorAllocated

    // ── Cap check: amount must not exceed outstanding ────────────────────────
    // The targeted flow rejects overpayment. No credit spillover.
    if (params.amount > outstanding) {
      throw new ValidationError(
        `Amount exceeds invoice outstanding (${outstanding})`,
        'amount'
      )
    }

    // ── Atomic transaction ───────────────────────────────────────────────────
    return this.db.runTransaction(async (tx: LedgerStore): Promise<RecordPaymentResult> => {
      const now = new Date()

      // Step 1: Create the payment record
      const transaction = await tx.createTransaction(
        {
          amount:         params.amount,
          currency:       params.currency,
          paymentMethod:  params.paymentMethod,
          paymentDate:    now,
          notes:          params.notes,
          idempotencyKey: params.idempotencyKey,
          recordedBy:     params.actorId,
          payerId:        params.payerId,
          accountId:      invoice.accountId,
        },
        params.organizationId
      )

      // Step 2: Create the single allocation against this charge
      await tx.createAllocation(
        {
          amount:        params.amount,
          createdBy:     params.actorId,
          transactionId: transaction.id,
          invoiceId:     params.invoiceId,
        },
        params.organizationId
      )

      // Step 3: Project the status
      const newTotalAllocated: Money = priorAllocated + params.amount
      const newStatus: InvoiceStatus =
        newTotalAllocated >= invoice.amount ? 'PAID' : 'PARTIALLY_PAID'

      await tx.updateInvoice(
        params.invoiceId,
        { status: newStatus },
        params.organizationId
      )

      // Step 4: Write the event log, the idempotency anchor.
      // `targeted: true` distinguishes this allocation from a waterfall one in
      // an audit, without needing a join through the allocation rows.
      await tx.createEventLog(
        {
          type:    EVENT_TYPES.TRANSACTION_RECORDED,
          payload: {
            transactionId: transaction.id,
            invoiceId:     params.invoiceId,
            amount:        params.amount,
            currency:      params.currency,
            accountId:     invoice.accountId,
            payerId:       params.payerId,
            targeted:      true,
          },
          actorId:        params.actorId,
          actorType:      'HUMAN',
          idempotencyKey: params.idempotencyKey,
        },
        params.organizationId
      )

      // ── Write the matching cash-ledger IN row ─────────────────────────────
      // Full amount received. Idempotency covered by the event row above.
      await tx.createLedgerEntry(
        {
          direction:     'IN',
          category:      this.config.paymentCategory,
          amount:        params.amount,
          currency:      params.currency,
          occurredAt:    now,
          month:         monthKey(now),
          note:          null,
          source:        'PAYMENT',
          createdBy:     params.actorId,
          transactionId: transaction.id,
        },
        params.organizationId
      )

      // Targeted payments never produce credit: the cap check above ensures it.
      return {
        transactionId: transaction.id,
        allocated:     params.amount,
        credit:        0,
      }
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // voidInvoicePayments
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Clears a charge back to unpaid by reversing EVERY payment on it: the money
   * is asserted never to have arrived.
   *
   * This is the reverse of recordPayment and recordPaymentForInvoice, and the
   * only way to correct a mistyped amount, because a payment's amount is never
   * mutated. To fix "2000 recorded, 1000 actually paid": undo, then record 1000.
   *
   * THE UNIT IS THE CHARGE, NOT THE PAYMENT
   * ───────────────────────────────────────
   * A charge settled by two partial payments is cleared by one call. People
   * think "this charge is wrong", not "the second of the two payments is
   * wrong", so there is deliberately no way to pick one payment out of several.
   *
   * WHAT IT TOUCHES
   * ───────────────
   *   1. Deletes every allocation belonging to every payment being reversed.
   *   2. Re-projects each touched charge's status from its REMAINING allocations.
   *   3. Sets void metadata on each payment. The rows survive; this is history.
   *   4. Voids the matching cash-ledger IN rows, so the cash leaves the totals.
   *   5. Writes ONE event row snapshotting everything removed.
   *
   * WHY THE ALLOCATIONS ARE DELETED RATHER THAN FLAGGED
   * ───────────────────────────────────────────────────
   * An allocation is a derived join; the money facts are the payment and the
   * charge. Every read path computes "is this charge paid?" by summing
   * allocations for an invoiceId, without joining back to the payment, so
   * deleting the rows makes every view self-heal with no filtering. A flag
   * would need every one of those call sites to remember to exclude it. The
   * event-log snapshot in step 5 is what preserves the audit trail.
   *
   * ALL OR NOTHING PER PAYMENT
   * ──────────────────────────
   * A payment is reversed in full, so one that waterfalled across three charges
   * reopens all three, not just the one being cleared. You cannot un-receive
   * part of a payment: trimming a single allocation would break the invariant
   * `payment amount = sum(allocations) + credit`, and would leave the other
   * charges propped up by money we just declared never arrived.
   *
   * This is not a refund. Cash actually handed back is an OUT row on the cash
   * ledger.
   *
   * @throws {ForbiddenError}   if the actor lacks MANAGE_FINANCES
   * @throws {IdempotencyError} if this idempotencyKey was already processed
   * @throws {NotFoundError}    if the charge is not in this organization
   * @throws {ValidationError}  if the charge has no live payments to undo
   */
  async voidInvoicePayments(
    params: VoidInvoicePaymentsParams
  ): Promise<VoidInvoicePaymentsResult> {
    // ── Guard: permission ─────────────────────────────────────────────────────
    // MANAGE_FINANCES, not RECORD_PAYMENT: taking money in and reversing it are
    // deliberately different capabilities.
    requirePermission(params.actorPermissions, 'MANAGE_FINANCES')

    // ── Idempotency check (outside transaction, cheap read) ─────────────────
    // One key covers the whole operation, however many payments it reverses.
    const existingEvent = await this.db.findEventLogByKey(
      params.idempotencyKey,
      params.organizationId
    )
    if (existingEvent) {
      throw new IdempotencyError(params.idempotencyKey)
    }

    // ── Load the charge ──────────────────────────────────────────────────────
    const invoice = await this.db.findInvoiceById(
      params.invoiceId,
      params.organizationId
    )
    if (!invoice) {
      throw new NotFoundError('Invoice', params.invoiceId)
    }

    // ── Resolve which payments settled it ────────────────────────────────────
    const invoiceAllocations = await this.db.findAllocationsByInvoice(
      params.invoiceId,
      params.organizationId
    )
    const transactionIds = [...new Set(invoiceAllocations.map(a => a.transactionId))]

    const candidates = await Promise.all(
      transactionIds.map(id => this.db.findTransactionById(id, params.organizationId))
    )
    // Drop already-voided rows defensively: their allocations should have been
    // deleted, so they should not appear here at all.
    const payments = candidates.filter(
      (t): t is NonNullable<typeof t> => t != null && t.voidedAt == null
    )

    if (payments.length === 0) {
      throw new ValidationError('No payments to undo on this invoice', 'invoiceId')
    }

    // ── Load everything each payment touched ─────────────────────────────────
    const perPayment = await Promise.all(
      payments.map(async payment => {
        const [allocations, ledgerEntries] = await Promise.all([
          this.db.findAllocationsByTransaction(payment.id, params.organizationId),
          this.db.findLedgerEntriesByTransaction(payment.id, params.organizationId),
        ])

        // Invariant: a payment can never have allocated more than it received.
        const totalAllocated: Money = allocations.reduce((sum, a) => sum + a.amount, 0)
        if (totalAllocated > payment.amount) {
          throw new Error(
            `BillingService invariant violation: allocations(${totalAllocated}) exceed payment amount(${payment.amount}) on ${payment.id}`
          )
        }

        return { payment, allocations, ledgerEntries }
      })
    )

    const allAllocations = perPayment.flatMap(p => p.allocations)
    const allLedgerEntries = perPayment.flatMap(p => p.ledgerEntries)

    // Every charge reached by any of these payments, not just the one being
    // cleared. Allocations are deleted in full (see ALL OR NOTHING above), so a
    // charge a payment also covered must be re-projected or it would keep
    // reading as paid.
    const touchedInvoiceIds = [...new Set(allAllocations.map(a => a.invoiceId))]

    // ── Atomic transaction ───────────────────────────────────────────────────
    return this.db.runTransaction(
      async (tx: LedgerStore): Promise<VoidInvoicePaymentsResult> => {
        // Step 1: Remove the allocations. Snapshotted below, because these rows are
        // the audit trail and they are about to stop existing.
        for (const allocation of allAllocations) {
          await tx.deleteAllocation(allocation.id, params.organizationId)
        }

        // Step 2: Re-project each touched charge from what is LEFT.
        //
        // The remaining total is re-read inside the transaction, after the
        // deletes, never derived from the list loaded above. Another payment
        // may have landed on this charge in the meantime, and it must survive.
        const invoicesReopened: VoidInvoicePaymentsResult['invoicesReopened'] = []
        for (const invoiceId of touchedInvoiceIds) {
          const touched = await tx.findInvoiceById(invoiceId, params.organizationId)
          if (!touched) continue

          // VOID is terminal: never resurrect a voided charge.
          if (touched.status === 'VOID') {
            invoicesReopened.push({ invoiceId, month: touched.month, status: 'VOID' })
            continue
          }

          const remaining = await tx.findAllocationsByInvoice(invoiceId, params.organizationId)
          const remainingTotal: Money = remaining.reduce((sum, a) => sum + a.amount, 0)

          // Mirrors the projection in recordPayment, run backwards. PENDING,
          // never OVERDUE: nothing writes OVERDUE to the stored status, because
          // overdue is derived from the due date at read time.
          const newStatus: InvoiceStatus =
            remainingTotal >= touched.amount
              ? 'PAID'
              : remainingTotal > 0
                ? 'PARTIALLY_PAID'
                : 'PENDING'

          if (newStatus !== touched.status) {
            await tx.updateInvoice(invoiceId, { status: newStatus }, params.organizationId)
          }
          invoicesReopened.push({ invoiceId, month: touched.month, status: newStatus })
        }

        // Step 3: Void the payments themselves. Deliberately AFTER the
        // allocations, so a partial failure leaves the charge looking paid
        // (recoverable) rather than the money looking vanished (silent loss).
        //
        // voidReason is null by design: the caller is not asked why. The column
        // stays for a future caller that has something worth recording.
        for (const { payment } of perPayment) {
          await tx.voidTransaction(
            payment.id,
            { voidedBy: params.actorId, voidReason: null },
            params.organizationId
          )
        }

        // Step 4: Void the matching cash rows. computeLedgerTotals skips voided
        // rows, so the cash drops out of the month it was booked in, not the
        // current month. Undoing a January payment in March corrects January,
        // which is the cash-correct answer.
        for (const entry of allLedgerEntries) {
          await tx.voidLedgerEntry(
            entry.id,
            { voidedBy: params.actorId, voidReason: null },
            params.organizationId
          )
        }

        const amountReversed: Money = perPayment.reduce(
          (sum, p) => sum + p.payment.amount,
          0
        )

        // Step 5: ONE event row for the operation. It is the idempotency anchor and
        // the audit trail that justifies deleting the allocations in step 1.
        await tx.createEventLog(
          {
            type:    EVENT_TYPES.TRANSACTION_VOIDED,
            payload: {
              invoiceId:  params.invoiceId,
              accountId:  invoice.accountId,
              amount:     amountReversed,
              currency:   invoice.currency,
              // Full snapshot of what was removed, so the reversal is
              // replayable from the log alone.
              payments: perPayment.map(({ payment, allocations }) => ({
                transactionId: payment.id,
                amount:        payment.amount,
                allocations:   allocations.map(a => ({
                  id:        a.id,
                  invoiceId: a.invoiceId,
                  amount:    a.amount,
                  createdBy: a.createdBy,
                  createdAt: a.createdAt.toISOString(),
                })),
              })),
              invoicesReopened,
              ledgerEntryIds: allLedgerEntries.map(e => e.id),
            },
            actorId:        params.actorId,
            actorType:      'HUMAN',
            idempotencyKey: params.idempotencyKey,
          },
          params.organizationId
        )

        return {
          invoiceId:           params.invoiceId,
          amountReversed,
          paymentsReversed:    perPayment.length,
          allocationsRemoved:  allAllocations.length,
          invoicesReopened,
          ledgerEntriesVoided: allLedgerEntries.length,
        }
      }
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // previewAllocation
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Dry run of the waterfall. Returns an allocation plan showing exactly where
   * a given payment would land across the account's open charges, without
   * writing anything.
   *
   * INVARIANT: the steps returned here MUST match what recordPayment would
   * commit for the same (accountId, amount). These two code paths have to be
   * kept in sync: if you change the waterfall ordering or filtering in
   * recordPayment, change it here too. The parity invariant has its own test.
   *
   * No permission check: a preview is a pure read and writes nothing.
   *
   * @throws {ValidationError}  if amount <= 0 or is not an integer
   */
  async previewAllocation(
    params: PreviewAllocationParams
  ): Promise<PreviewAllocationResult> {
    // ── Guard: amount must be positive ──────────────────────────────────────
    if (params.amount <= 0) {
      throw new ValidationError('Amount must be positive', 'amount')
    }

    // ── Guard: amount must be an integer (minor currency units) ─────────────
    if (!Number.isInteger(params.amount)) {
      throw new ValidationError(
        'Amount must be an integer (minor currency units, no decimals)',
        'amount'
      )
    }

    // ── Load and filter open charges: mirrors recordPayment step 2 exactly ──
    // This filter and sort MUST stay identical to recordPayment's waterfall.
    // Any divergence breaks the parity invariant.
    const allInvoices = await this.db.findInvoicesByAccount(
      params.accountId,
      params.organizationId
    )
    const openInvoices = allInvoices
      .filter(inv =>
        inv.status === 'PENDING' ||
        inv.status === 'PARTIALLY_PAID' ||
        inv.status === 'OVERDUE'
      )
      // Ascending by createdAt: oldest unpaid charge first.
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

    // ── Walk charges and build steps: mirrors recordPayment step 3 ──────────
    let remaining: Money = params.amount
    const steps: AllocationStep[] = []

    for (const invoice of openInvoices) {
      if (remaining <= 0) break

      // Compute true outstanding by summing prior allocations (as recordPayment)
      const priorAllocations = await this.db.findAllocationsByInvoice(
        invoice.id,
        params.organizationId
      )
      const priorAllocated: Money = priorAllocations.reduce(
        (sum, a) => sum + a.amount,
        0
      )
      const outstanding: Money = invoice.amount - priorAllocated

      // Skip fully-allocated charges with a stale status (same guard as above)
      if (outstanding <= 0) continue

      const toAllocate: Money = Math.min(remaining, outstanding)
      const newTotalAllocated: Money = priorAllocated + toAllocate
      const newStatus: InvoiceStatus =
        newTotalAllocated >= invoice.amount ? 'PAID' : 'PARTIALLY_PAID'

      steps.push({
        invoiceId:  invoice.id,
        month:      invoice.month,
        outstanding,
        toAllocate,
        newStatus,
      })

      remaining -= toAllocate
    }

    const totalAllocated: Money = params.amount - remaining

    return {
      steps,
      totalAllocated,
      credit: remaining,
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // applyCredit
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Applies an account's standing (unallocated) credit to its open charges.
   *
   * Credit exists whenever money was recorded with nothing to cover: a payment
   * taken before any charge existed, or an overpayment that spilled over. The
   * payment rows then carry more money than the allocation rows spend. Until
   * this method runs, that money is real but unusable, because the waterfall
   * inside `recordPayment` only ever allocates the payment it was just handed.
   *
   * MECHANICS
   * ─────────
   * An allocation requires a transactionId and is unique per
   * (transaction, charge), so credit cannot be written as a floating row. This
   * is therefore a second waterfall: source payments that still have unspent
   * amount are consumed oldest-first into target charges oldest-first.
   *
   * No cash-ledger row is written here. The cash already hit the cash ledger
   * when the original payment was recorded. Applying credit only re-allocates
   * inside the receivables ledger; writing another IN row would double-count
   * the income.
   *
   * WORKED EXAMPLE
   * ──────────────
   *   Payments:     [1000 unspent, 1000 unspent]  -> spendable credit = 2000
   *   Open charge:  3200 outstanding
   *   -> two allocations (1000 + 1000) against the charge
   *   -> charge PARTIALLY_PAID, applied = 2000, remainingCredit = 0
   *
   * @throws {ForbiddenError}   if the actor lacks RECORD_PAYMENT
   * @throws {IdempotencyError} if this idempotencyKey was already processed
   * @throws {NotFoundError}    if invoiceId is given but not found in this tenant
   * @throws {ValidationError}  if the targeted charge is PAID or VOID
   */
  async applyCredit(params: ApplyCreditParams): Promise<ApplyCreditResult> {
    // ── Guard: permission check ──────────────────────────────────────────────
    requirePermission(params.actorPermissions, 'RECORD_PAYMENT')

    // ── Idempotency check (outside transaction, cheap read) ─────────────────
    const existingEvent = await this.db.findEventLogByKey(
      params.idempotencyKey,
      params.organizationId
    )
    if (existingEvent) {
      throw new IdempotencyError(params.idempotencyKey)
    }

    // ── Compute spendable credit per source payment ──────────────────────────
    // A payment's unspent amount is its own amount minus everything already
    // allocated out of it. Two queries, grouped in memory, so no N+1.
    const [transactions, accountAllocations] = await Promise.all([
      this.db.findTransactionsByAccount(params.accountId, params.organizationId),
      this.db.findAllocationsByAccount(params.accountId, params.organizationId),
    ])

    const spentByTransaction = new Map<string, Money>()
    for (const allocation of accountAllocations) {
      spentByTransaction.set(
        allocation.transactionId,
        (spentByTransaction.get(allocation.transactionId) ?? 0) + allocation.amount
      )
    }

    // Oldest money first: mirrors the oldest-charge-first waterfall.
    const sources = transactions
      .map((t) => ({
        id:        t.id,
        createdAt: t.createdAt,
        unspent:   t.amount - (spentByTransaction.get(t.id) ?? 0),
      }))
      .filter((s) => s.unspent > 0)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

    const creditBefore: Money = sources.reduce((sum, s) => sum + s.unspent, 0)

    // ── Resolve target charges ───────────────────────────────────────────────
    const isOpen = (inv: Invoice): boolean =>
      inv.status === 'PENDING' ||
      inv.status === 'PARTIALLY_PAID' ||
      inv.status === 'OVERDUE'

    let targets: Invoice[]
    if (params.invoiceId) {
      const invoice = await this.db.findInvoiceById(
        params.invoiceId,
        params.organizationId
      )
      if (!invoice) {
        throw new NotFoundError('Invoice', params.invoiceId)
      }
      if (!isOpen(invoice)) {
        throw new ValidationError('Invoice is not payable', 'invoiceId')
      }
      targets = [invoice]
    } else {
      const allInvoices = await this.db.findInvoicesByAccount(
        params.accountId,
        params.organizationId
      )
      targets = allInvoices
        .filter(isOpen)
        // Oldest unpaid charge first: same ordering as recordPayment.
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    }

    // Nothing to do. Return early rather than opening a transaction and
    // burning the idempotency key on a no-op.
    if (creditBefore <= 0 || targets.length === 0) {
      return { applied: 0, remainingCredit: creditBefore, invoicesTouched: [] }
    }

    // ── Atomic transaction ───────────────────────────────────────────────────
    return this.db.runTransaction(async (tx: LedgerStore): Promise<ApplyCreditResult> => {
      let applied: Money = 0
      const invoicesTouched: string[] = []

      for (const invoice of targets) {
        const priorAllocations = await tx.findAllocationsByInvoice(
          invoice.id,
          params.organizationId
        )
        const priorAllocated: Money = priorAllocations.reduce(
          (sum, a) => sum + a.amount,
          0
        )
        let outstanding: Money = invoice.amount - priorAllocated
        if (outstanding <= 0) continue

        // A payment may hold only ONE allocation per charge. Skip any source
        // that already touched this charge: there is no updateAllocation on the
        // port, so a second insert would hit the store's unique constraint.
        const alreadyUsedHere = new Set(priorAllocations.map((a) => a.transactionId))

        let touched = false
        for (const source of sources) {
          if (outstanding <= 0) break
          if (source.unspent <= 0) continue
          if (alreadyUsedHere.has(source.id)) continue

          const toAllocate: Money = Math.min(source.unspent, outstanding)

          await tx.createAllocation(
            {
              amount:        toAllocate,
              createdBy:     params.actorId,
              transactionId: source.id,
              invoiceId:     invoice.id,
            },
            params.organizationId
          )

          source.unspent -= toAllocate
          outstanding    -= toAllocate
          applied        += toAllocate
          touched = true
        }

        if (!touched) continue
        invoicesTouched.push(invoice.id)

        // Project the new status onto the charge (same rule as recordPayment).
        const newStatus: InvoiceStatus = outstanding <= 0 ? 'PAID' : 'PARTIALLY_PAID'
        if (newStatus !== invoice.status) {
          await tx.updateInvoice(invoice.id, { status: newStatus }, params.organizationId)
        }
      }

      const remainingCredit: Money = creditBefore - applied

      // Invariant: we can never spend more than was available.
      if (applied > creditBefore || remainingCredit < 0) {
        throw new Error(
          `BillingService invariant violation: applied(${applied}) exceeds available credit(${creditBefore})`
        )
      }

      // ── Event row: the idempotency anchor. No cash row (see doc block). ───
      await tx.createEventLog(
        {
          type:    EVENT_TYPES.ALLOCATION_APPLIED,
          payload: {
            accountId:       params.accountId,
            applied,
            remainingCredit,
            invoicesTouched,
          },
          actorId:        params.actorId,
          actorType:      'HUMAN',
          idempotencyKey: params.idempotencyKey,
        },
        params.organizationId
      )

      return { applied, remainingCredit, invoicesTouched }
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // calculateBalance
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Calculates an account's running balance from the immutable ledger.
   *
   * FORMULA:
   *   balance = sum(payments) - sum(allocations) - sum(credit notes)
   *
   * Positive means the account has credit (overpaid, or a credit note was
   * issued). Negative means it owes money.
   *
   * Nothing is stored. This is recomputed on every call, which is the point:
   * there is no balance column to drift.
   *
   * WORKED EXAMPLE
   * ──────────────
   * Payments:      [10000, 5000]  -> sum = 15000
   * Allocations:   [10000, 3000]  -> sum = 13000
   * Credit notes:  [1000]         -> sum = 1000
   * Balance = 15000 - 13000 - 1000 = 1000  (the account has 10.00 of credit)
   */
  async calculateBalance(
    accountId: string,
    organizationId: string
  ): Promise<Money> {
    // Load all three components in parallel
    const [transactions, allocations, creditNotes] = await Promise.all([
      this.db.findTransactionsByAccount(accountId, organizationId),
      this.db.findAllocationsByAccount(accountId, organizationId),
      this.db.findCreditNotesByAccount(accountId, organizationId),
    ])

    // Integer addition and subtraction only, never floats.
    const totalTransactions: Money = transactions.reduce((sum, t) => sum + t.amount, 0)
    const totalAllocations: Money = allocations.reduce((sum, a) => sum + a.amount, 0)
    const totalCreditNotes: Money = creditNotes.reduce((sum, cn) => sum + cn.amount, 0)

    return totalTransactions - totalAllocations - totalCreditNotes
  }

  // ───────────────────────────────────────────────────────────────────────────
  // applyCreditNote
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Issues a credit note against an account: what it owes goes down, and no
   * money moved. It reduces the balance computed by `calculateBalance` and
   * writes no cash-ledger row, because nothing arrived.
   *
   * @throws {ForbiddenError}   if the actor lacks MANAGE_FINANCES
   * @throws {ValidationError}  if amount <= 0 or is not an integer
   * @throws {NotFoundError}    if the account is not in this organization
   */
  async applyCreditNote(params: ApplyCreditNoteParams): Promise<CreditNote> {
    // ── Guard: permission ─────────────────────────────────────────────────
    requirePermission(params.actorPermissions, 'MANAGE_FINANCES')

    // ── Guard: amount validation ──────────────────────────────────────────
    if (params.amount <= 0) {
      throw new ValidationError('Credit note amount must be positive', 'amount')
    }
    if (!Number.isInteger(params.amount)) {
      throw new ValidationError(
        'Credit note amount must be an integer (minor currency units, no decimals)',
        'amount'
      )
    }

    // ── Load account ──────────────────────────────────────────────────────
    const account = await this.db.findAccountById(
      params.accountId,
      params.organizationId
    )
    if (!account) {
      throw new NotFoundError('Account', params.accountId)
    }

    // ── Create the credit note and its event row in one transaction ───────
    return this.db.runTransaction(async (tx: LedgerStore): Promise<CreditNote> => {
      const creditNote = await tx.createCreditNote(
        {
          amount:    params.amount,
          currency:  params.currency,
          reason:    params.reason,
          notes:     params.notes,
          createdBy: params.actorId,
          accountId: params.accountId,
        },
        params.organizationId
      )

      await tx.createEventLog(
        {
          type:    EVENT_TYPES.CREDIT_NOTE_ISSUED,
          payload: {
            creditNoteId: creditNote.id,
            accountId:    params.accountId,
            amount:       params.amount,
            currency:     params.currency,
            reason:       params.reason,
          },
          actorId:        params.actorId,
          actorType:      'HUMAN',
          idempotencyKey: params.idempotencyKey,
        },
        params.organizationId
      )

      return creditNote
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // createManualInvoice
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Creates a charge with an explicit amount. No pricing logic lives here: the
   * caller is responsible for passing the correct amount in minor units.
   *
   * There is no past-due guard. There used to be one, rejecting any dueDate
   * before today. It existed to catch a typo in a free-text date field, and
   * that field is gone: due dates are now derived from a billing period. With
   * derivation the guard only ever fired on something legitimate, namely
   * billing for a period that has already closed, which is an ordinary
   * correction.
   *
   * @throws {ValidationError}  if amount <= 0 or is not an integer
   * @throws {NotFoundError}    if the account is not in this organization
   */
  async createManualInvoice(
    params: CreateManualInvoiceParams
  ): Promise<Invoice> {
    // ── Guard: amount must be a positive integer ─────────────────────────────
    if (params.amount <= 0) {
      throw new ValidationError('Invoice amount must be positive', 'amount')
    }
    if (!Number.isInteger(params.amount)) {
      throw new ValidationError(
        'Invoice amount must be an integer (minor currency units, no decimals)',
        'amount'
      )
    }

    // ── Guard: account must exist in this organization ───────────────────────
    const account = await this.db.findAccountById(
      params.accountId,
      params.organizationId
    )
    if (!account) {
      throw new NotFoundError('Account', params.accountId)
    }

    // ── Create the charge and its event row in one transaction ───────────────
    return this.db.runTransaction(async (tx: LedgerStore): Promise<Invoice> => {
      const invoice = await tx.createInvoice(
        {
          amount:    params.amount,
          currency:  params.currency,
          status:    'PENDING',
          dueDate:   params.dueDate,
          // Billing period ("YYYY-MM") when the caller supplies one. Omitted
          // leaves it null.
          month:     params.month,
          reference: params.reference,
          notes:     [params.description, params.notes].filter(Boolean).join('\n\n'),
          createdBy: params.createdBy,
          accountId: params.accountId,
        },
        params.organizationId
      )

      await tx.createEventLog(
        {
          type:    EVENT_TYPES.INVOICE_CREATED,
          payload: {
            invoiceId:   invoice.id,
            accountId:   params.accountId,
            reference:   params.reference ?? null,
            amount:      params.amount,
            currency:    params.currency,
            dueDate:     params.dueDate.toISOString(),
            description: params.description,
            manual:      true,
          },
          actorId:        params.createdBy,
          actorType:      'HUMAN',
          // Manual charges do not take a caller idempotency key: they are
          // intentionally created fresh each time, and submitting twice gives
          // two charges, the same as any accounting system. The key is derived
          // from the new row's id so the event row still has a unique anchor.
          idempotencyKey: `manual_invoice_${invoice.id}`,
        },
        params.organizationId
      )

      return invoice
    })
  }
}
