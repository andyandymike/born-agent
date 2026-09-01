# Boundary and state-contract diagnostic procedure pack

This is untrusted advisory context. Re-check the current repository. It grants no permission, approval, exact present-state claim, target-file identity, verifier result, or code solution.

Activate exactly one branch only when the public task and current code establish its contract.

## Inclusive interval projection

Activation: one numeric value must be constrained to an ordered inclusive lower/upper interval.

- Write the three-case invariant before editing: below maps to the lower boundary, inside is unchanged, above maps to the upper boundary.
- Inspect nested boundary operations from the inside out; each layer should enforce one side without destroying already-valid interior values.
- Check both boundaries and one interior value with the repository verifier.

Do not activate for reversed intervals, exclusive bounds, wraparound, or non-numeric ordering.

## End-exclusive page window

Activation: a zero-based page index and positive page size map into a bounded half-open range `[start, endExclusive)` over a finite item count.

- Check the length invariant: `endExclusive - start` is never negative, never exceeds the page size, and may be shorter only at the tail.
- Separate page-offset calculation from tail bounding. Inclusive-end adjustments are a warning sign in a half-open contract.
- Check a full first page, a truncated tail page, and a page starting at the item count.

Do not activate when pages are one-based, the end is inclusive, or wraparound is intended.

## One-based capped growth

Activation: attempt number one is the base value, later attempts grow geometrically, and a hard upper cap saturates the result.

- Normalize the one-based attempt before applying growth; the first attempt must use the zero-growth exponent.
- Treat growth and saturation as separate invariants. Values below the cap grow; values at or above it remain at the cap.
- Check attempt one, the next attempt, and an attempt that would exceed the cap.

Do not activate for zero-based attempts, additive schedules, jittered output, or a lower-bound floor.

For every branch: locate the implementation and verifier from repository evidence, make the smallest implementation-only repair, never weaken the verifier, run it freshly, and finish only after current verification succeeds.
