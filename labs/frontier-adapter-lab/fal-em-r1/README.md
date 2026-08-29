# FAL-EM-R1 retained local embedding candidate

This lab reimplements the historical `multilingual-e5-small` + live FTS hybrid without connecting it to the BornAgent product path. It retains the candidate source, candidate-only tests, pinned isolated dependency lock, artifact manifest, frozen data, reference anchors, and machine evidence even though calibration did not pass.

The retained mechanism is:

- `@huggingface/transformers@3.3.3` and `Xenova/multilingual-e5-small` at revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`;
- local-only q8 ONNX inference after explicit model preparation;
- query/passage prefixes, mean pooling, L2-normalized 384-dimensional Float32 vectors;
- scope/source/lifecycle filtering before embedding;
- a 16 KiB-page SQLite derived vector projection, exact cosine, one global per-row threshold;
- live FTS top 100 plus vector top 100 with unweighted RRF at `k=60`;
- exact ID and quoted phrase bypasses, canonical refetch, source revalidation, and existing result budgets.

Run the retained experiment from the repository root after installing the isolated lab dependencies and preparing the pinned model:

```text
pnpm --ignore-workspace --dir labs/frontier-adapter-lab/fal-em-r1 install --ignore-scripts
node labs/frontier-adapter-lab/fal-em-r1/tools/prepare-model.mjs
node --import tsx labs/frontier-adapter-lab/fal-em-r1/runner/cli.ts
```

`prepare-model` is the only network-enabled phase. The provider used by anchors, replay, calibration, and cost evidence sets Transformers.js to local-only. Model weights, dependency closure, vector databases, and prior invalid/superseded runs remain in the ignored `.cache` tree on this machine; candidate code is in this directory and is not imported or packed by production.

The retained final result is calibration refutation, not product rejection of all embeddings: reference anchors passed, security/delta-safety invariants can be met, but no threshold reaches the preregistered semantic `13/16` requirement (the full curve peaks at `8/16`). Historical output replay is only `26/36` because the rehydrated artifact manifest differs from the old non-retained candidate, so historical root-cause attribution remains inconclusive.

Evidence audit correction: evaluation cases were not parsed or scored, but their files were read while verifying the all-file manifest. The split also used split-prefixed IDs over semantically related calibration/evaluation topics, so it is not a proven blind, sealed, or semantic-family-disjoint holdout. The original receipt remains unchanged; [`evidence-correction-v2.json`](../../../fixtures/frontier-adapter-lab/fal-em-r1-selective-hybrid-v2/evidence-correction-v2.json) records the append-only correction. This evaluation is now `known_exposed_holdout_development_only`.
