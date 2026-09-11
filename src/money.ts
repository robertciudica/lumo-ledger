/**
 * Money: the core financial value object.
 *
 * Always an integer, representing minor currency units (cents, kopiyky, bani).
 *
 * Never use raw `number` for currency amounts. Use `Money` everywhere.
 * Floating-point arithmetic on money is forbidden: all financial calculations
 * operate on integers.
 *
 * Examples:
 *   1 USD = 100  (cents)
 *   1 UAH = 100  (kopiyky)
 *   1 RON = 100  (bani)
 *
 * Conversion from user input (say "42.50") happens at the edge of the system,
 * in the HTTP or form layer, never inside the ledger.
 */
export type Money = number
