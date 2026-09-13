# Article outline

Notes for the piece, not the piece. Working title: **"Four screens disagreed
about one invoice"**.

The goal is a reader who builds software thinking two things: this person has
run something real, and I want to work with them. That means specifics,
numbers, and admitting what was wrong. A post that only says "here is my clean
architecture" reads as a tutorial. A post that says "here is what it cost me to
learn this, and here is what a reviewer found afterwards" reads as experience.

Length: 2,000 to 2,500 words. Every claim links to a file in the repo.

---

## 1. The hook: four screens, one invoice, four answers

Open on the bug, not the architecture. A studio owner asks why the invoice list
says a parent owes 50 and the parent's page says they owe nothing. Both are
reading the same rows.

The cause: an invoice carries a `status` column, one code path writes it, five
read it, and one of the five had drifted. Nobody wrote a bug. The bug was that
the same question had five answers.

The fix is the interesting part, because it is not "remove the column".

## 2. Write the column, then refuse to believe it

`computeEffectiveStatus` recomputes an invoice's state from its allocations and
ignores the stored status unless the allocations say nothing. The column stays,
because dropping it means a table scan every time somebody filters by status.

State the shape of the fix as the takeaway: **a projection you do not trust is
not redundancy, it is a cache with an authority.** The bug was never the
denormalisation. It was that nothing said which copy wins.

Then the sharper version of the same story: OVERDUE. Nothing in the system ever
wrote it. It was a value in the enum that no code path produced, so an account
three weeks late looked identical to one due at month end, and four features
that tested for it silently did nothing. It is a pure function of a date that
was already loaded. One line, in one place, and all four came back.

## 3. Deleting rows on purpose, and how the argument was settled

Reversing a payment deletes its allocation rows rather than flagging them.

Give the argument as it actually went. Flagging is obviously safer, until you
count: every read path in the app answers "is this charge paid?" by summing
allocations for one invoice id, without joining back to the payment. About
twenty call sites. A flag means twenty places that must remember to exclude it,
forever, including the ones written next year. One that forgets shows a charge
as settled by money that never arrived.

Deleting makes every one of them self-heal. What makes it safe is the event
log, which keeps the full snapshot of what was removed.

The takeaway is about method, not about allocations: **that argument is
unwinnable in the abstract and trivial once you count the call sites.**

## 4. The unit of reversal is the charge, not the payment

Short section. A charge settled by two partial payments is cleared in one call.
People think "this charge is wrong", not "the second of these two payments is
wrong". There is deliberately no way to reverse half a payment, because that
would break the invariant that a payment's amount equals its allocations plus
its credit.

Design follows the sentence the user says out loud.

## 5. Taking it out: what one architectural rule was worth

The extraction. Lumo's core was written under a rule: no ORM imports, no HTTP,
no file I/O, all storage through one injected port, tenant id explicit on every
call.

Numbers, because this is the section that proves the claim:

- The estimate written before the work: 8 files, ~135 identifier renames, no
  adapters, no stubs.
- What happened: exactly that, in one night.
- The port is 29 methods and every one takes `organizationId`, which is tedious
  every single day.

Be honest about the cost. Passing a tenant id into 29 methods by hand is
annoying, and the port has to be kept in sync manually. It paid for itself
twice: once here, and once every day before that, because it is the same
property that made the code testable without a database.

**And say the agent part plainly here.** A coding agent did the extraction
against a written brief, in a session, reviewed line by line afterwards. That is
not the achievement. The achievement is that the code was shaped so the job was
mechanical. An agent is a very fast reader of a codebase and a very literal
one; it is exactly the tool that turns "well factored" from a feeling into a
measurement. Say what it did badly too, which section 6 is about.

## 6. What a review found afterwards, which is the honest half

Four things, all of them present in production, all of them faithfully carried
across by an extraction that was asked whether behaviour was preserved and not
whether behaviour was right.

**Nothing serialised the allocation.** Two payments for one account arriving
together both read the same charge as open and both allocate to it. No error.
The charge just holds more money than it is worth. The fix is a row lock taken
first inside every transaction that allocates. Show the paired test: the same
race overpays by 100% with the lock removed and settles exactly once with it in
place. This is the strongest single artifact in the repo and should be the
longest part of the section.

**Two documented rules were not enforced anywhere.** The port's own doc said a
store must exclude voided payments and must reject duplicate idempotency keys.
Prose. Turning them into a runnable contract suite and pointing it at the store
that shipped with the package found that its allocation reads ignored the
tenant. The reference implementation had the bug its own documentation warned
about.

**A function and its doc said opposite things.** `calculateBalance` computes
standing credit; the entity it summed was documented as reducing what is owed.
They had contradicted each other for years. Reading them side by side in a
fresh repository, with none of the surrounding context to explain them, is what
made it visible.

**Preview and commit were two implementations of one algorithm**, kept in step
by a parity test. A comment enforced by CI is not a design. They are one pure
function now, and the test stayed as a guard.

Land the general point: **an extraction preserves behaviour, and preserving
behaviour preserves bugs.** The value was not in the moving. It was in reading
the result somewhere the original context did not come along to explain it.

## 7. Close: what is still wrong

Do not end on a triumph. End on the open items, because a reader who has run
systems trusts that more.

- Currency travels with every row and is never compared. A payment in one
  currency settles a charge in another at face value. There is a test that pins
  the behaviour rather than a fix that invents one.
- `calculateBalance` does not include open charges, and its name has been
  telling people otherwise.

One line on the package being MIT and where it is.

---

## Things to keep out

- Any suggestion that the ledger is a general accounting library. It is one
  system's core, published because it is worth reading.
- Framework opinions. Nothing here depends on Next.js, and saying so invites an
  argument that is not the article.
- "Clean architecture" as a phrase. Show the rule and its bill instead.
- Screenshots of code without the incident that produced it. The incidents are
  the whole value.
