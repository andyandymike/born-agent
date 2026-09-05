# FAL-MEM-E0 Agent Memory Task Effect v1

This lab contains the **offline causal-mechanics harness** for the BornAgent
memory product path plus a separate DeepSeek production tool-actor
qualification lane. The retained result is still offline mechanics evidence:
the qualification lane has three retained failed attempts, including two that
reached four logical provider turns. Neither lane has measured a live model's memory
effect, and there is no passing production tool-actor qualification.

## Frozen offline design

- 4 paired cases: 3 memory-dependent coding cases and 1 harm control.
- 8 effect arms in total: `memory off` and `memory local` for every case.
- Each arm first writes the same public-synthetic record through the explicit
  product `memory remember` command.
- The seeding process exits completely before a fresh OS process starts the
  effect task through the production application/agent path.
- The only treatment difference in the effect process is whether production
  automatic recall is disabled (`off`) or enabled (`local`).
- A host-only verifier scores the resulting workspace after the effect process
  exits.
- Remote/API calls are fixed at **0**. Deterministic backends may exercise the
  product mechanics, but they are not live-model evidence.

The resulting mechanics receipt therefore always carries:

```text
evidenceClass = product_path_structural_causal_mechanics
effectClaimAllowed = false
providerCalls = 0
```

An offline pass may support only the structural statement that explicit product
remember, durable storage, a fresh process, production recall, the real agent
loop/tools, and independent verification were connected as designed. It cannot
support a claim that memory improves task outcomes for DeepSeek, another model,
or BornAgent generally.

## Independent DeepSeek production tool-actor qualification

Before the 4-pair / 8-attempt effect batch can be authorized, one independent
qualification must show that the exact DeepSeek actor can complete the public
`mem-e0-harm-control` task through the real product path. Its default receipt is
strictly:

```text
status = not_run
providerCalls = 0
effectClaimAllowed = false
```

A passing qualification requires all of the following on one exact clean
source commit:

1. hash-bound, already-passed DS0 generic model qualification evidence for the
   same provider/model/endpoint/adapter identity; this lane does not authorize
   rerunning DS0;
2. `executeAgentThroughApplicationService`, the production AgentLoop, and V2
   session evidence rather than a domain harness or standalone model call;
3. a `RestrictedToolRegistry` exposing exactly the production `read_file`,
   `apply_patch`, `run_command`, and `finish_task` tools, with a bounded
   `read_file+ -> apply_patch -> run_command+ -> finish_task` trace and two
   exact successful-effect approvals;
4. complete per-request provider usage, no historical-memory context, exact
   workspace changes, the public verifier, and a fresh hidden verifier in a
   separate Host process after the Agent exits;
5. exact frozen source, fixture, policy, model-evidence, tool-catalog, budget,
   session, completion, and verifier identities.

The qualification has its own authorization and cost boundary:

```text
logical provider turns                    <= 6
output tokens per request                 <= 2,048
aggregate output tokens across requests   <= 12,288
reported total tokens                     <= 100,000
retries/fallback                          = 0
maximumAuthorizedCostUsdMicros             = 54,814
```

`54,814` USD micros (`$0.054814`) covers only this qualification. It does not
include the later 8-attempt effect batch, and the effect-batch authorization
cannot be reused for qualification or vice versa. Even a passing qualification
would keep `effectClaimAllowed = false`; it proves actor fitness, not a memory
benefit.

The request counter is the number of logical `backend.runTurn` calls observed
above the transport. It is not an HTTP-request counter or provider invoice.
The frozen production adapter configures zero retries, but transport retries
are not directly observed and remain `null` in the evidence. Likewise,
`deepseek-v4-flash` is a mutable provider alias: the receipt binds the requested
model ID, endpoint, adapter, and policy, not an immutable weights revision.

The qualification contract, frozen fixture and policy, clean-source and DS0
evidence gates, provider meter, Application Service executor, fresh-verifier
binding, parent runner, guarded CLI, and live-effect preflight dependency now
exist.

Generate a zero-call plan against a retained, passed DS0 observation with:

```powershell
pnpm lab:mem-e0:qualify -- plan `
  --ds0-observation .cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs/<run>/observation.json `
  --output .cache/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/qualification/plans/<name>.json
```

The plan records every value that a later `live` command must confirm exactly.
Planning is not paid-run authorization and does not read the API key. The live
command is intentionally omitted here: use `pnpm lab:mem-e0:qualify -- --help`
to inspect the full confirmation surface only after the source tree is clean.

On 2026-09-04, one separately authorized qualification attempt on clean commit
`bddd08adad761c133f53f30f9ba60de820e362c0` failed before its first provider call
(`providerCalls=0`, accounted cost zero). The original receipt is preserved:
`receiptSha256=22e65c5ee5bc8d4d995f48b3af516188ab860f8bb1850542be95090f5739dbb0`.
It is not a passing qualification or evidence of a memory benefit.

The startup repair carries the policy-resolved remote transport explicitly into
the product backend request. The exact actor preflight still rejects missing or
different transport/provider/model/endpoint/policy evidence. Its offline
regression enters the real Application Service, constructs the production
backend with a test-only sentinel credential, registers the exact four tools,
and reaches AgentLoop before stopping at an in-process `runTurn` replacement.
The network tripwire must remain at zero; this test does not issue a live receipt.

Source changes invalidate the earlier plan and authorization. A new clean commit,
exact-commit verification, zero-call plan, and separate paid authorization are
required before any new live attempt. The failed receipt remains unchanged.

