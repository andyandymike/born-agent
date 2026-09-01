# FAL-CF0 — FAL0 Baseline and Context Folding Lite Experiment Spec

> Status: historical CF0/CF1 v1 receipt closed；CF2 mechanical reimplementation completed；shared public development/calibration已运行且12/12 synthetic timelines未选择candidate；trace-backed product evaluation与Agent任务效果仍未运行（updated 2026-09-01）
> Parent contract: [`Lightweight Memory Core and Frontier Adapters Spec`](agent-memory-lightweight-core-and-adapters.md)
> Existing product baseline: Phase 20 controlled delegation is Implemented / M11 Passed
> Historical timebox: 8–16 focused hours；CF2 has a new 8–16 focused-hour budget
> Product default: unchanged；historical candidate源码已删除且不在Git中；CF2源码保留在`labs/**`且默认disabled，production adapter不存在

## 0. 文档地位与当前决定

本spec冻结Frontier Adapter Lab的第一张experiment card：先建立最小FAL0共用评测底座，再判断BornAgent现有verified child receipt projection是否已经实现了足够的Context Folding Lite；只有baseline确有可量化缺口时，才实验一层lossless deterministic fold。

它从主Memory spec继承下列边界：

1. 一次只进行一个active experiment；
2. adapter只能消费已经完成Host验证和current binding过滤的输入；
3. disabled、pre-invocation deadline exhausted、throw或invalid output必须回到existing baseline；
4. 实验不能修改canonical memory、current authority、approval或effect语义；
5. `lab_verified`不等于`preview_usable`，更不表示production默认启用；
6. v1历史上使用`baseline_sufficient/lab_verified/rejected/inconclusive`；CF2必须使用父合同evidence-protocol v2的正交结论，不能继续扩张scope。

本spec仍是exact experiment contract；完成证据见[`Context Folding Lite 实验记录`](../docs/agent-memory/context-folding-lite-experiment-record.md)、[`v1 machine receipt`](../fixtures/frontier-adapter-lab/fal0-context-folding-v1/experiment-receipt.json)与[`CF2 machine receipt`](../fixtures/frontier-adapter-lab/fal-cf2-context-folding-v2/experiment-receipt.json)。

### 0.1 v1历史结果与证据更正

CF0/CF1的v1 manifest、cases、receipt、receipt SHA与`outcome: rejected`保持历史原值，不回写机器事实。该receipt证明当时runner上的mechanical/security/lossless checks为0 failure，且dictionary fold只在1个作者标记的representative case和2个synthetic stress cases被旧25% selector选中。

但是v1不能支持“真实BornAgent workload代表性净收益不足”的因果结论：24例全部由profile生成，trace-backed case为0；`rawTrajectoryBytes`是声明值并由runner用marker padding，不是实际parent trajectory测量；字面Spec要求至少4个`representative + verified_receipt`，case pack实际只有3个，validator却错误地只检查all-class `verified_receipt >= 4`并被4个security route补足。`hardGateFailures=0`因此只符合较弱validator，不符合字面corpus合同。

按evidence-protocol v2重新解释为：`implementationFidelity=inconclusive`（candidate源码已删除，不能逐行复核）、`evidenceValidity=limited`、lossless/security fixture claims historically supported、`productFit=inconclusive`、`promotion=blocked`、`direction=revise`、`reproducibility=corpus_only`、`candidateLifecycle=removed_legacy_policy`。这不是对Context Folding论文、dictionary fold机制或未来实现的否定。

### 0.2 Agent-effect scope correction（2026-09-01）

Context Folding处理的是verified child receipt的request-local projection，不是长期记忆的写入、持久化或检索方案。CF2只运行mechanical fixture，`trace_token_benefit`和`model_completion`均为`not_run`；shared benchmark也只在12条public synthetic receipt timelines上观察到`selected=0`与fixed-packet reader effect为0。因此任何“真实Agent没有收益”“真实workload没有token收益”或“长期记忆方向被否定”的结论均撤回。允许结论只保留lossless、fallback、projection安全检查和本批synthetic selector observation。机器纠偏见[`agent-memory-effect-scope-correction-v1.json`](../fixtures/frontier-adapter-lab/fal-memory-shared-v2/agent-memory-effect-scope-correction-v1.json)，历史receipt原字节不变。

## 1. Live baseline：BornAgent已经做了一次receipt folding

当前真实调用链是：

```text
sealed minimal child context capsule
  -> isolated delegated child AgentLoop
  -> bounded child result
  -> Host verifies expected claims and evidence
  -> ChildReceiptV1 (strict hash, <=64 KiB)
  -> user/Host accepts exact receipt revision
  -> readVerifiedChildReceipt()
  -> projectAcceptedChildReceipts()
  -> AcceptedChildReceiptContextItemV1[] (aggregate <=64 KiB)
  -> TaskContextProjection.acceptedChildReceipts
  -> BORNAGENT_TASK_CONTEXT_V1 provider context
```

现有baseline已经具备Context Folding的关键形态：

