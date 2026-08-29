# Context Folding Lite 实验记录

> 当前结果：CF2 mechanical reimplementation已完成；`implementationFidelity=verified`、`evidenceValidity=limited`、`productFit=inconclusive`、`promotion=blocked`、candidate源码保留disabled
> 历史结果：v1 receipt保持`outcome: rejected`；2026-08-28 evidence correction将其解释为fixture mechanics historically passed、product-fit evidence limited、promotion blocked
> 产品状态：Phase 20 verified receipt projection 保持不变；CF2只在`labs/**`，没有接入production adapter
> 合同：[`FAL-CF0 — FAL0 Baseline and Context Folding Lite`](../../spec/frontier-adapter-lab-fal0-context-folding-lite.md)
> 机器回执：[`v1`](../../fixtures/frontier-adapter-lab/fal0-context-folding-v1/experiment-receipt.json) / [`CF2`](../../fixtures/frontier-adapter-lab/fal-cf2-context-folding-v2/experiment-receipt.json)

## CF2 重试结果（2026-08-29）

旧CF1 candidate不能从Git、stash、unreachable objects或receipt hash恢复；CF2不是恢复旧字节，而是依据v1合同重新实现并使用新identity。新源码、runner和tests保留在[`fal-cf2-context-folding-v2`](../../labs/frontier-adapter-lab/fal-cf2-context-folding-v2/)；运行结束不会删除源码，production compiler、import graph与packed artifact均不包含candidate。

| Axis / observation | CF2 result |
|---|---:|
| Mechanical/security cases | 20 / 20 pass |
| Real verifier/projector routes | 7 |
| Security cases | 5 |
| Candidate invocations / selections | 14 / 2 |
| Extra model / tool / network calls | 0 / 0 / 0 |
| Naturalistic replay traces | 0 |
| Held-out model-quality tasks | 0 |
| Implementation fidelity | `verified` |
| Evidence validity | `limited` |
| Product fit | `inconclusive` |
| Promotion | `blocked` |
| Candidate lifecycle | `retained_disabled` |
| Reproducibility | `working_tree_full` |

两次selection都来自生成fixture（其中一例走真实verifier/projector路径），不能当作真实workload收益。当前历史运行中没有同时包含accepted child receipts和完整baseline task-context artifact的合格parent trace，所以没有伪造12条样本；`trace_token_benefit`与`model_completion`保持`not_run`。同步candidate只验证pre-invocation deadline已耗尽时不调用，不再用立即抛错冒充运行中超时抢占。Runner会自行执行pack dry-run inventory/content检查，完整`pack:smoke`也通过；Linux未运行。Candidate SHA为`9a4115e2c3382ecfed3b2c6ceeb37b1eadb3c1e3031bceb04a05689f7ec7cdcc`，receipt SHA为`dc6593a9d9b87e42a185a16191e6e88de53611ede1b3c20abc3f075117a43188`。Receipt的source-state identity覆盖CF2 source/runner/schema/tests/fixtures/config与当前production source tree，状态明确为`working_tree_full`；提交前仍不称durably immutable或exact-commit evidence。

CF2的20-case机械分数不能与EM-R1的retrieval Recall直接比较：前者发生在verified receipt projection层，后者发生在memory retrieval层。新的[`FAL Memory Shared Benchmark v1`](../../spec/frontier-adapter-lab-shared-memory-benchmark-v1.md)用同一批24条时间线运行FTS/embedding × baseline/fold四个arm，并分别报告retrieval、fold exactness、fixed-reader grounded success和成本。

### Shared benchmark结果（2026-08-29）

CF2在6条development与6条calibration完整时间线上均能lossless expansion，但12/12都因`not_beneficial`回退到baseline，selected timelines为0，shared token reduction为0，C=A、D=B，fixed-reader folding effect也为0。它保留了mechanical fidelity与0 extra calls结论，但共享数据没有观察到可用压缩收益；旧duplicate stress cases不能覆盖这一结果。完整hash与成本见[`development-calibration-receipt.json`](../../fixtures/frontier-adapter-lab/fal-memory-shared-v1/development-calibration-receipt.json)。Candidate继续`retained_disabled`，不进入production。

## 0. Evidence correction（不修改历史回执）