The separately authorized attempt on clean commit
`fd34750c439132a6791870f9f590fc4b47b9be77` reached Application Service and AgentLoop,
used four complete logical turns, and failed with `product_path_failed` /
`bounded_stop`. Its recognized tool sequence was `read_file`, `read_file`,
`apply_patch`; there were also unrecognized tool events. Peak conservative
accounting was `$0.017867`, not a provider invoice. The retained receipt is
`d526daaa91031876ed3b1b538b7880a7fa8894da25ba117f212f04d66a2c5f6b`.

The subsequent zero-call repair addresses two independently observed defects:

- Product instructions advertised inspection tools absent from the restricted
  catalog. They now defer to the current catalog. The failed receipt does not
  identify the unrecognized tool, so this is not proof of its specific cause.
- The parent manifest rejected normal product-generated Host state even when
  the four real tools completed successfully. It now independently replays the
  actor-bound V2 journal and artifact ledger, checks each authorized object's
  content hash and metadata, and accepts only the two exact migrated navigation
  keys. All other extra files, including files under `.bornagent`, still fail.

The regression runs the production factory, PI adapter, Application Service,
four tools and exact approvals with only the SDK stream replaced by scripted
public-synthetic events. It exercises real patching, verification and completion
with zero network activity, plus corrupt/orphan/unexpected-file counterfactuals.
It is an offline regression, never a live qualification receipt. The public
tasks and hidden verifiers are unchanged. The actor configuration rebinds the
updated system-instruction hash; all old plans and authorizations are stale for
this repaired source and cannot be reused.

On 2026-09-05, a separately authorized attempt on clean commit
`5562d5e379bfef30d52e3b347d8eac5dac063f26` used four complete logical turns
and ended `failed / product_path_failed / bounded_stop`. Its trace was
`read_file`, `read_file`, `apply_patch`, `run_command`; the command did not
produce a successful public-verifier event and no `finish_task` turn remained.
The fresh hidden verifier nevertheless passed the resulting target, so the
solution bytes were correct even though the product completion protocol was
not. Conservative peak accounting was `$0.020626` (not an invoice), with zero
configured retries. The preserved receipt is
`67a11c7ceb9a43b86e1c7527c3b1cc8bcd844dff9d29d783a2ac2aa68b8f6819`.

Qualification revision 2 removes this four-turn experimental confound without
weakening the final task gate. It allows at most six logical turns in the
bounded topology above, so a normal second read and one pre-approval command
argument correction can be observed. Exactly one patch and one successful
public verifier still require the two approvals; the Agent must then call
`finish_task`, and the independent hidden verifier must pass. Provider retries
and fallbacks remain zero. The 100,000-token reserve yields a separately
authorized qualification ceiling of `$0.054814`.

The receipt parser retains the frozen revision-1 budget and exact four-tool
scorer solely for historical audit. Existing revision-1 receipts remain
self-hash and scorer verifiable, while every newly prepared qualification uses
revision 2; a revision-1 plan or authorization cannot be reused for a new run.

## DeepSeek live-effect boundary

The paired lane has a dedicated production runner, `pnpm lab:mem-e0:effect`.
It reuses the same Application Service executor, production PI backend, four
tools, approvals, token meter and frozen budgets as qualification. Its plan
prepares eight independent workspaces through fresh product `memory remember`
processes; it binds the resulting exact record/excerpt/source-reference hashes
before any credential access. The separately authorized execution starts a
fresh actor process for each arm, grants only the one bound public-synthetic
record for `on`, requires zero historical items for `off`, and runs public and
hidden verifiers after each actor exits. It is sequential and one-shot: no
automatic retry, replacement arm, or denominator filtering.

The runner implementation must be committed **before** qualification. Both
stages bind the same exact clean source commit; adding or changing the runner
after a paid qualification would invalidate that qualification. Offline test
seams are permanently tagged `offline_test` and cannot support a live effect
claim. Completing this runner does not itself mean a live test has passed.

Reusing the prior DS0 model probes must not silently requalify the current
actor. MEM-E0 pins the historical DS0 coding-instruction hash in its source and
validates that observation's original self-hashed actor configuration, usage,
record, identity, protocol and pricing. The shared VP0 current-actor entry still
requires the current instructions. This avoids invalidating historical generic
model probes whenever the current actor prompt changes; MEM-E0.3Q separately
qualifies that new prompt and tool actor. No retained DS0 bytes are rewritten.

Prepare a zero-call paired plan with:

```powershell
pnpm lab:mem-e0:effect -- plan `
  --qualification .cache/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/qualification/receipts/<name>.json `
  --ds0-observation .cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs/<run>/observation.json `
  --output .cache/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/effect/plans/<name>.json
```

A same-source `not_run` qualification plan may also be used to exercise this
zero-call preparation path, but its paired plan remains blocked from execution.
After qualification passes, prepare a new plan bound to the passed receipt.
The exact prepared plan hash authorizes all eight record disclosures and the
whole batch. Each arm has the same six-turn / 100,000-token reserve as
qualification. The integer-micro authorization ceiling is `$0.438512`: each
arm's mathematical `$0.05481344` bound is rounded upward to `$0.054814` before
the eight receipt values are summed. It is separate from the `$0.054814`
qualification ceiling. See `pnpm lab:mem-e0:effect -- --help` for
the explicit live flags; a plan never supplies its own authorization.

The paired lane remains blocked until the independent actor qualification
passes on the exact clean commit and the user separately authorizes both the
exact public-synthetic disclosure hashes and the frozen 8-attempt batch cost
ceiling. An API key or account balance is not authorization. The present
offline mechanics result does not open that boundary.

## Run the offline mechanics

```powershell
pnpm test -- labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tests/paired-mechanics.test.ts --maxWorkers=1
```

The 2026-09-01 working-tree run completed all 4 pairs / 8 arms with all arms
eligible: the 3 memory-dependent pairs were `candidate_only_win`, and the harm
control was `both_pass`. This is not an exact-commit receipt and does not change
the live-effect boundary above.
