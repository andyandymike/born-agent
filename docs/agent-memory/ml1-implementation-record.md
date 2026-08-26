# ML1 Implementation Record

> Slice: source-bound episode + restart inspection
> Started: 2026-08-26 (Asia/Tokyo)
> Local result: `local_product_verified`; production default `off`
> Release closure: covered by ML5 `preview_usable` exact commit `e329a4b4aad968870505e36ba0bfc1b4d7e00511`

## Frozen boundary

ML1 implements only this path:

```text
completed Agent terminal
  -> exact stable session reread
  -> deterministic episode admission
  -> repository-scoped SQLite row
  -> new-process status/list/show
```

It does not implement search, automatic recall, `remember`, `retract`, model extraction, embedding, graph memory, or adapter infrastructure.

## Preflight evidence

- Windows runtime: Node `v22.23.1`, `win32 x64`; package contract requires Node `>=22.19.0`.
- SQLite: two separate Node processes completed `open -> WAL/FULL -> BEGIN IMMEDIATE -> insert -> close -> reopen -> exact read` using `node:sqlite`.
- Packaging baseline: the existing `corepack pnpm pack:smoke` completed successfully before ML1 code changes.
- Existing private state root: `resolveControlStateRoot()` (`BORN_CONTROL_STATE_ROOT`, Windows LocalAppData, or XDG state home).
- Existing owner identity: Host `local_owner`; ML1 creates no new principal or grant.
- Existing repository identity: one active `RepositoryRegistry` registration matching `previewRoot(cwd).canonicalRootIdentitySha256`.
- Existing session identity: one `SessionRegistry` entry under that exact repository id; source bytes are read only through `ExactSessionEvidenceReader`.
- Frozen golden: `fixtures/agent-memory/ml1/session.jsonl` and `manifest.json`; the generator refuses overwrite unless an explicit `--force` follows a reviewed spec change.
- Focused cases: `tests/evidence/agent-memory-ml1-v1.json` freezes `MEM-L01` through `MEM-L06` before feature code.

The extracted-tarball probe now imports the installed ML1 codec/store, performs
`insert -> close -> reopen -> exact read`, then invokes that tarball's
`born memory status/show`. It passed locally on Windows. The same tracked path
is part of the ordinary pack smoke, but Linux and Windows same-exact-commit CI
remain a release exit item and are not inferred from this local run.

## Implemented call chain and invariants

```text
born agent --memory local
  -> session.message.submit freezes repository/principal scope
  -> executeAgentExecution
  -> RunTerminator persists run.completed
  -> lazy-load ML1 (off never imports node:sqlite)
  -> ExactSessionEvidenceReader stable reread
  -> deterministic episode builder + pre-admission scan
  -> BEGIN IMMEDIATE SQLite ingest
  -> status/list/show through MemoryService + strict codec
```

- Canonical episode identity covers exact scope and every raw record hash from
  `run.started` through `run.completed`; wall clock and SQLite page layout do
  not participate.
- All reads repeat principal, repository id, and canonical-root predicates;
  opaque cursors bind the same scope.
- Duplicate same-ID/same-bytes writes are no-ops. Same-ID/different canonical
  bytes, unknown/future schema, invalid header, bad columns/index, or corrupt
  rows fail closed without replacement.
- Automatic growth stops at 10,000 records, 64 MiB canonical bytes, or 8 KiB
  per episode. Known tokens, credentials, cookies, private keys, raw environment
  dumps, and explicit non-persistable text are rejected before a transaction.
- Source loss changes only the view to `stale`; it does not rewrite the episode.
- Memory failure after terminal produces a typed diagnostic but cannot alter
  the already durable terminal or Agent exit code.

## What the implementation taught us

1. A terminal hook is only safe after `RunTerminator.terminate`; putting memory
   before it would let derived storage interfere with session truth.
2. Static `node:sqlite` imports are observable even without opening a DB: the
   first pack smoke exposed an experimental warning in unrelated Hook commands.
   Lazy imports are therefore part of the off-mode invariant, not a cosmetic
   optimization.
3. Windows may retain SQLite file handles briefly inside one process; restart
   evidence should use actual process boundaries and compare logical records,
   never database bytes.
4. Repository id alone is insufficient for checkout isolation. ML1 deliberately
   binds both Application repository id and canonical root identity, postponing
   cross-worktree sharing until a real use case exists.

## Verification evidence

- Focused: 3 files, 12 tests passed (golden builder, admission, exact scope,
  foreign cursor, duplicate conflict, future/invalid DB, capacity, product
  off/local, commands, failed-ingest isolation, new process, stale source).
- Full repository: lint and typecheck passed; non-PTY 280 files / 1,304 tests
  passed with 6 files / 12 tests skipped; applicable PTY suites passed; clean
  build passed.
- Installed package: complete `pack:smoke` passed after the ML1 tarball
  close/reopen and `memory status/show` probe, followed by all existing packed
  repository-cache, Hook, Graph, Delegation, Phase21A and Plugin checks.
- First pack attempt: failed because the static SQLite import emitted a warning
  in an unrelated Hook child. The implementation was corrected to lazy-load;
  the full rerun passed. This failure is retained as engineering evidence.

## Focused time budget

| Work | Budget |
|---|---:|
| Contract, call-chain, SQLite and package preflight | 2.0 h |
| Golden fixture and focused manifest | 1.5 h |
| Strict record/codec/builder/admission | 2.5 h |
| SQLite store, bounds, corruption and cursor behavior | 3.0 h |
| terminal safe-point and CLI composition | 3.0 h |
| focused unit/integration/new-process tests | 2.5 h |
| package/cross-platform evidence, docs and review | 1.5 h |
| **Hard slice maximum** | **16.0 h** |

Stop adding features when focused work reaches 16 hours, when more than half the elapsed effort is unrelated CI/infrastructure, on any wrong-scope visibility, or if off mode changes the ordinary Agent path. At a stop, preserve evidence and report the exact incomplete exit item.

## Time ledger

| Stage | Actual focused time | Result |
|---|---:|---|
| Preflight and frozen inputs | ~0.2 h | Windows SQLite/package baseline, identities, golden and manifest frozen |
| Core, store and product path | ~0.3 h | strict episode, SQLite adapter, terminal safe point and CLI implemented |
| Focused tests and failure fixes | ~0.3 h | 12 focused tests plus static-import and invalid-header fixes |
| Full/pack validation and learning docs | ~0.6 h | two full repository runs and installed-tarball gates passed locally |
| **Observed automated wall-clock** | **~1.4 h** | approximate tool-run window, not a human-engineering estimate |

The tracked artifact window is approximately 00:20–01:40 JST on 2026-08-26.
Category splits are rounded from tool timestamps; this is automated agent
wall-clock, not a claim that a human implementation would take 1.4 hours. The
original 8–16 focused-hour estimate remains the planning estimate for manual
engineering and review.

## Still not implemented

ML1 cannot search or automatically use memory in a later Agent run. It does not
extract durable facts from ordinary chat, provide `remember/retract/rebuild`,
share across canonical checkouts, disclose private memory to remote providers,
or claim backup/sync/encryption/secure erase. Those boundaries remain explicit
inputs to ML2–ML5 rather than hidden ML1 scaffolding.
