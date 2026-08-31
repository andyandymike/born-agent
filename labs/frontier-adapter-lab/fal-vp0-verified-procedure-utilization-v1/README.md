# FAL-VP0 Verified Procedure Utilization

This directory is an isolated Frontier Adapter Lab. It does not change production recall, canonical memory, approval, effect, or agent routing.

## Current milestone

VP0a implements and verifies mechanics only:

- strict dual-source procedure and support-provenance schemas;
- typed host-fact predicates and applicability direction;
- a pre-provider boundary with twelve negative canary variants;
- equal-information baseline/procedure carriers through the production Skill runtime;
- replayed public-smoke evidence for a structural in-process fake actor;
- strict mechanics observation, freeze, pack-isolation, cost, claim, and milestone-receipt schemas.

The fake actor lane is never quality-evidence eligible. It makes zero provider and network calls. VP0b source/corpus work and VP0c live paired actor evidence remain not run.

## Run

From the repository root, choose a path that does not exist:

```text
pnpm lab:verified-procedure -- --mode mechanics --output .cache/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/runs/<new-run-id>
```

The runner uses create-exclusive output and refuses to overwrite a prior run. It writes canary observations, two isolated Skill packages, carrier preflight, public-smoke evidence/observation/verification, actor preflight, and `mechanics-summary.json`.

## Cost boundary

The same frozen host estimator checks both layers:

- rendered `SKILL.md` payload: at most 800 estimated tokens;
- full canonical `ContextItem`: at most 1,800 estimated tokens.

The original 800-token full-envelope constraint was corrected after real Skill injection measured 839–872 tokens for minimal carriers. Canonical procedure storage is separately bounded at 32 KiB because a minimal strict object with two complete sources and per-atom provenance is 17,319 bytes; the compact renderer, not provenance deletion, controls provider context cost.

## Receipt boundary

`mechanics-summary.json` is a working-tree observation, not an exact-commit milestone receipt. A valid `vp0a_mechanics` receipt is built only after the implementation, fixture packs, tracked public-smoke evidence, and actor preflight are committed together and the freeze verifier proves HEAD, parent, protected tree bytes, clean protected paths, and pack delta zero.
