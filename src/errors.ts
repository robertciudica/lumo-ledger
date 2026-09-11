/**
 * Domain error types: every error the ledger throws.
 *
 * Rules:
 * - The ledger only throws these; never a raw `new Error()` for a domain
 *   condition. The one exception is an invariant violation, which is a
 *   programming error rather than a domain error and throws a plain Error on
 *   purpose so it cannot be caught and rendered as a user-facing message.
 * - Callers catch these and translate them into whatever their transport uses.
 * - Storage errors must be caught at the store implementation boundary and
 *   re-thrown as one of these before crossing back into the ledger.
 */

/**
 * Base class for all domain-level errors.
 * Carries a `code` string that callers use to produce structured responses.
 */
export class DomainError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'DomainError'
    // Maintain proper prototype chain in environments that transpile classes
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * The requested entity does not exist, or is not visible in the current
 * tenant context (we never expose whether a record exists in another tenant).
 */
export class NotFoundError extends DomainError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND')
    this.name = 'NotFoundError'
  }
}

/** The caller lacks the permission required for this action. */
export class ForbiddenError extends DomainError {
  constructor(message = 'Access denied') {
    super(message, 'FORBIDDEN')
    this.name = 'ForbiddenError'
  }
}

/**
 * Input data fails a domain invariant (negative amount, missing field, date
 * out of range). Carry the `field` name when the caller can surface it.
 */
export class ValidationError extends DomainError {
  constructor(message: string, public readonly field?: string) {
    super(message, 'VALIDATION_ERROR')
    this.name = 'ValidationError'
  }
}

/** The requested mutation conflicts with existing state. */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 'CONFLICT')
    this.name = 'ConflictError'
  }
}

/**
 * An operation with the given idempotency key was already processed.
 * Safe to return the previously-recorded result to the caller.
 */
export class IdempotencyError extends DomainError {
  constructor(key: string) {
    super(`Operation already processed: ${key}`, 'ALREADY_PROCESSED')
    this.name = 'IdempotencyError'
  }
}