- child由sealed capsule约束，不继承parent task graph或parent authority；
- parent不接收raw child transcript、stdout/stderr、tool tail、unverified claim或stale claim；
- parent只接收delegation/attempt identity、status、objective、verified claim narrative、evidence refs、change bundle ref、verification generation IDs与receipt hash；
- receipt和parent projection都有64 KiB hard bound；
- exact Goal/Plan binding与accepted receipt验证发生在projection前；current product call允许同一Goal/Plan内跨parent run复用accepted receipts，不额外发明`parentActorId`过滤；
- task context仍由Host确定性构造。模型生成的自由summary不能进入这条`authoritative` task-context路径。

因此本实验不是“首次实现child branch/return”，而是回答两个更窄的问题：

1. 当前receipt projection相对raw child trajectory已经节省了多少active context？
2. 在多个accepted receipts存在重复claim/evidence时，额外lossless dictionary fold能否继续降低parent tokens，同时不降低模型理解和任务完成？

## 2. 目标与明确不做

### 2.1 必须交付

1. 一个local-free、tracked、deterministic的FAL0 context-folding corpus与runner；
2. 对raw child trajectory diagnostic、current receipt projection baseline和optional fold candidate使用同一token estimator；
3. exact记录quality、tokens、bytes、wall latency、model/tool calls、storage/install delta和failure fallback；
4. 证明baseline从不把raw transcript或unverified/stale claim带回parent；
5. 先作CF0 baseline characterization，再决定是否允许CF1 candidate代码存在；
6. candidate若存在，必须可lossless expand回byte-equivalent `AcceptedChildReceiptContextItemV1[]`；
7. candidate只在per-case达到固定净收益时被选择，否则使用baseline；
8. 留下一份machine-readable experiment receipt和中文学习记录。

### 2.2 明确不做

- 不训练或微调Context Folding/FoldGRPO模型；
- 不引入LLM summary、reflection model、embedding、PACE view、graph或vector DB；
- 不改变child task选择、delegation depth、parallelism、tool/model routing或workspace策略；
- 不改变`ChildReceiptV1`、accepted receipt event、Goal/Plan/TaskGraph、CompletionPolicy或Outcome authority；
- 不给parent新增读取raw child transcript的tool；
- 不写Memory v1 canonical或derived store；context fold是per-request ephemeral projection；
- 不新增adapter registry、plugin framework、daemon、background worker或remote service；
- 不把实验命令加入stable `born` CLI；
- 不因synthetic stress case获益就宣称真实coding任务获益；
- 不在本spec中晋级`preview_usable`。若实验成功，product接入另写promotion amendment。

## 3. 实验切片与假设

### 3.1 FAL0/CF0 — characterize existing fold

CF0先不修改production source，只冻结corpus和观测器：

```text
Arm T: raw child session/trajectory size
       diagnostic only; never provider context

Arm B: current AcceptedChildReceiptContextItemV1[]
       exact production baseline

Arm F: optional lossless folded representation
       only exists after CF0 proves fold-eligible cases
```

CF0必须报告：

- `T -> B` byte/token reduction；
- B中receipt数量、verified claims、unique/duplicate narratives、unique/duplicate evidence refs；
- B占整个`BORNAGENT_TASK_CONTEXT_V1`与最终ContextPlan的token比例；
- current 64 KiB bound是否在代表性case中接近或触发；
- 是否有真实parent task因为accepted receipts导致context budget failure或明显挤压其他非protected context。

如果代表性real-route cases的B部分p95不超过512 estimated tokens，且没有receipt-driven context failure，允许在4–8小时直接以`baseline_sufficient`收口；synthetic duplication stress的潜在收益不能单独推翻这个结论。

### 3.2 CF1 — optional lossless dictionary fold

只有CF0同时发现下列任一事实，才能实现CF1：

- 至少4个representative cases的B部分超过512 estimated tokens；
- 至少1个real-route case因accepted receipts接近/触发context budget failure；
- representative multi-child cases中exact duplicate narrative/evidence占B tokens的20%以上。

CF1只允许一个intervention：把多个accepted receipts做lossless dictionary encoding，消除exact重复的claim payload和evidence reference；不进行语义合并、自由摘要、截断或unique fact删除。

### 3.3 假设

- **H0 / baseline sufficient**：现有verified receipt projection已经足够小；额外fold的收益不足以抵消schema和模型理解成本。
- **H1 / candidate useful**：在representative fold-eligible cases中，F比B至少减少25% accepted-receipt estimated tokens，且信息、authority、安全与completion没有回退。

证明H0也是成功结果。项目不以新增文件数量衡量实验价值。

## 4. FAL0 corpus合同

### 4.1 v1固定24 cases（历史fixture-only corpus）

本card的首版case pack固定24个cases，保持在主仓tracked、无secret、无network、无credential。它复用FAL0的metric/report/security envelope，但只证明context-folding问题；未来embedding、consolidation或procedure card必须增加自己的applicable pack，不能把这24例冒充通用memory质量证据：

