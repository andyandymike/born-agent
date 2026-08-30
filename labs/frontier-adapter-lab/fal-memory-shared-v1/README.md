# FAL Memory Shared Benchmark v1

This lab defines the shared benchmark used to compare the retained local-embedding candidate and Context Folding candidate without pretending that they solve the same stage.

- Local embedding changes **which memory evidence is retrieved**.
- Context Folding changes **how already-verified child receipts are represented in context**.
- The benchmark therefore uses the same timelines in a 2 × 2 factorial, but reports retrieval, folding, answer quality, and cost separately. It never emits one composite “winner” score.

The frozen design is `24 timelines × 10 probes = 240 probes`:

- development: 6 timelines / 60 probes;
- calibration: 6 timelines / 60 probes;
- one-shot evaluation: 12 timelines / 120 probes;
- every timeline: 6 `must_answer` plus 4 `must_abstain` probes;
- every split balances 128 / 384 / 1,024-record pools and 2 / 8 / 16-receipt pressure;
- the independence and resampling unit is the complete timeline, never an individual probe.

The ten probe families cover a durable user fact, assistant/tool outcome, cross-session synthesis, chronology, knowledge update, mixed memory-plus-receipt evidence, absent fact, semantic near miss, filtered scope/lifecycle target, and incomplete evidence chain.

## Answer-policy v2 repair

The frozen v1 bytes and scores remain unchanged. A separate `fal-memory-shared-v2` semantic contract now derives public development/calibration from those tracked v1 packs while binding their executor/golden hashes. It separates six full answers, one evidence-supported negative, one known-plus-missing partial answer, and two genuinely direct unknowns per timeline. Security failures are also separated from output-policy failures, and duplicated paired regression edges aggregate by unique timeline/probe.

The v2 implementation is [`answer-policy-v2.ts`](src/answer-policy-v2.ts), its frozen protocol is [`protocol.json`](../../../fixtures/frontier-adapter-lab/fal-memory-shared-v2/protocol.json), and its regression suites are [`answer-policy-v2.test.ts`](tests/answer-policy-v2.test.ts) and [`answer-policy-v2-execution.test.ts`](tests/answer-policy-v2-execution.test.ts). Public development/calibration retrieval and the isolated DeepSeek diagnostic have now run; their append-only summary is [`deepseek-v4-flash-answer-policy-v2-development-calibration-receipt.json`](../../../fixtures/frontier-adapter-lab/fal-memory-shared-v2/deepseek-v4-flash-answer-policy-v2-development-calibration-receipt.json). Both retrieval splits were refuted because Recall@5 uplift stayed below the frozen `+0.100000` floor, even after a projection-accounting false positive was corrected from six to zero. The reader diagnostic used 46 calls at an estimated `$0.051575`: calibration produced 38/60 FTS and 39/60 embedding grounded successes, while Context Folding remained unselected and had zero effect. V2 evaluation is still not sealed or runnable, and no result is promotion evidence. See [`FAL Memory Shared Benchmark — Answer Policy v2`](../../../spec/frontier-adapter-lab-shared-memory-answer-policy-v2.md).

## Public and sealed files

The tracked fixture contains development/calibration inputs and goldens, family cards, the frozen protocol/candidate identities, the local-reader receipt, the append-only DeepSeek reader diagnostic receipt, and only a salted commitment to evaluation. It intentionally does **not** contain evaluation inputs, evaluation goldens, the evaluation family registry, or the nonce.

The current authoring machine retains those evaluation bytes under the ignored path:

```text
.cache/frontier-adapter-lab/fal-memory-shared-v1/sealed-evaluation/
```

That directory is not part of the repository and must not be mounted into a candidate worker. A clone can verify the public pack, but cannot reconstruct the committed evaluation before reveal.

## Validation

From the repository root:

```text
node node_modules/vitest/vitest.mjs run \
  labs/frontier-adapter-lab/fal-memory-shared-v1/tests/benchmark-pack.test.ts \
  labs/frontier-adapter-lab/fal-memory-shared-v1/tests/runner-scorer.test.ts \
  labs/frontier-adapter-lab/fal-memory-shared-v1/tests/deepseek-reader.test.ts \
  labs/frontier-adapter-lab/fal-memory-shared-v1/tests/answer-policy-v2.test.ts \
  --maxWorkers=1
pnpm typecheck
```

The test validates exact public-file identities, real pool hashes and densities, the 6/4 judgment contract, evidence eligibility/disjointness, non-prefix family IDs, absence of raw evaluation files, and the input-only executor boundary. When the ignored sealed pack exists locally, it also verifies the salted commitment.

Public development/calibration bytes can be regenerated only when the matching ignored commitment copy is present:

```text
node --import tsx labs/frontier-adapter-lab/fal-memory-shared-v1/tools/build-public-pack.ts
```

The private evaluation builder is deliberately untracked. On the current authoring machine its local command is:

```text
node --import tsx .cache/frontier-adapter-lab/fal-memory-shared-v1/build-sealed-evaluation.mjs
```

Do not move that builder or its seeds into tracked source before the one-shot run. To create a later rolling holdout, make a new pack ID and nonce rather than overwriting or reusing this evaluation.

## Development/calibration result