v1 manifest、cases、receipt与SHA保持原字节。复查发现当前24例全部由profile生成，没有trace-backed parent workload；`rawTrajectoryBytes`也是fixture声明值，不是实际trajectory测量。更具体地，Spec要求至少4个`representative + verified_receipt`，case pack实际只有3个；validator只检查all-class `verified_receipt >= 4`，被另外4个security routes补足。因此回执的`hardGateFailures=0`只符合当时较弱validator，不能证明字面corpus合同或真实workload代表性。

当前允许的解释是：v1曾观察到dictionary fold可lossless expand且在旧fixture上无security/fallback regression；旧fixture上的representative aggregate reduction为6.36%；真实产品收益仍`inconclusive`。候选源码和candidate-only tests当时被删除且未进入Git，implementation hash不能恢复源码，所以不能把v1称为full reproducibility。新合同见[`CF2 redesign Spec`](../../spec/frontier-adapter-lab-fal0-context-folding-lite.md)。

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
| Generated marker fixture declared `rawTrajectoryTokens` | 114,822 |
| Representative baseline receipt tokens | 11,824 |
| Generated marker fixture `T -> B` estimate | 89.70%（不是trace-backed产品估计） |
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

因此v1历史outcome不是`lab_verified`：eligible representative median reduction为0%，representative aggregate只有6.36%，均未达到旧25%/20% promotion policy。真实模型comparison没有运行，标记为`not_run`。这些事实阻止当时promotion，但不能覆盖mechanical observation，也不能证明真实workload没有收益。

## 3. 安全与删除边界

- v1 runner只测量由fixture声明并padding出的marker trajectory；没有采集真实parent raw trajectory。结构上可确认raw transcript从未进入parent provider context；
- stale/unverified claim 投影为 0；wrong binding 与 unaccepted receipt 投影为 0；forged hash得到 typed verifier failure；
- poison-shaped narrative仍只是 verified claim data，没有改变 authority、approval、tool/effect 或 protected category；
- injected candidate fault回到 byte-identical baseline；
- CF1 candidate 的三份源码在 focused tests 通过后已删除，当前 `compare` 模式明确拒绝运行；
- `src/memory/core/**`、`src/memory/store/**`、receipt/event schema、`TaskContextProjection` 和 `AgentContextRuntime` 均未修改。

已删除候选仍由机器回执中的 `candidateImplementationSha256` 和逐 case metrics 绑定。当前可保留、可重复运行的是 CF0 baseline lab；它用于解释现有 Phase 20 receipt folding，而不是暗示有可用 adapter。

## 4. 验证记录

- CF2 focused evidence：4 files / 16 tests passed；stored packed receipt可由runner byte-for-byte重建；
- CF2 `pnpm run typecheck`、targeted ESLint与production build：passed；
- CF2 production `dist/**` candidate marker为0，packed artifact isolation：passed；
- CF2 Windows：passed；Linux、naturalistic trace benefit、real-model quality：`not_run`；

- rejected candidate focused evidence：2 files / 3 tests passed；随后按合同删除 candidate 与 candidate-only tests；
- retained CF0 + Phase 20 product focused evidence：3 files / 7 tests passed；
- package script改变了Phase 12 reviewed offline fixture的exact `package.json` hash；按既有双fixture allowlist刷新后，Phase 12 focused evidence为1 file / 2 tests passed；
- `pnpm run test:non-pty`最终复跑：291 files / 1,332 tests passed，6 files / 12 tests按既有配置skipped；
- `pnpm run typecheck`、full lint与build：passed；
- `pnpm lab:context-folding -- --mode baseline ...`：24 cases，0 hard-gate failure；
- Windows：passed；Linux、packed、real-model quality：`not_run`；
- local `sourceCommit`：`null`，不得冒充 exact-commit CI。

## 5. 学到什么与下一步

v1 generated marker fixture测得Phase 20 projection相对其声明的raw marker减少约89.70%，该数字不能作为真实产品收益估计。当前可确认的结构事实是：Phase 20先完成Host verification与exact binding，再向parent投影verified receipt；它不把raw child transcript返回provider context。

第二层dictionary fold在exact duplication fixture上有效，但现有数据不足以断言真实BornAgent receipt distribution主要是unique或该机制有/没有产品收益。CF2已用新identity完成mechanics重试；下一步不是继续改算法，而是从未来合格parent runs按冻结sampling protocol累计至少12个独立trace replay，再用disjoint held-out completion comparison区分trace benefit与model comprehension。收益未证明只阻止promotion，源码继续保留disabled。Embedding方向也已按同一证据协议重写为EM-R1，旧3个case现称abstention false accepts而不是security leaks。