| Category | Count | Purpose |
|---|---:|---|
| single-child answer/read | 6 | short/long objective、1–8 verified claims、exact evidence lookup facts |
| multi-child aggregation | 4 | deterministic sequence、overlap、same claim IDs across different receipts |
| duplicate/noise pressure | 4 | repeated narrative、repeated artifact refs、near-64 KiB baseline stress |
| coding/status | 4 | change bundle、verification IDs、failed/blocked/cancelled与zero-claim receipt |
| security/freshness | 6 | forged hash、stale/unverified claim、wrong Goal/Plan、unaccepted/superseded receipt、poison narrative、adapter fault |
| **Total** | **24** | 其中至少12个标记`representative`，其余为`stress`或`security` |

v1字面合同要求至少4个representative cases通过real verifier/projector route构造；静态对象fixture不能替代`readVerifiedChildReceipt()`与exact binding验证。历史case pack只有3个`representative + verified_receipt`，因此该条件没有满足；原validator只统计all-class route是已知实现缺口。Raw child trajectory只保存无secret fixture及hash/byte/token observation，不成为candidate input。

### 4.2 Fixture layout

```text
fixtures/frontier-adapter-lab/fal0-context-folding-v1/
  manifest.json
  cases.json
```

`cases.json`中的每个case同时保存独立input profile与人工expected facts，先由spec/fixture authoring冻结，不能根据candidate输出反向更新golden。Runner只在temporary workspace中由profile生成real-route receipt artifact，tracked fixture不保存绝对用户路径。`manifestSha256`覆盖除自身外的全部canonical manifest fields，并绑定`cases.json`的exact SHA-256。一个hash-bound case pack替代48个微小文件，减少开源维护噪声，但不降低case identity或golden独立性。

### 4.3 Manifest

```ts
interface Fal0ContextFoldingManifestV1 {
  readonly schemaVersion: 1;
  readonly experimentId: "fal-cf0-context-folding-lite-v1";
  readonly estimatorId: string;
  readonly casePackRef: "cases.json";
  readonly casePackSha256: string;
  readonly caseIds: readonly string[];
  readonly manifestSha256: string;
}
```

每个case的`expected`只声明Host可机械验证的事实：receipt/claim counts、ordered status、required/forbidden projection、expected failure code与representative eligibility。它不能包含candidate serialization或从candidate输出生成的值。

## 5. Optional fold exact contract

### 5.1 Candidate value

```ts
interface AcceptedChildReceiptFoldV1 {
  readonly schemaVersion: 1;
  readonly kind: "accepted_child_receipt_fold";
  readonly sources: readonly {
    readonly sourceOrdinal: number;
    readonly delegationId: string;
    readonly childAttemptId: string;
    readonly status: "succeeded" | "failed" | "blocked" | "cancelled";
    readonly objective: string;
    readonly claims: readonly {
      readonly claimId: string;
      readonly claimKey: string;
    }[];
    readonly changeBundleRef: string | null;
    readonly verificationGenerationIds: readonly string[];
    readonly receiptSha256: string;
  }[];
  readonly claims: readonly {
    readonly claimKey: string;
    readonly kind: string;
    readonly narrative: string;
    readonly evidenceKeys: readonly string[];
  }[];
  readonly evidence: readonly {
    readonly evidenceKey: string;
    readonly artifactRef: string;
  }[];
  readonly sourceSetSha256: string;
  readonly foldSha256: string;
}
```

`claimKey`固定为`sha256Canonical({ kind, narrative, evidenceRefs })`；`evidenceKey`固定为`sha256Canonical({ artifactRef })`。Key只做candidate内dictionary identity，不升级为canonical receipt identity。

### 5.2 Deterministic algorithm

1. 输入只能是`projectAcceptedChildReceipts()`已经返回的ordered values；adapter不直接读session、artifact或delegation store。
2. `sources`保持current projector顺序；`sourceOrdinal`从0连续递增。
3. 每个source中的claim保持原顺序；相同`claimKey`只在global `claims`出现一次。
4. 每个claim中的evidence ref保持原顺序；相同`evidenceKey`只在global `evidence`出现一次。
5. dictionary条目按第一次出现顺序写入；不得按locale或wall clock重排。
6. objective、unique narrative、status、claim ID、evidence ref、change bundle、verification ID和receipt hash不得截断、改写或省略。
7. `sourceSetSha256 = sha256Canonical(ordered receiptSha256s)`。
8. `foldSha256`覆盖除自身外全部canonical fields。
9. 相同input、estimator和budget重复运行必须byte-equivalent。

### 5.3 Lossless and selection rule

实现必须同时提供`expandAcceptedChildReceiptFold()`。对每个candidate：

```text
canonicalJson(expand(fold)) === canonicalJson(baselineAcceptedChildReceipts)
```

不满足即typed `context_fold_invalid`并使用baseline。不得“尽量恢复”或返回partial fold。

选择规则固定为：

```text
candidate bytes <= 64 KiB
AND candidate estimated tokens <= floor(baseline estimated tokens * 0.75)
AND lossless expansion exact
  -> use fold in experiment arm
else
  -> baseline_required
```

CF1 lab runner可以把fold序列化为candidate `BORNAGENT_TASK_CONTEXT_V1`进行对比，但不得修改production `TaskContextProjection` schema或`AgentContextRuntime`默认路径。产品接入必须另写amendment，重新决定schema version、feature flag与migration/fallback。

