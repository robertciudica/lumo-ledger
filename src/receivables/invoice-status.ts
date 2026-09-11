/**
 * Invoice status and balance: the single definition.
 *
 * In Lumo this function was written out twice, private in two places, and the
 * balance sum was open-coded in nine more files. That is how four screens came
 * to disagree about the same invoice. Anything that needs to know what a charge
 * is worth, or what state it is in, imports from here.
 *
 * Pure by construction: no storage, no I/O, no clock. Callers pass what they
 * already loaded.
 */

import type { InvoiceStatus } from '../store'

/** Anything with an `amount` in minor units. Allocation rows, in practice. */
export interface HasAmount {
  amount: number
}

/**
 * Total money that has landed on a charge, in minor units.
 *
 * Allocations are the truth about what has been paid; `Invoice.status` is a
 * projection that can lag behind them.
 */
export function sumAllocations(allocations: readonly HasAmount[]): number {
  return allocations.reduce((sum, a) => sum + a.amount, 0)
}

/**
 * What is still owed, in minor units. Never negative: an overpayment leaves a
 * zero balance, and the excess is credit on the account, not a negative debt.
 */
export function computeBalance(amount: number, paidAmount: number): number {
  return Math.max(0, amount - paidAmount)
}

/**
 * The status to show a human, derived from allocations rather than trusted
 * from the stored column.
 *
 * Order matters:
 *   1. VOID is terminal. Money landing on a voided charge never resurrects it;
 *      that would silently un-cancel something somebody deliberately cancelled.
 *   2. Fully covered, overpayment included, is PAID.
 *   3. Partially covered is PARTIALLY_PAID.
 *   4. Otherwise the stored status stands.
 *
 * OVERDUE is derived, not stored. Nothing in Lumo has ever written
 * `status: 'OVERDUE'`, so it was only reachable if a row already said so, which
 * no code path produced. That left an account three weeks past due looking
 * identical to one due at month end, and silently killed four features that
 * tested for it. It is a pure function of data already loaded, so it is
 * computed here and every consumer gets it at once.
 *
 * `now` is a parameter rather than a `new Date()` call so this stays pure and
 * testable. The ledger takes no clock.
 *
 * PARTIALLY_PAID keeps precedence over OVERDUE: a part-paid charge already
 * surfaces in its own filter, and demoting it to OVERDUE would silently move
 * rows between views. Overdue answers "nobody has paid and the date has passed".
 */
export function computeEffectiveStatus(
  dbStatus: InvoiceStatus,
  amount: number,
  paidAmount: number,
  dueDate: Date,
  now: Date,
): InvoiceStatus {
  if (dbStatus === 'VOID') return 'VOID'
  const balance = computeBalance(amount, paidAmount)
  if (balance <= 0) return 'PAID'
  if (paidAmount > 0) return 'PARTIALLY_PAID'
  if (dueDate.getTime() < now.getTime()) return 'OVERDUE'
  return dbStatus
}