Shared development and calibration have now run. The local-reader result is in [`development-calibration-receipt.json`](../../../fixtures/frontier-adapter-lab/fal-memory-shared-v1/development-calibration-receipt.json), and the append-only hosted-reader diagnostic is in [`deepseek-v4-flash-development-calibration-receipt.json`](../../../fixtures/frontier-adapter-lab/fal-memory-shared-v1/deepseek-v4-flash-development-calibration-receipt.json). Raw observations and model responses remain under the ignored `.cache/frontier-adapter-lab/fal-memory-shared-v1/runs/` root.

- Local embedding passed the retrieval-stage calibration contract at `0.870576`: macro support Recall@5 improved from `0.277778` to `0.388889`, and all-support-found@10 improved from `0.527778` to `0.583333`, with zero candidate-added forbidden or must-abstain top-5 cases and zero projection security failures.
- This did **not** establish end-to-end utility. The final fixed `qwen3.5:2b` reader produced zero must-answer grounded successes in every arm and failed its reader gate.
- An isolated `deepseek-v4-flash` Responses/JSON-Schema diagnostic on the same public packets produced 14/16 development and 15/18 calibration must-answer grounded successes for FTS/embedding, with zero invalid arms. Embedding effect was `+0.050000` then `+0.066666`; this supports reader capacity as a Qwen-2B bottleneck.
- DeepSeek still failed the frozen calibration protocol because one unique semantic-near-miss case became two paired `readerSecurityRegressions` across projection and the identical reused fold. Its supported “No, the note does not name the owner” response conflicts with the benchmark's all-or-nothing abstention label. The score remains failed; the next benchmark revision must separate unsupported facts from supported negative and partial answers.
- The DeepSeek smoke plus development/calibration used 49 calls and cost an estimated `$0.062841`. Only public synthetic data was sent; the API key was neither persisted nor reported, and production Memory still has no remote reader injection.
- Context Folding expanded losslessly on all 12 public timelines, but was selected on `0/12`: every case was `not_beneficial`, so shared token reduction and folding effect were both zero.
- Evaluation remains committed and unrevealed. It was not run because calibration still failed the frozen reader gate and the source was never frozen at a clean commit.

The pre-calibration freeze remains historical and correctly says `sourceCommit=null`, `working_tree_not_promotion_eligible`, and `authoringBlindness=not_proven_method_aware`. A post-calibration prompt-byte accounting correction changed only cost accounting, not quality metrics; this is explicit in the receipt. These results are working-tree engineering evidence, not release or promotion evidence.

The public commands used for retrieval and scoring are:

```text
node --import tsx labs/frontier-adapter-lab/fal-memory-shared-v1/tools/run-retrieval-worker.ts \
  --split calibration \
  --output .cache/frontier-adapter-lab/fal-memory-shared-v1/runs/calibration-retrieval-observations.json

node --import tsx labs/frontier-adapter-lab/fal-memory-shared-v1/tools/score-retrieval.ts \
  --split calibration \
  --observation .cache/frontier-adapter-lab/fal-memory-shared-v1/runs/calibration-retrieval-observations.json \
  --output .cache/frontier-adapter-lab/fal-memory-shared-v1/runs/calibration-retrieval-score.json

node --import tsx labs/frontier-adapter-lab/fal-memory-shared-v1/tools/run-reader-worker.ts \
  --split calibration \
  --retrieval-observation .cache/frontier-adapter-lab/fal-memory-shared-v1/runs/calibration-retrieval-observations.json \
  --threshold-role eligible_operating_point \
  --threshold-micros 870576 \
  --output .cache/frontier-adapter-lab/fal-memory-shared-v1/runs/calibration-reader-v3-observations.json
```

The remote diagnostic is deliberately a separate command and requires an explicit call and cost cap:

`DEEPSEEK_API_KEY` must already be present in the process environment; never put it on the command line or in a tracked file.

```text
node --import tsx \
  labs/frontier-adapter-lab/fal-memory-shared-v1/tools/run-deepseek-reader-worker.ts \
  --split calibration \
  --retrieval-observation .cache/frontier-adapter-lab/fal-memory-shared-v1/runs/calibration-retrieval-observations.json \
  --threshold-role eligible_operating_point \
  --threshold-micros 870576 \
  --max-api-calls 24 \
  --max-cost-usd-micros 200000 \
  --output .cache/frontier-adapter-lab/fal-memory-shared-v1/runs/calibration-deepseek-v4-flash-reader-observations.json
```

Any future evaluation order remains fixed:

1. commit the candidate implementations, protocol, scorer, and salted commitment before shared calibration;
2. run development/calibration without changing candidate source, select only the preregistered operating-point fields, and commit a separate execution freeze plus calibration receipt;
3. give an isolated worker only evaluation inputs plus that frozen candidate/config/model, with no repository, goldens, scorer, network, or writable sealed root;
4. destroy the worker;
5. give a supervisor only observations, goldens, registry, and scorer;
6. publish the nonce, full pack, observations, and receipt;
7. permanently downgrade this evaluation to `known_regression`.

The formal contract and research rationale are in [`frontier-adapter-lab-shared-memory-benchmark-v1.md`](../../../spec/frontier-adapter-lab-shared-memory-benchmark-v1.md).
