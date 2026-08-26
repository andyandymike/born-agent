# ML3 Implementation Record

> Slice: safe local Agent use of bounded historical excerpts
> Started: 2026-08-26 (Asia/Tokyo)
> Local result: `local_product_verified`; product, full repository, and installed-pack evidence passed
> Release boundary: not yet `preview_usable`; same-exact-commit Linux/Windows CI is pending

## Product result

An Agent run with explicit `--memory local` now performs automatic recall before
every model request when the frozen provider source is local Ollama or an
in-process test backend. A new process in the same repository can therefore use
a source-available episode written by an earlier completed process.

Default or explicit `off` remains storage-free. Provider-network requests get
zero memory records and do not open the FTS projection. ML3 adds no model tool,
ambient preference, remote disclosure, or lifecycle command.

## Implemented call chain

```text
Application Host exact repository/principal binding
  -> AgentExecution local-provider decision
  -> every AgentContextController.prepare(request)
  -> bounded current model-task query
  -> ML2 exact/scope/FTS candidate search (limit 3)
  -> canonical scope + record-hash refetch
  -> second exact session-source verification
  -> RecallSelectionV1 and canonical selection hash
  -> Host-rendered historical_memory ContextItems
  -> Context core authority and budget assertion
  -> ordinary ContextPlan compaction
  -> provider request prepare
```

The primary implementation is
[`automatic-memory-recall-service.ts`](../../src/memory/recall/automatic-memory-recall-service.ts),
with its frozen result contract in
[`ml3-recall-contract.ts`](../../src/memory/recall/ml3-recall-contract.ts).
Product assembly stays in the existing Agent/Application Host path rather than
adding another service registry or model-facing tool.

## Two-phase use boundary

ML2 search proves only that a candidate ranked and its source was available at
search time. ML3 then refetches the exact record under all three scope fields,
requires the same canonical record hash, and repeats exact source verification
immediately before ContextPlan construction. A test seam changes source status
between those phases and demonstrates zero injected items.

The remaining atomicity boundary is deliberate: local Memory Lite does not yet
have concurrent user retraction, and remote disclosure is forbidden. ML4 must
define lifecycle operations before any stronger delete/use barrier is useful.

## Prompt-injection and authority boundary

Each selected record is rendered as canonical JSON inside fixed
`BORNAGENT_HISTORICAL_EVIDENCE_V1_BEGIN/END` delimiters. The Host label states
that enclosed bytes are past evidence, never current instructions, permissions,
approvals, policy, or verified present state.

The resulting item is mechanically constrained to:

- `kind=historical_memory`;
- `authority=historical_only` (the core also permits the weaker
  `untrusted_content`);
- `priority=low`, `recency=0`, no pairing;
- `protectedCategory=null`, so it cannot enter the ProtectedFactLedger;
- the exact existing model tool list and approval path remain unchanged.

The frozen poisoning fixture contains instructions to ignore the user, bypass
approval, and invoke a destructive command. Product and unit tests confirm that
the bytes remain inside the historical item and that an attempted authority
elevation is rejected before planning.

## Frozen bounds and identity

- At most three ordered records per request.
- Combined estimate uses the same planner estimator as ContextPlan.
- Limit is `min(1,024, floor(compactionTargetTokens * 0.08))`.
- The estimate covers the complete ContextItem representation, not only the
  record text.
- Selection binds session, run, step, input kind, query/retriever, exact scope,
  ordered record/source hashes, reasons, availability, bytes, and tokens.
- The canonical selection SHA-256 is copied into every included item's
  metadata; ContextPlan then supplies the final provider-neutral context hash.

Protected closure is selected before optional historical items during
compaction. A full current protected context therefore drops memory instead of
failing or evicting current authority.

## Verification evidence

- ML1–ML3 focused regression: 7 files / 23 tests passed locally.
- New-process product proof: Session B receives one relevant, source-available
  Session A item through the actual CLI/Application Host/Agent context path.
- Boundary proof: explicit off and provider-network requests receive zero
  historical items; the remote case does not recreate a deleted retrieval root.
- Installed package: complete `pack:smoke` imports the extracted ML3 modules,
  prepares the exact ML1 fixture as historical context, and rechecks authority,
  source identity, selection, and budget before all existing smoke paths pass.
- Remote/live model requests: none. The remote-provider case uses an in-process
  fake transport with policy source `provider_network` and proves disclosure is
  suppressed before transport.
- Full repository: lint and typecheck passed; non-PTY 284 files / 1,315 tests
  passed with 6 files / 12 tests skipped; five applicable PTY suites passed,
  two platform-inapplicable suites skipped; clean build passed.
- The first full run hit an unrelated Phase21A SIGINT timing timeout and passed
  5/5 when isolated. The second exposed an existing ML1 child-process test's
  default 5-second timeout. Only the two ML1 tests that really spawn processes
  were aligned to the existing ML2/ML3 30-second integration-test budget; the
  ML1–ML3 focused matrix then passed 23/23 and the standard full gate passed.

## Learning notes

1. Retrieval and use are different trust decisions. Reusing the ML2 result
   object without a second canonical/source check would leave a stale window.
2. A three-record maximum is a ceiling, not a target. With conservative full
   ContextItem accounting, one rich record can legitimately consume the whole
   1,024-token slice.
3. The safe local/remote decision must use the frozen provider-policy source,
   not a model name, endpoint string, or the presence of a fake backend.
4. Prompt labels reduce semantic confusion, while actual authority attenuation
   comes from Host-owned tools, approvals, protected facts, scope checks, and
   the context-core rejection of elevated historical items.

## Still not implemented

ML3 does not provide `remember/retract/rebuild/doctor`, revisions, explicit
facts/preferences, chat extraction, embedding, graph retrieval, consolidation,
or remote memory disclosure. Those remain ML4 or post-ML5 experiment work.

## Time ledger

| Stage | Observed Agent wall-clock | Result |
|---|---:|---|
| Contract and architecture audit | ~0.2 h | exact local-only and two-phase boundary frozen |
| Recall/context/product implementation | ~0.2 h | every-request bounded historical context connected |
| Focused and installed-pack evidence | ~0.3 h | 23 focused tests and full tarball smoke passed |
| Full gate, timing diagnosis, review and docs | ~0.6 h | 1,315 non-PTY tests, PTY and clean build passed |
| **Observed automated wall-clock** | **~1.3 h** | approximate elapsed tool window, not human-equivalent effort |

The tracked work window is approximately 11:00–12:15 JST on 2026-08-26.
Category values are rounded and include full-gate and pack waiting. The initial
`8–16 h` figure remains a human-focused budget; the calibrated Agent estimate
was 1–3 hours, and the observed result stayed inside it.
