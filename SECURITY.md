# Security

## Reporting a vulnerability

Email **robert@seacoders.dev**. Please do not open a public issue first.

Include what you did, what happened, and what you expected. A failing test is
the fastest possible report.

You should get a reply within a few days. This package is maintained by one
person, so it will be a person replying rather than a process.

## What counts as a vulnerability here

This is an accounting core, so the interesting failures are about money and
about tenants:

- Money that can be counted twice, lost, or created.
- A reversed payment that can be spent again.
- An idempotency key that can be replayed.
- Any path where one tenant can read or write another tenant's rows.
- An input that gets past the integer-minor-units guards.

## Known limitations, which are not vulnerabilities

These are documented in the README and are deliberate:

- **Currency is carried on every row and never compared.** A payment in one
  currency will settle a charge in another, at face value. Guard it at your
  edge if you run more than one currency per tenant.
- **`InMemoryLedgerStore` does not roll back.** It is for logic tests, not for
  proving atomicity, and its doc comment says so.
- **Authorization is a permission set the caller supplies.** The ledger checks
  membership. Deciding who holds which permission is the caller's job, and so
  is making sure a tenant id never comes from something an end user controls.

## Supported versions

The latest minor version gets fixes. Older ones do not.
