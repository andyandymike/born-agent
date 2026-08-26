# ML2 Implementation Record

> Slice: bounded exact / quoted / lexical / temporal manual retrieval
> Started: 2026-08-26 (Asia/Tokyo)
> Local result: `local_product_verified`; Agent automatic recall remains absent
> Release boundary: not yet `preview_usable`; same-exact-commit Linux/Windows CI is pending

## Product result

ML2 adds one user-observable command:

```text
born memory search <query> [--limit 1..20] [--explain] [--json]
```

It searches only the active local owner plus exact repository/canonical-root
scope. Exact episode IDs, fully quoted phrases, and Host-tokenized lexical terms
are ranked deterministically; every candidate returns to the canonical ML1 row
and exact session source check before it can become a hit.

ML2 does not add memory to `AgentContextRuntime`, `ContextPlan`, `ModelRequest`,
provider input, approvals, tools, or effects. That boundary remains ML3.

## Preflight and reference evidence

- Live repository state: ML1 is commit `43d80b2` on both `main` and
  `origin/main`, but `gh run list --commit 43d80b2` returned no CI runs.
- Windows runtime: Node `v22.23.1`, `win32 x64`.
- Local FTS5 probe passed `CREATE VIRTUAL TABLE -> insert -> MATCH/bm25 ->
  rebuild -> close -> reopen -> identical logical result`.
- SQLite's official FTS5 documentation defines lower `bm25()` values as better
  matches and documents the special rebuild command:
  <https://sqlite.org/fts5.html#the_bm25_function> and
  <https://sqlite.org/fts5.html#the_rebuild_command>.
- Node's official `node:sqlite` documentation supplies the synchronous
  `DatabaseSync` API used by the already adopted ML1 store:
  <https://nodejs.org/api/sqlite.html#class-databasesync>.

## Implemented call chain

```text
born memory search
  -> resolve one active repository registration and local owner
  -> strict canonical logical dump for that exact scope
  -> parse Host-owned safe query grammar
  -> exact ID path, or scope-specific FTS5 projection
  -> at most 100 candidate IDs with quantized BM25 and recency order
  -> strict canonical get under all three scope predicates
  -> exact session source revalidation
  -> result/text/token bounded prefix
  -> JSON or human --explain projection
```

The derived path is
`private_state/memory/v1/retrieval/fts5-v1/<scope-sha256>.sqlite3`.
Canonical ML1 schema and logical hashes do not include it. Missing, corrupt, or
out-of-date projection state rebuilds from strict canonical rows.

## Frozen ranking and bounds

- Query: raw and normalized UTF-8 each at most 1,024 bytes; at most 16 unique
  Unicode letter/number/underscore terms.
- Raw user text is never executed as FTS syntax. Host-quoted terms are joined
  with a fixed OR expression; a fully quoted query becomes one fixed phrase.
- FTS columns: `record_id UNINDEXED`, `occurred_at UNINDEXED`,
  `task_preview`, `text`; tokenizer `unicode61 remove_diacritics 2`.
- BM25 weights: `0, 0, 3, 1`; score output is quantized to 12 decimals.
- Order: exact ID, exact phrase, BM25 ascending, occurred-at descending,
  record ID ascending.
- Maximums: 100 lexical candidates, 20 results, 16 KiB cumulative record text,
  and 4,096 deterministic conservative estimated tokens.
- Abstention is explicit for no searchable terms, no source-available match, or
  a first result that cannot fit the output budget.

## Learning notes

1. A global FTS table would filter visible rows but still let foreign-scope
   documents influence corpus-level BM25 statistics. One derived DB per exact
   scope makes “scope before score” structural rather than a query-planner hope.
2. FTS5 has a real query language. Passing a user's string directly to `MATCH`
   would expose operators and future syntax changes; ML2 owns a much smaller
   grammar and only emits quoted terms.
3. An FTS hit is not memory authority. The projection supplies only candidate
   IDs and scores; canonical scope, bytes, record hash, and source status are
   rechecked before output.
4. A rebuildable projection does not require a canonical schema migration.
   Deleting the entire retrieval directory leaves the ML1 logical dump intact
   and the next manual search reconstructs the same ordered hits.

## Verification evidence

- Frozen corpus: 12 coding episodes, 12 positive queries, 2 abstention queries;
  Recall@5 `1.0`, MRR `1.0`, abstention accuracy `1.0`.
- Focused ML1+ML2 regression: 5 files / 18 tests passed locally.
- Installed package: complete `pack:smoke` passed an available-source ML1
  ingest/reopen, positive ML2 search, deleted-projection rebuild, and all
  existing cache/Hook/Graph/delegation/plugin smoke paths.
- Full repository: lint and typecheck passed; non-PTY 282 files / 1,310 tests
  passed with 6 files / 12 tests skipped; five applicable PTY suites passed,
  two platform-inapplicable suites skipped; clean build passed.
- Remote/live model requests: none; ML2 quality evidence is deterministic and
  model-free.

## Still not implemented

ML2 cannot automatically recall memory for an Agent. It does not render
historical ContextItems, send local memory to any provider, extract ordinary
chat facts, add embedding or graph retrieval, or implement
`remember/retract/rebuild/doctor`. Those are explicit ML3/ML4 boundaries.

## Time ledger

| Stage | Observed Agent wall-clock | Result |
|---|---:|---|
| Contract, FTS5/CI preflight, frozen corpus | ~0.1 h | FTS5 passed; missing ML1 CI recorded; scope/rank/bounds frozen |
| Projection, retrieval service and CLI | ~0.2 h | concrete manual search implemented without Agent context changes |
| Focused/product/pack evidence and fixes | ~0.2 h | 18 focused regression tests and full installed tarball smoke passed |
| Full repository gate, review and docs | ~0.2 h | 1,310 non-PTY tests, PTY and clean build passed |
| **Observed automated wall-clock** | **~0.7 h** | approximate elapsed tool window, not human-equivalent effort |

The tracked work window is approximately 10:18–10:58 JST on 2026-08-26.
Category values are rounded and include test/pack waiting. The original
`8–16 h` value was a conservative human-focused planning budget and was not an
accurate Agent elapsed-time forecast; ML2's measured local result is the
calibration point for later slices.
