# Context Folding Lite 实验记录

> 结果：CF0 baseline 已实现并通过；CF1 lossless dictionary fold 因代表性净收益不足而 `rejected`（2026-08-28）
> 产品状态：Phase 20 verified receipt projection 保持不变；没有接入或保留 production adapter
> 合同：[`FAL-CF0 — FAL0 Baseline and Context Folding Lite`](../../spec/frontier-adapter-lab-fal0-context-folding-lite.md)
> 机器回执：[`experiment-receipt.json`](../../fixtures/frontier-adapter-lab/fal0-context-folding-v1/experiment-receipt.json)

## 1. 实际做了什么

CF0 冻结了一个 hash-bound 24-case corpus 和 provider-neutral deterministic token estimator。Runner 同时覆盖：

- 17 个静态 accepted projection cases；
- 7 个通过真实 `ArtifactStore -> readVerifiedChildReceipt() -> projectAcceptedChildReceipts()` 路径的 cases；
- wrong Goal/Plan、unaccepted receipt、forged receipt hash、unverified/stale claim、instruction-shaped narrative 与 injected adapter fault；
- raw child trajectory diagnostic、current receipt projection 与完整 `BORNAGENT_TASK_CONTEXT_V1` 的 bytes/tokens。

CF0 发现 16 个 representative cases 中有 9 个 receipt projection 超过 512 estimated tokens，并且代表性重复 payload 达到准入阈值，所以按冻结合同实现了唯一允许的 CF1：exact claim/evidence dictionary、deterministic first-seen order、64 KiB bound、hash validation 和 byte-equivalent expansion。候选没有 LLM summary、semantic merge、truncation、额外 model/tool/network call，也没有修改 production schema。

## 2. 结果

| Observation | Result |
|---|---:|
| CF0 cases | 24 / 24 pass |
| Representative cases | 16 |
| Real verifier/projector cases | 7 |
| Representative raw trajectory tokens | 114,822 |
| Representative baseline receipt tokens | 11,824 |
| Existing `T -> B` reduction | 89.70% |
| Representative cases over 512 tokens | 9 |
| CF1 selected cases | 3 |
| CF1 selected representative cases | 1 |
| CF1 selected stress cases | 2 |
| Eligible representative median reduction | 0% |
| Representative aggregate reduction | 6.36% |
| All-case aggregate reduction | 57.69%（由两个 synthetic stress cases 主导） |
| Mechanical/security failures | 0 |
| Extra model/tool calls | 0 / 0 |

候选只在 `duplicate-claims-two-child`、`duplicate-near-limit` 和 `duplicate-eight-child` 被 25% selection rule 选中；后两例都是 deliberately duplicated synthetic stress。共享 evidence 但 narrative 不同的 representative case 反而因 dictionary key/schema overhead 变大。

因此结果不是 `lab_verified`：eligible representative median reduction 为 0%，representative aggregate 只有 6.36%，均未达到 25% / 20% hard gate。真实模型 blind comparison没有运行，标记为 `not_run`；因为 token gate 已失败，继续花模型费用不会改变这次候选的产品适配结论。

## 3. 安全与删除边界

- raw trajectory只被测量，从未进入 parent provider context；
- stale/unverified claim 投影为 0；wrong binding 与 unaccepted receipt 投影为 0；forged hash得到 typed verifier failure；
- poison-shaped narrative仍只是 verified claim data，没有改变 authority、approval、tool/effect 或 protected category；
- injected candidate fault回到 byte-identical baseline；
- CF1 candidate 的三份源码在 focused tests 通过后已删除，当前 `compare` 模式明确拒绝运行；
- `src/memory/core/**`、`src/memory/store/**`、receipt/event schema、`TaskContextProjection` 和 `AgentContextRuntime` 均未修改。

已删除候选仍由机器回执中的 `candidateImplementationSha256` 和逐 case metrics 绑定。当前可保留、可重复运行的是 CF0 baseline lab；它用于解释现有 Phase 20 receipt folding，而不是暗示有可用 adapter。

## 4. 验证记录

- rejected candidate focused evidence：2 files / 3 tests passed；随后按合同删除 candidate 与 candidate-only tests；
- retained CF0 + Phase 20 product focused evidence：3 files / 7 tests passed；
- package script改变了Phase 12 reviewed offline fixture的exact `package.json` hash；按既有双fixture allowlist刷新后，Phase 12 focused evidence为1 file / 2 tests passed；
- `pnpm run test:non-pty`最终复跑：291 files / 1,332 tests passed，6 files / 12 tests按既有配置skipped；
- `pnpm run typecheck`、full lint与build：passed；
- `pnpm lab:context-folding -- --mode baseline ...`：24 cases，0 hard-gate failure；
- Windows：passed；Linux、packed、real-model quality：`not_run`；
- local `sourceCommit`：`null`，不得冒充 exact-commit CI。

## 5. 学到什么与下一步

Phase 20 的 verified child receipt projection 本身已经完成了最有价值的一次 context folding：代表性 fixture 中，相对 raw child trajectory 减少约 89.70% active tokens，同时把 Host verification 和 exact binding 放在 parent projection 之前。

第二层 dictionary fold 对极端 exact duplication 很有效，但 BornAgent 的正常 receipt shape 主要是 unique objective、claim 和 evidence；64-character keys 与额外 schema 会抵消收益。这个结果说明下一步不该继续优化 receipt serialization，也不该引入论文级训练。按当前 frontier 顺序，下一张候选 card 转向 local embedding + FTS rank fusion；它必须先证明中文/paraphrase recall 缺口，再决定是否保留模型和 vector store。