## 6. Metrics and evidence contract

### 6.1 Per-case observation

```ts
interface Fal0ContextFoldingCaseResultV1 {
  readonly caseId: string;
  readonly class: "representative" | "security" | "stress";
  readonly baseline: {
    readonly rawTrajectoryBytes: number | null;
    readonly rawTrajectoryTokens: number | null;
    readonly receiptProjectionBytes: number;
    readonly receiptProjectionTokens: number;
    readonly taskContextTokens: number;
    readonly receiptCount: number;
    readonly verifiedClaimCount: number;
  };
  readonly candidate: null | {
    readonly bytes: number;
    readonly tokens: number;
    readonly selected: boolean;
    readonly losslessExpansion: boolean;
    readonly duplicateClaimInstancesRemoved: number;
    readonly duplicateEvidenceInstancesRemoved: number;
  };
  readonly correctness: {
    readonly requiredFactsPresent: boolean;
    readonly forbiddenFactsAbsent: boolean;
    readonly sourceIdentityExact: boolean;
    readonly authorityEquivalent: boolean;
  };
  readonly cost: {
    readonly additionalModelCalls: number;
    readonly additionalToolCalls: number;
    readonly projectorDurationMs: number;
  };
  readonly status: "pass" | "fail" | "not_applicable";
}
```

Wall time只作同机diagnostic；hard gate使用bytes、tokens、calls、hashes和logical facts。缺失provider token usage保持`null`，不得写成0。

### 6.2 Hard correctness/security gates

所有24 cases必须满足：

- required status/objective/claim/evidence/change/verification facts为100%；
- source receipt set/order/hash为100%；
- unverified/stale/forged/wrong-Goal/Plan或unaccepted inputs进入parent context为0；同一Goal/Plan内的cross-run accepted receipt保持existing Phase 20语义；
- raw transcript进入parent context为0；
- adapter新增model calls为0、tool calls为0、network calls为0；
- adapter不能改变authority、protected category、approval、tool registry、effect或completion；
- disabled/injected throw/timeout/invalid fold回退后baseline task-context bytes/hash相同；
- poison case相对baseline不能增加instruction/authority/effect成功率；
- 删除整个candidate目录后existing Phase 20 and Memory logical behavior不变。

任一G1/G2 hard gate失败才能判定当前candidate mechanics失败，不能用平均token收益覆盖。历史v1曾把后续product-fit gate也折叠进`rejected`；CF2禁止这种解释。

### 6.3 v1 Net-benefit gate（历史promotion policy，不是机制真理）

只有同时满足下列条件才可标`lab_verified`：

1. 至少8个representative cases为fold-eligible；
2. eligible representative cases的median token reduction不低于25%；
3. candidate-selected case没有任何一例大于baseline；
4. representative corpus aggregate receipt tokens至少降低20%；
5. additional model/tool/network calls全部为0；
6. 使用同一pinned backend/model/runtime policy的blind completion comparison至少覆盖8个representative tasks，candidate full-pass count不低于baseline，且security task零回退；
7. model comparison repetitions、temperature/seed支持、reported usage和not-run原因完整记录；单次成功不能证明质量；
8. focused Windows local evidence通过；若未运行Linux/pack或真实模型，receipt必须对应标`not_run`，不得推断cross-platform/product/model quality。

如果mechanical gates和token gate通过，但blind model comparison未运行，overall结果只能是`inconclusive`，同时可记录`mechanism_passed: true`。如果收益只出现在stress cases，结果为`baseline_sufficient`或带product-fit原因的`rejected`，不能标`lab_verified`。

## 7. Experiment receipt

```ts
interface Fal0ContextFoldingReceiptV1 {
  readonly schemaVersion: 1;
  readonly experimentId: "fal-cf0-context-folding-lite-v1";
  readonly sourceCommit: string | null;
  readonly manifestSha256: string;
  readonly estimatorId: string;
  readonly baselineImplementationSha256: string;
  readonly candidateImplementationSha256: string | null;
  readonly cases: readonly Fal0ContextFoldingCaseResultV1[];
  readonly aggregate: {
    readonly representativeCases: number;
    readonly foldEligibleCases: number;
    readonly baselineReceiptTokens: number;
    readonly selectedReceiptTokens: number;
    readonly medianEligibleReductionRatio: number | null;
    readonly hardGateFailures: number;
  };
  readonly qualityEvidence: "passed" | "failed" | "not_run";
  readonly platformEvidence: {
    readonly windows: "passed" | "failed" | "not_run";
    readonly linux: "passed" | "failed" | "not_run";
    readonly packed: "passed" | "failed" | "not_run";
  };
  readonly outcome:
    | "baseline_sufficient"
    | "lab_verified"
    | "rejected"
    | "inconclusive";
  readonly actualFocusedMinutes: number;
  readonly receiptSha256: string;
}
```

