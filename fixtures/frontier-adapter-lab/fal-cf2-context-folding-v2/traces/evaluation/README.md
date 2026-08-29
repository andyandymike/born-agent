# CF2 naturalistic trace cohort

No trace is present in this revision. The 2026-08-29 inventory found zero completed BornAgent parent runs containing accepted child receipts plus a replayable full baseline task-context artifact.

The read-only inventory covered:

- `.bornagent/sessions`: 19 runs, zero delegation/receipt events; inventory SHA-256 `0010622230dbfcf622dca6fc89bc1d464db9e5edee0ff7368a2c81732799d3a2`;
- the retained Phase 20 debug ledger: zero delegation events; inventory SHA-256 `83b2e45a12e379d80e437760129d2f44fdd141691715c56501e28b3e4ffe196b`;
- the temporary M11 debug ledger: child shards existed, but zero ready/accepted/terminal receipts and no replayable full parent baseline context; inventory SHA-256 `9d6a91c58a10cb51395bc233763c5e8cad7873ebfbc26888e5f10abafe441287`.

Do not add generated fixtures here. A future trace is eligible only after the candidate, selector, scorer and sampling protocol are frozen, and only when every provenance field and relative artifact hash required by the CF2 Spec validates. Until at least 12 independent eligible traces are collected, product-fit remains inconclusive.