`receiptSha256`覆盖除自身、每个case的`projectorDurationMs`与顶层`actualFocusedMinutes`外的canonical logical receipt fields；这两个wall-time字段只作诊断，不能污染跨进程逻辑身份。Receipt不得包含raw transcript、claim narrative、absolute path、secret、provider prompt或用户文本；只保存case IDs、counts、hashes、metrics和status。Local `sourceCommit=null`不能冒充exact-commit CI。

## 8. Mechanical acceptance cases

| ID | Case | Required result |
|---|---|---|
| `FAL-CF01` | one accepted child | B contains typed receipt facts, no transcript |
| `FAL-CF02` | two receipts finish out of order | B/F preserve projector sequence |
| `FAL-CF03` | duplicate exact claims | F dictionary deduplicates and expands byte-equivalent |
| `FAL-CF04` | same claim ID, different receipts/content | no semantic merge; both occurrences preserved |
| `FAL-CF05` | repeated artifact ref | evidence dictionary deduplicates exact ref only |
| `FAL-CF06` | unique long claims | selection returns `baseline_required` if <25% gain |
| `FAL-CF07` | failed/blocked/cancelled/zero claims | exact status/objective/source retained |
| `FAL-CF08` | change bundle + verification IDs | expand restores all exact refs/order |
| `FAL-CF09` | unverified/stale claim | absent before adapter input |
| `FAL-CF10` | forged receipt/hash or missing artifact | typed verifier failure, adapter not called |
| `FAL-CF11` | wrong Goal/Plan or unaccepted receipt | zero adapter input and zero parent projection |
| `FAL-CF12` | instruction-shaped verified narrative | no authority/approval/effect delta vs baseline |
| `FAL-CF13` | adapter disabled | baseline task context byte/hash equivalent |
| `FAL-CF14` | injected adapter throw/timeout/invalid fold | typed diagnostic + exact baseline fallback |
| `FAL-CF15` | repeated process run | same manifest/case/fold/logical receipt hashes；wall-time可不同 |
| `FAL-CF16` | representative blind completion | candidate pass/security does not regress baseline |

## 9. Implementation map

CF0只新增fixture、runner、tests和record；如果CF0结果为`baseline_sufficient`，下列candidate files不得创建。

```text
fixtures/frontier-adapter-lab/fal0-context-folding-v1/
src/frontier-adapters/context-folding/
  fal0-manifest.ts
  fal0-runner.ts
  fal0-receipt.ts
  folded-child-receipt-schema.ts      # CF1 conditional
  folded-child-receipt-projector.ts   # CF1 conditional
  folded-child-receipt-expander.ts    # CF1 conditional
scripts/run-context-folding-lab.mjs
tests/unit/fal0-context-folding-*.test.ts
tests/integration/fal0-context-folding-*.test.ts
docs/agent-memory/context-folding-lite-experiment-record.md
```

允许的`package.json`入口只有实验命令：

```text
pnpm lab:context-folding -- --mode baseline --report <path>
pnpm lab:context-folding -- --mode compare --report <path>
```

最终保留版本只允许`baseline`产生新回执；`compare`会以非零状态明确说明CF1已被net-benefit gate拒绝，防止已删除candidate被误认为仍可用。历史compare结果保存在hash-bound machine receipt中。

首个实验直接实现concrete runner；只有CF0 permit CF1时才实现concrete candidate。不建立generic adapter registry、generic benchmark framework或persistent store。第二个真实adapter出现并证明共享接口有价值前，不抽象FAL SDK。

CF0/CF1不得修改：

```text
src/memory/core/**
src/memory/store/**
src/delegation/receipts/child-receipt-schema.ts
src/delegation/delegation-event-schema.ts
src/coordination/task-context-projection.ts       # lab阶段保持production baseline
src/context/agent-context-runtime.ts               # lab阶段保持production baseline
```

如果为了实验必须修改上述production schema/path，当前card立即停止并先写amendment；不能把product integration伪装成lab plumbing。

## 10. 实现顺序、预算与stop conditions

| Step | Deliverable | Budget |
|---|---|---:|
| CF0.1 | freeze 24-case manifest/goldens and estimator | 2–3h |
| CF0.2 | baseline runner + T/B observations + real projector cases | 2–3h |
| CF0 decision | `baseline_sufficient` or permit CF1 | 0.5h |
| CF1.1 conditional | lossless fold schema/projector/expander | 2–3h |
| CF1.2 conditional | compare runner, faults, blind quality evidence | 2–4h |
| closure | receipt, learning record, focused checks | 1–2h |

预计CF0-only为4–8 focused hours；CF0+CF1为9–15 focused hours。以下任一情况立即停止新增功能：

- 到第8小时仍没有可复现baseline receipt；
- 不能从live production projector得到至少4个real-route cases；
- candidate需要LLM summary、semantic truncation或改canonical receipt才能达到收益；
- lossless expansion出现任何mismatch；
- benefit只来自stress cases；
- blind quality或security低于baseline；
- production path修改超过isolated experiment边界；
- focused time达到16小时。

## 11. v1历史实验演示

```text
1. Load exact tracked manifest and validate all hashes.
2. Run Arm T diagnostic for real-route fixtures; prove it is never provider context.
3. Run current projectAcceptedChildReceipts baseline and save B metrics.
4. Apply CF0 decision rule.
5. If baseline_sufficient, emit receipt and stop with no candidate source.
6. Otherwise build F from the same ordered accepted receipts.
7. Expand F and prove canonical equality with B.
8. Compare bytes/tokens/calls and run all security/fallback cases.
9. Run pinned blind completion comparison or record qualityEvidence=not_run.
10. Disable/delete candidate and prove baseline task-context hash is restored.
11. Emit one Fal0ContextFoldingReceiptV1 and learning record.
```

没有第3、4步不能声称理解当前baseline；没有第7、8步不能称lossless；没有第9步不能称`lab_verified`；没有第10步不能称isolated/deletable adapter。以上是v1历史流程；CF2以临时副本和import-graph证明deletability，不再删除仓库内唯一candidate源码。

## 12. 研究来源与没有照搬的部分

- [Context Folding](https://openreview.net/forum?id=lNRgWoGfYg)提供branch/return、active-context reduction与completion comparison问题；
- [Context Folding project](https://context-folding.github.io/)和[FoldAgent](https://github.com/sunnweiwei/FoldAgent)提供公开结果与开源复现入口；
- [`Phase 20C`](11-m11-controlled-subagents/20c-child-runtime-and-structured-receipts.md)与[`Phase 20E`](11-m11-controlled-subagents/20e-product-integration-and-m11-gate.md)定义BornAgent现有sealed child、verified receipt和parent merge事实；
- [`parent-receipt-projector.ts`](../src/delegation/receipts/parent-receipt-projector.ts)与[`task-context-projection.ts`](../src/coordination/task-context-projection.ts)是本实验baseline authority。

本实验只借用“branch不把完整轨迹返回parent、用同任务completion衡量压缩”的机制。它不照搬paper-scale RL、专用fold action、长轨迹训练、Qwen/Seed模型、GPU stack或论文中的absolute benchmark数字；FoldAgent公开实现也不能代替BornAgent自己的baseline和复现实验。

## 13. v1历史完成决策

- `baseline_sufficient`：记录“Phase 20 verified receipt已经是BornAgent的Context Folding Lite”，不新增adapter；下一张card转向local embedding hybrid。
- `lab_verified`：保留isolated candidate与证据，另写product-promotion amendment；在amendment通过前仍不接入production task context。
- `rejected`：删除candidate，保留fixture、receipt和学习记录；下一张card转向local embedding hybrid。
- `inconclusive`：保留最小可复现证据和未解决问题，不继续投入，也不宣称失败或成功。

这里的单一outcome和`rejected => delete source`规则已被父合同evidence-protocol v2取代。v1 receipt保持immutable，只作为prior evidence。

## 14. CF2 — Trace-backed Context Folding Re-evaluation

### 14.1 研究问题与身份

CF2不是修改v1 golden，也不是从hash“恢复”旧源码。它使用新identity：

```text
experimentId: fal-cf2-context-folding-v2
priorEvidenceReceiptSha256: 88cac12c8010d24266bcc2900fc5f4ee3a9f9724329f63d27f9633a931cd3d9b
priorCandidateImplementationSha256: b63740754e947af6a37d571380936d9c57eaa865b35f91cf5323d434c68c3981
```

旧`sourceCommit=null`且candidate源码不在Git中，所以新实现必须标`reimplementation_from_v1_contract`并生成新hash，不能声称byte-equivalent于v1。CF2回答三个分离问题：

1. reimplementation是否lossless、deterministic且保持authority/fallback；
2. exact dictionary fold在真实BornAgent parent workload中多久激活、实际节省多少完整task-context token；
3. 若直接把folded schema交给模型，任务质量是否不低于baseline。

### 14.2 Evidence provenance

CF2禁止作者手填`representative: true`。每个case必须由manifest和runner证明下列provenance之一：

```ts
type Cf2EvidenceKind =
  | "generated_fixture"
  | "verified_route_fixture"
  | "trace_replay"
  | "stress";

type Cf2CaseRole =
  | "mechanical"
  | "security"
  | "known_regression"
  | "naturalistic_product_evaluation"
  | "targeted_model_quality";

interface Cf2TraceProvenance {
  readonly parentRunIdSha256: string;
  readonly sourceCommit: string | null;
  readonly sourceDirtyStateSha256: string | null;
  readonly capturePoint: "after_parent_receipt_projection_before_provider_request";
  readonly captureToolVersion: string;
  readonly acceptedChildReceiptItemsArtifactRef: string;
  readonly acceptedChildReceiptItemsSha256: string;
  readonly baselineTaskContextArtifactRef: string;
  readonly baselineTaskContextSha256: string;
  readonly redactionTransformId: "none" | string;
  readonly redactionTransformSha256: string | null;
}
```

- `generated_fixture`：只验证schema、selector、expander与fault mechanics；
- `verified_route_fixture`：走真实`ArtifactStore -> readVerifiedChildReceipt() -> projectAcceptedChildReceipts()`，但payload仍为生成数据，只证明path realism；
- `trace_replay`：来自已完成的真实BornAgent parent run，并满足`Cf2TraceProvenance`；只有role为`naturalistic_product_evaluation`的trace可进入product-fit聚合；
- `stress`：只验证64 KiB、重复率、延迟和边界，不能补足trace数量。

`rawTrajectoryBytes/tokens`只有从实际trajectory测得时才能为数值，否则必须为`null`；禁止按profile声明值padding marker后再把结果叫workload observation。每条trace必须绑定exact safe `AcceptedChildReceiptContextItemV1[]` artifact ref与SHA、可重建非receipt wrapper的baseline完整task-context artifact ref与SHA、parent run identity、source commit/dirty-state、capture point/tool version和redaction identity，不能用作者手填counts或只有SHA的占位代替可replay artifact。所有artifact ref必须是evidence pack内的relative path、无absolute/user path，并在retained/tracked pack中解析且hash一致；ref缺失或hash不符时该case不得进入valid aggregate，并降低`evidenceValidity/reproducibility`。Schema必须机械保证`sourceCommit`与`sourceDirtyStateSha256`至少一个非null；clean run使用commit且dirty hash为null，dirty run同时绑定base commit与dirty-state hash。`redactionTransformId="none"`时hash必须为null，其他ID必须同时提供transform hash。Trace capture必须显式选择无secret任务，保存最小结构和可验证artifact，不保存raw hidden reasoning。若脱敏会改变token分布，必须记录transformation identity；该trace只能用于mechanics/model-quality，不能补足14.3的12条product-fit cohort或支持绝对token收益claim。

### 14.3 Corpus与freeze合同

CF2保留v1 case pack作为`known_regression/generated_fixture`，另建：

```text
fixtures/frontier-adapter-lab/fal-cf2-context-folding-v2/
  manifest.json
  mechanical-cases.json
  traces/evaluation/
  prior-evidence-assessment.json
  experiment-receipt.json
```

Product-fit evidence至少包含12个独立`trace_replay`，每个来自不同parent run，其中至少4个为multi-child context，并覆盖至少3种task/status shape。冻结顺序固定为：先冻结candidate implementation、selector、token estimator、scorer与sampling protocol的hash，随后才能开放或选择evaluation payload；最后按预注册时间窗内`first N qualifying consecutive runs`取得cohort。Qualifying predicate只能使用任务授权、无secret、capture完整性、task/status strata和run独立性，禁止按重复率、payload大小、candidate activation或预估收益挑样。Synthetic、security、同一run重复投影、`targeted_model_quality`或事后补选都不能补足数量。不满足时写`evidenceValidity=limited`、`productFit=inconclusive`，不是mechanism failure。

所有route计数都按完整predicate机械检查，不能用all-class总数替代。CF2 manifest test必须包含`3 trace_replay + multi_child`加`4 verified_route_fixture + security`仍因`trace_replay + multi_child < 4`而失败的negative canary。另保留一个只针对v1 manifest validator的historical canary，证明旧`3 representative + verified_receipt`不能被4个security verified routes补足；CF2不重新引入`representative`字段。

### 14.4 G1/G2 mechanical contract

以下才是CF2零容忍mechanism gates：

- `canonicalJson(expand(fold(B))) === canonicalJson(B)`；
- receipt set/order/hash、status、objective、claims、evidence、change、verification和authority 100%等价；
- stale、unverified、wrong Goal/Plan、unaccepted或forged input进入candidate为0；
- raw transcript进入parent context为0；
- disabled、pre-invocation `deadline_expired`、throw、invalid或over-bound output回到byte/hash-equivalent baseline；
- 新增model/tool/network calls均为0；
- selector比较完整provider context（包含dictionary schema与wrapper），任一selected case都不得大于baseline；
- production import graph与pack中candidate为0，删除临时lab副本后core logical behavior不变。

全部通过时记录`implementationFidelity=verified`，不受token收益或模型completion结果覆盖。任一失败才记录`implementationFidelity=failed`并阻止promotion。

本revision的candidate是无await、无I/O、输入64 KiB有界的同步纯变换，因此只验证Host在调用前发现deadline已耗尽时不进入candidate并回到exact baseline；它不把一个立即抛错的fixture冒充“运行中可抢占超时”。若未来把candidate移入async/worker边界，必须新增真实deadline/termination test后才能声称mid-execution timeout isolation。当前wall-time/latency仍属于promotion前未完成证据。

### 14.5 Product-fit与model-quality

Trace cohort必须逐项报告candidate activation rate、accepted-receipt saved tokens、完整`BORNAGENT_TASK_CONTEXT_V1` saved tokens、aggregate/p50/p95、context-budget overflow avoided count与额外p50/p95 latency。旧“eligible median 25% + representative aggregate 20%”不再作为技术成败门。

以下只是BornAgent仓库的轻量promotion policy，不宣称论文普遍阈值：

- trace evidence满足14.3；
- 至少2个独立trace实际选择candidate；
- 完整task-context aggregate token至少下降2%，或实际避免1次context-budget failure；
- selected trace的correctness/fallback regression为0；
- 固定reference environment额外p95不超过5 ms；receipt绑定OS、CPU、Node/runtime、build/source hash，逐trace先做至少5次warmup、再做至少30次记录性重复，并报告样本数与聚合方法。

未达到时写`productFit=not_demonstrated`、`promotion=blocked`、`direction=retain|revise`，mechanism仍可verified。

Lossless expansion不证明模型能直接理解folded schema。Promotion前另用同一pinned backend/model/runtime在至少8个trace-backed held-out tasks做completion comparison；这8个task必须与14.3的12个naturalistic product traces在parent run、scenario family和payload上disjoint，role固定为`targeted_model_quality`，且不得用于implementation、selector或schema calibration。冻结顺序固定为：先冻结candidate/selector/model-input format、backend/model/runtime、decoder settings和scorer合同，随后才允许开放或选择targeted payload与独立golden；golden/scorer artifact ref与SHA、case-family hash在首次completion前再次封存。Temperature固定为0；若backend仍非deterministic，则baseline/candidate使用相同seed（若支持）和预注册paired repetition count，至少3对，并逐对报告而不是挑最好一次。Candidate paired full-pass不得低于baseline，critical fact/security/authority regression为0。未运行写对应claim=`not_run`，不能改写mechanism或trace token结论。

### 14.6 CF2 closure与retention

CF2 receipt必须使用父合同的正交轴，并额外保存case provenance counts、exact trace identities、candidate/source commit、selector hash、完整task-context metric与prior evidence ref。不得再输出无范围`outcome=rejected`。

机械验证通过后，tiny CF source、focused tests与runner保留在`labs/frontier-adapter-lab/fal-cf2-context-folding-v2/`，不放入当前会被`tsconfig.build.json`编译的`src/**`；默认disabled，production import/pack graph为0。Trace不足、收益不足或quality未运行都不触发删除。即使mechanism失败，也优先隔离保留最小复现和known-failure test；只有secret/license/hazard、无法限制的依赖或用户明确要求才允许删除唯一源码，并记录原因与可恢复位置。

CF2唯一合法收口是逐轴事实，例如：

```text
implementationFidelity=verified
evidenceValidity=valid
claim(lossless)=supported
claim(trace_token_benefit)=supported|refuted|inconclusive
claim(model_completion)=supported|refuted|not_run
productFit=supported|not_demonstrated|inconclusive
promotion=eligible|blocked|not_assessed
candidateLifecycle=retained_disabled|quarantined|archived_recoverable|removed_legacy_policy|removed_for_hazard
```

### 14.7 2026-08-29 当前执行结果

CF2已经按`reimplementation_from_v1_contract`完成tiny deterministic dictionary fold、exact expander、完整provider-context selector、fault fallback、hash-bound corpus、runner与focused tests。为只修正v1的数据/验证设计并保持因果可比，本revision保留v1的“完整provider context至少下降25%才选择candidate”规则；该阈值只决定fixture中的选择，不再充当mechanism或方向判决。

机器结果为：20/20 mechanical/security cases通过，其中7例经过真实`ArtifactStore -> projectAcceptedChildReceipts()`路径、5例为security cases；candidate实际调用14次、仅在`generated-two-duplicate`与`verified-multi-duplicate`两例被选择；deadline已耗尽的case在调用前回退，其余非选择、disabled与fault路径也回到exact baseline，新增model/tool/network call为0。Runner直接执行`pnpm pack --dry-run --json`并检查全量inventory/packed content与production source markers，随后完整`pack:smoke`也通过；Linux未运行。Candidate identity为`9a4115e2c3382ecfed3b2c6ceeb37b1eadb3c1e3031bceb04a05689f7ec7cdcc`，receipt identity为`dc6593a9d9b87e42a185a16191e6e88de53611ede1b3c20abc3f075117a43188`。

因此当前正交结论是：`implementationFidelity=verified`、`evidenceValidity=limited`、`productFit=inconclusive`、`promotion=blocked`、`direction=retain`、`reproducibility=working_tree_full`、`candidateLifecycle=retained_disabled`。仓库历史中没有满足14.2/14.3的可重放完整parent task-context，naturalistic trace与held-out model-quality task均为0，所以`trace_token_benefit`和`model_completion`均为`not_run`；这不是mechanism失败，也不支持真实产品收益。Trace loader现在会读取两个retained artifacts、核对SHA并验证task context中的receipt集合；当前mechanical-only receipt schema固定拒绝0-trace下的`valid/supported/promoted`状态，未来真实trace evaluation必须升级receipt revision。源码、tests、runner、fixtures、配置与当前production source tree已进入source-state identity，且production build/import/pack inventory为0。当前证据仍在working tree；进入Git前不得称为durably immutable或exact-commit evidence。

CF2 mechanics不能与EM-R1 retrieval Recall直接排名。共同评测以[`FAL Memory Shared Benchmark v1`](frontier-adapter-lab-shared-memory-benchmark-v1.md)为准：同一批24条时间线运行FTS/embedding × baseline/fold四arm，retrieval、fold exactness、fixed-reader grounded success与cost分别判定。Public development/calibration已运行；CF在12/12 timeline都能lossless expansion但均`not_beneficial`、selected为0、shared token reduction为0。这不替代14.3的naturalistic trace要求，candidate仍disabled。
