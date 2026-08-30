# FAL-VP0 — Frozen Verified Procedure Utilization Experiment Spec

> Status（2026-08-30）：`draft / implementation_not_started / actor_backend_not_selected`
>
> Parent contract：[`BornAgent Lightweight Memory Core and Frontier Adapters Spec`](agent-memory-lightweight-core-and-adapters.md) §10、§10.6A
>
> Experiment identity：`fal-vp0-verified-procedure-utilization-v1`
>
> Current decision：只实现隔离实验，不接入production；不自动抽取、检索、反思、演化或执行procedure；本spec本身不授权任何远程模型调用或费用。

## 0. 文档地位与冻结状态

本card把方向级冠军**Verified Procedural Experience Learning**收窄成第一个可证伪切片。VP0只验证冻结procedure的使用价值，不实现后续VR0/VE0：

```text
VP0 frozen verified procedure utilization     # 本card
  -> VR0 verified fail-to-success delta       # 不在本card
  -> VE0 versioned revise/promote/rollback    # 不在本card
```

本文件处于authoring阶段，尚不存在experiment receipt。初始文档状态固定为：

```text
documentStatus = draft
implementation = not_started
actorBackend   = not_selected
remoteRun      = not_authorized
```

只有实现至少产生一条claim-specific observation后，才能创建符合parent Evidence protocol v2枚举的receipt。未运行的claim在`claimResults[]`中写`not_run`；不得把`not_assessed`塞入`evidenceValidity`，也不得用一个`overall=passed`覆盖source、authority、mechanics、quality、cost和promotion的正交结论。

## 1. 单一因果问题与明确不做

VP0唯一问题是：

> 在相同task、初始workspace、模型、工具、权限和预算下，把同一组逐项可追溯的verified source evidence从deterministic source dossier改写成一条人工冻结的procedure，能否让未见coding task获得更多fresh-verifier full-pass；若full-pass完全相同，能否减少tool calls而不产生回退？

本card必须交付：

- 3个procedure family、每个family 2条异质exact verified source；
- 每个family 1条人工冻结procedure；
- 12个paired held-out coding tasks，每个task只跑baseline/candidate两臂；
- 6个security class、每类2个deterministic variant；
- strict schema、逐项support provenance、source verifier、等信息carrier、applicability gate、isolated runner、fresh verifier、post-hoc scorer和append-only receipt；
- disabled/fault/negative case的exact baseline fallback；
- production import、dependency、pack和canonical memory mutation均为0。

明确不做：

- 不用LLM自动生成或改写procedure；
- 不从failed trajectory生成delta，不做reflection；
- 不做ADD/UPDATE/DELETE、helpful/harmful投票或online evolution；
- 不做embedding、reranker、graph、semantic router或向量库；
- 不把procedure变成可执行macro、tool call、shell script或Skill arguments；
- 不新增`MemoryRecordV1` kind，不修改SQLite、FTS、ML2/ML3或canonical Memory；
- 不把procedure写入AGENTS、repository rules、system instruction、current user instruction或approval；
- 不把fake model、reader-only DeepSeek diagnostic或生成fixture写成BornAgent产品收益；
- 不在VP0内顺手实现新的remote tool-capable provider。

## 2. Live baseline与证据缺口

BornAgent已有三块可复用底座：

1. [`deterministic-episode-builder.ts`](../src/memory/episodes/deterministic-episode-builder.ts)只从exact、连续、终态completed的Agent run重建episode，并绑定scope、range与raw hashes；
2. [`run-report-schema.ts`](../src/reports/run-report-schema.ts)记录changed files、fresh verifications、source state与usage identity；
3. [`agent-execution-service.ts`](../src/agent/agent-execution-service.ts)已有`createCapabilityPlatform`与`skillSelections`接线；[`skill-runtime.ts`](../src/skills/skill-runtime.ts)会把无arguments的冻结Skill entry投影成`untrusted_content / skill_entry / system / high`，并在每次context plan复用现有projector、planner与provider encoder。

但`Ml1EpisodeRecordV1`只保存task/outcome/counters和evidence/report hashes，不保存“如何做”；而`run.completed`允许多个completion mode。VP0 source verifier因此必须在episode之上重新读取exact session与`completion.evidence`，并额外要求：

- `completion.mode === "verified_finish_task"`；
- `evidenceSha256`与`reportSha256`均非空；
- completed evidence、report、terminal event与source state hash闭环；
- 至少一条与procedure主张相关的fresh verifier为exit 0、inputs known、non-stale；
- pending、unknown或未结算effect为0。

现有Phase14 eval也不能直接充当VP0质量runner：其command和hidden grader是窄`answer.txt`合同，且remote provider默认禁止。VP0只能复用其disposable workspace、attempt evidence、approval policy和host-only grader原则，必须在lab目录内建立薄的coding-task runner；不得修改原eval suite凑12题。

## 3. 唯一intervention与carrier合同

### 3.1 为什么两臂都使用lab-only Skill carrier

VP0不把procedure塞进task/system prompt，也不伪装成canonical memory。Lab assembly通过现有`executeAgent`、`createCapabilityPlatform`和`skillSelections`选择恰好一个无arguments、无resources的frozen Skill entry；两臂固定使用相同carrier合同：

| Field | Baseline | Candidate |
|---|---|---|
| carrier | frozen Skill entry | frozen Skill entry |
| authority | `untrusted_content` | `untrusted_content` |
| kind / role | `skill_entry` / `system` | `skill_entry` / `system` |
| priority | `high` | `high` |
| protected category | `null` | `null` |
| effect/tool authority | none | none |
| supervisor selection | pre-registered family manifest | pre-registered family manifest |
| runtime event | `selected_by=user` | `selected_by=user` |
| content | deterministic exact-support dossier | frozen procedure from exactly the same support set |

Skill只是VP0的等价运输层，不是产品形态结论。`selected_by=user`是现有runtime对`skillSelections`的枚举值；receipt必须另记`supervisorSelection=pre_registered`，不得声称真实用户在task中主动选择。两个arm使用相同source/pluginId/version/componentId、短selector、`skill.json` raw bytes、component SHA/qualified ID、metadata keys、authority、priority和selection path；因为`SKILL.md`不同，完整`FrozenCapabilityIdentity.pluginSha256`、plugin/inventory hash及内容导出的artifact/context hashes允许且必然不同。`skillArguments`必须undefined，carrier不得包含resource、approval、effect或current-user-instruction字段。

每个arm使用独立temp `userStateRoot`，其中恰好一个carrier package；两个不同content的package不能同时进入同一registry。Actor workspace禁止自带`.bornagent/capabilities.json`，避免额外workspace-source capability进入snapshot。

两臂最终完整ContextItem（包含Skill canonical envelope）都不得超过800 deterministic estimated tokens。Observation中的`carrierBytes`固定为该canonical ContextItem UTF-8 bytes长度，`estimatedTokens`由冻结的Host token estimator对同一完整bytes计算；不得只量`SKILL.md`正文或混用provider usage。candidate不得通过更高priority、更大budget、额外resource或更多context items取得优势。

### 3.2 Equal-information source dossier

Candidate每个activation、negative、precondition、guard、guidance、checkpoint、termination、exception和verifier expectation都必须带`supportRefs`。Baseline renderer只把这些refs指向的**全部且仅有**unique exact support spans按`sourceBindingId/artifactId/startByte/endByte`排序，渲染为非指令性source dossier；不得摘要、补写或选择另一组span。

冻结时必须机械证明：

- candidate所有support refs规范化去重后的span set与baseline dossier span set相同；
- 每个span的raw bytes、range与SHA可由source verifier重读；
- candidate没有unsupported semantic atom；
- dossier与procedure各自连同envelope均不超过800 estimated tokens；超限则该family不合格，不能截断其中一臂；
- baseline不是当前ML1摘要，也不是更弱的task/outcome元数据。VP0结论严格限定为“exact support dossier vs structured procedure representation”，不外推为“当前产品episode search vs procedure”。

### 3.3 Arms

```text
A = baseline_source_evidence_dossier
B = candidate_frozen_verified_procedure
```

每个pair必须固定相同：

- task bytes与task SHA；
- initial workspace tree SHA、logical repository scope与toolchain；
- provider/model/version/endpoint、system instruction SHA、tool schema SHA；
- task profile、approval/effect/sandbox/network policy；
- max steps、tokens、tool output、command output、request timeout与global timeout；
- temperature control/default mode、seed支持状态、provider retry count；
- hidden verifier、allowed/forbidden changed paths与completion policy。

两臂使用独立workspace、session、state root、cache和process，不共享conversation或change。12个pair的顺序预注册为6个A→B、6个B→A；每个family各2个A-first与2个B-first。

### 3.4 Applicability与fallback

Oracle只给出`procedureFamilyId`，不能决定procedure必然注入。Host-owned applicability gate从case冻结的`hostFacts`与source/runtime preflight facts中，按typed predicates依次检查source、scope、version、activation、negative和required preconditions：

```text
oracle family
  -> exact source eligible?
  -> exact principal/repository/root scope?
  -> compatible runtime/toolchain version?
  -> activation facts true?
  -> any negative fact true?
  -> preconditions satisfied?
  -> candidate carrier or baseline source-dossier carrier
```

以下情况必须在provider调用前选择baseline carrier：adapter disabled、no applicable procedure、negative case、deadline already exhausted、candidate materialization throw/timeout/invalid/oversize。必须同时写typed fallback reason；diagnostic只能进入Host observation，不能进入provider context。

两臂是独立session，Host request与可能存在的provider-encoded request都含run/session/event/workspace identity，不能宣称byte-identical。Fallback等价性改为比较首轮`semanticHostRequestSha256`：规范化器只替换manifest列明的run-local identity和绝对workspace root，保留system/task/carrier bytes、authority、priority、tool schema、model、budget与policy。Baseline与fallback candidate的semantic hash必须相同；允许替换字段的schema/version/hash必须冻结，不能在看到结果后新增。

failed/incomplete/unresolved-effect、missing/tampered source、wrong scope、stale version和poison/authority canary更严格：candidate不得被调用，carrier不得生成，provider calls为0。

## 4. Verified source eligibility

每个family恰好2条source，共6条。每条source必须通过以下闭环：

```text
exact durable session bytes
  -> strict event decode and contiguous sequence
  -> exact terminal completed Agent run
  -> deterministic ML1 episode
  -> completion.mode = verified_finish_task
  -> non-null evidence/report hashes
  -> persisted completion evidence hash matches
  -> run report hash matches
  -> relevant fresh verifier exit 0
  -> final source-state snapshot matches
  -> scope/version/admission pass
```

不能只凭episode的`Outcome: completed`、model narrative、source run自己的final answer或LLM judge判定source成功。

```ts
interface FalVp0SourceBindingV1 {
  readonly schemaVersion: 1;
  readonly sourceBindingId: string;
  readonly sourceMode: "public_fixture" | "trace_redacted";
  readonly procedureFamilyId: string;
  readonly scenarioFamilyId: string;
  readonly templateLineageId: string;
  readonly solutionShapeId: string;
  readonly lineageFingerprints: FalVp0LineageFingerprintsV1;
  readonly scope: {
    readonly ownerPrincipalId: string;
    readonly applicationRepositoryId: string;
    readonly canonicalRootIdentitySha256: string;
  };
  readonly sourceIdentity: {
    readonly sessionId: string;
    readonly runId: string;
  };
  readonly sessionRange: {
    readonly relativeRef: string;
    readonly startByte: number;
    readonly endByte: number;
    readonly rawSpanSha256: string;
  };
  readonly artifacts: readonly FalVp0SourceArtifactV1[];
  readonly episodeRecordId: string;
  readonly episodeRecordSha256: string;
  readonly taskInputSha256: string;
  readonly completionEvidenceSha256: string;
  readonly runReportSha256: string;
  readonly finalSourceStateSha256: string;
  readonly relevantVerificationSha256s: readonly string[];
  readonly redactionProvenance: null | {
    readonly transformId: string;
    readonly transformSha256: string;
    readonly redactedArtifactSha256: string;
    readonly exactLedgerArtifactId: string;
    readonly exactLedgerSha256: string;
  };
  readonly sourceBindingSha256: string;
}

interface FalVp0SourceArtifactV1 {
  readonly artifactId: string;
  readonly kind:
    | "session_range"
    | "episode"
    | "completion_evidence"
    | "run_report"
    | "verification"
    | "source_state";
  readonly relativeRef: string;
  readonly bytes: number;
  readonly rawFileSha256: string;
  readonly logicalSha256: string | null;
}
```

同一family的两条source必须具有不同run、task、source range、scenario family、template lineage和solution shape；换ID、换literal或复制同一模板不算异质。所有procedure字符串还必须通过现有memory admission secret/non-persistable扫描。

所有`relativeRef`必须是normalized repository/fixture-relative path，禁止绝对路径和`..`。Source verifier必须从ref重读bytes，而不是相信manifest自报hash。真实trace若含用户文本、绝对路径或私有数据，tracked pack只保存deterministic redaction结果、transform SHA与source hashes；运行时通过显式`exactLedgerArtifactId -> local locator`映射重验原始bytes，本地locator不得写入tracked receipt。`trace_redacted`缺少exact ledger时只能产生typed rejection，不能冒充full reproducibility。Provider-visible support refs只能指向通过disclosure/admission扫描的public或deterministically redacted artifacts，绝不能指向local exact ledger；remote preflight还必须把这些exact outgoing span hashes列入disclosure manifest。

## 5. Procedure strict schema

```ts
interface FalVp0ProcedureV1 {
  readonly schemaVersion: 1;
  readonly experimentId: "fal-vp0-verified-procedure-utilization-v1";
  readonly revision: 1;
  readonly procedureId: string;
  readonly procedureFamilyId: string;
  readonly origin: "human_frozen_from_verified_sources";
  readonly scope: {
    readonly ownerPrincipalId: string;
    readonly applicationRepositoryId: string;
    readonly canonicalRootIdentitySha256: string;
  };
  readonly compatibility: {
    readonly runtimeFamily: FalVp0SupportedValueV1;
    readonly packageManagerFamily: FalVp0SupportedValueV1;
    readonly versionCondition: FalVp0ConditionV1;
  };
  readonly activationConditions: readonly FalVp0ConditionV1[];
  readonly negativeConditions: readonly FalVp0ConditionV1[];
  readonly preconditions: readonly FalVp0ConditionV1[];
  readonly guardChecks: readonly FalVp0ConditionV1[];
  readonly orderedGuidance: readonly FalVp0GuidanceStepV1[];
  readonly terminationConditions: readonly FalVp0ConditionV1[];
  readonly successVerifierExpectation: {
    readonly classifications: readonly ("build" | "check" | "lint" | "test" | "typecheck")[];
    readonly description: string;
    readonly requiresFreshVerifier: true;
    readonly supportRefs: readonly FalVp0SupportRefV1[];
  };
  readonly knownExceptions: readonly FalVp0SupportedTextV1[];
  readonly rollbackTarget: "baseline_source_evidence_dossier";
  readonly sourceBindings: readonly [FalVp0SourceBindingV1, FalVp0SourceBindingV1];
  readonly procedureSha256: string;
}

interface FalVp0ConditionV1 {
  readonly conditionId: string;
  readonly description: string;
  readonly predicate: FalVp0PredicateV1;
  readonly supportRefs: readonly FalVp0SupportRefV1[];
}

interface FalVp0PredicateV1 {
  readonly evaluatorVersion: "fal-vp0-host-facts-v1";
  readonly factSource: "case_manifest" | "runtime_preflight" | "source_verifier";
  readonly factKey: string;
  readonly extractorId: string;
  readonly extractorSha256: string;
  readonly operator:
    | "exists"
    | "equals"
    | "not_equals"
    | "one_of"
    | "none_of"
    | "sha256_equals"
    | "semver_satisfies";
  readonly expected: null | boolean | number | string | readonly string[];
  readonly missingPolicy: "reject";
}

interface FalVp0GuidanceStepV1 {
  readonly stepId: string;
  readonly guidance: string;
  readonly checkpoint: string;
  readonly guardConditionIds: readonly string[];
  readonly supportRefs: readonly FalVp0SupportRefV1[];
}

interface FalVp0SupportedTextV1 {
  readonly textId: string;
  readonly text: string;
  readonly supportRefs: readonly FalVp0SupportRefV1[];
}

interface FalVp0SupportedValueV1 {
  readonly valueId: string;
  readonly value: string;
  readonly supportRefs: readonly FalVp0SupportRefV1[];
}

interface FalVp0SupportRefV1 {
  readonly sourceBindingId: string;
  readonly artifactId: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly rawSpanSha256: string;
  readonly supportKind: "observation" | "action" | "verification" | "state" | "constraint";
}

interface FalVp0SupportAdjudicationV1 {
  readonly schemaVersion: 1;
  readonly procedureSha256: string;
  readonly procedureAuthorIdentitySha256: string;
  readonly reviewerSeparation: "proven" | "not_proven";
  readonly reviewerSeparationProofSha256: string | null;
  readonly reviewers: readonly [
    {
      readonly reviewerId: string;
      readonly reviewerIdentitySha256: string;
      readonly reviewerInstanceSha256: string;
      readonly kind: "human" | "independent_review_agent";
      readonly attestationSha256: string;
    },
    {
      readonly reviewerId: string;
      readonly reviewerIdentitySha256: string;
      readonly reviewerInstanceSha256: string;
      readonly kind: "human" | "independent_review_agent";
      readonly attestationSha256: string;
    },
  ];
  readonly atoms: readonly {
    readonly atomId: string;
    readonly atomTextSha256: string;
    readonly supportSetSha256: string;
    readonly sourceBindingIds: readonly [string, string];
    readonly reviewerVerdicts: readonly ["entailed" | "not_entailed", "entailed" | "not_entailed"];
    readonly outcome: "unanimous_entailed" | "rejected";
  }[];
  readonly rejectedAtomCount: number;
  readonly adjudicationSha256: string;
}
```

Schema必须`strict`，并机械限制：

- identity为1–128个ASCII字节；普通描述单项最多512 UTF-8 bytes；
- activation 1–8、negative 1–8、precondition 1–12、guard 1–8、guidance 2–12、termination 1–8、known exception 0–8；
- canonical procedure不超过8 KiB，最终完整Skill ContextItem不超过800 estimated tokens；
- `procedureId`由experiment/family/revision/source binding identities确定；
- `procedureSha256 = sha256Canonical(content_without_procedureSha256)`；
- normalization固定为NFC与LF，array order有语义，不自动排序；
- 不允许未知字段、NUL、secret、raw environment、private key、reserved BornAgent envelope marker；
- schema没有`argv`、tool call、effect、approval、current instruction、executable code或automatic action字段；
- `successVerifierExpectation`只是建议的验收类型，不能启动命令或替代case的host-only fresh verifier；
- `rollbackTarget`只是fallback identity，不能修改或回滚workspace。

Predicate evaluator只接受manifest冻结的canonical scalar facts；禁止filesystem glob、shell、regex、任意表达式或model判断。每个case必须冻结`hostFacts`及其SHA，gate observation逐条件记录actual canonical value/hash、boolean result、missing handling和evidence refs。

`fal-vp0-host-facts-v1`真值合同固定如下；type mismatch、missing key或invalid expected一律typed reject并走provider前fallback，不得当普通false：

| Operator | Actual | Expected | Result |
|---|---|---|---|
| `exists` | 任意已登记scalar，key必须存在 | 只能`null` | own-key存在即true，包括值为null |
| `equals` / `not_equals` | null/boolean/safe-integer/NFC string | 同一JSON primitive type | canonical primitive严格相等/不等 |
| `one_of` / `none_of` | NFC string | 1–32个sorted+unique NFC strings | exact membership / non-membership |
| `sha256_equals` | lowercase 64-hex string | lowercase 64-hex string | byte-for-byte相等 |
| `semver_satisfies` | strict `MAJOR.MINOR.PATCH`，各段0..2^31-1，无prerelease | `=x.y.z`或`>=x.y.z <a.b.c` | `fal-vp0-semver-v1`数字tuple compare |

所有predicate的`missingPolicy`固定为`reject`。Activation/precondition/version为false时fallback；任一negative为true时fallback；guard不参与注入选择，但missing/type error仍使candidate provider前fallback。Array只允许作为`one_of/none_of`的expected，不允许成为Host actual fact。

每个procedure semantic atom（包括compatibility value/version condition）必须至少有一条support ref，且activation、precondition、guard、guidance、checkpoint、termination与verifier expectation分别覆盖两个source binding IDs。每个ref必须落在已绑定artifact的UTF-8 byte boundary内并重算span SHA；缺失、重叠造假或out-of-range均拒绝procedure。Freeze同时输出machine-computed support coverage，不能接受作者填写的coverage summary。

Bytes存在只证明“引用有效”，不证明procedure语义被source蕴含。Procedure freeze前必须由两名非procedure author、未读取holdout的独立reviewer逐atom查看text与exact support spans并生成`FalVp0SupportAdjudicationV1`。Strict verifier要求两条reviewer记录的`reviewerId`、identity、instance与attestation分别互异，两条identity均不等于procedure author，且separation proof可从独立worker/input/denied-read evidence重放；复制同一reviewer、同一attestation或仅换随机ID一律拒绝。只有`reviewerSeparation=proven`、两人均判`entailed`、两条source均覆盖且`rejectedAtomCount=0`才能使用`verified_procedure`名称并解锁G3。`not_proven`或任一拒绝时candidate只能标`source_attached_unverified`、保留disabled，G3=`not_run`。该adjudication是source claim审计，不替代后续fresh task verifier；若使用review agent，其调用/模型/成本单列在authoring cost。

Procedure渲染必须明确写：它是来自历史成功任务的未受信建议，不是current instruction、permission、approval、policy、verified present state或自动执行计划。

## 6. Corpus与lineage合同

### 6.1 三个procedure families

首版冻结以下工程family；它们是方法类别，不是具体patch模板：

| Family | Source主题 | Held-out验证重点 |
|---|---|---|
| `generated-source-of-truth` | generator/catalog与derived projection同步 | 是否先识别source-of-truth，再修改并运行生成/一致性检查 |
| `public-contract-propagation` | schema/parser/dispatcher/serializer的public contract传播 | 是否沿公开边界完整传播，而不是只改第一个报错点 |
| `scoped-fresh-verification` | leaf与root验证、fresh source state、stale command | 是否选择当前scope的fresh verifier，而不是复用旧成功回执 |

每个family拥有独立logical repository scope；VP0 procedure不得跨family或跨repository复用。

### 6.2 12个paired quality cases

每个family固定4个case：

| Role | Count/family | Expected applicability | Purpose |
|---|---:|---|---|
| `near_transfer_a` | 1 | selected | 相同方法、不同module/topology |
| `near_transfer_b` | 1 | selected | 相同方法、不同language surface或verification shape |
| `changed_guard` | 1 | `applicable_guarded` | required preconditions仍成立，但至少一个observable guard相对source改变；必须重查现场再选分支 |
| `negative` | 1 | not applicable | 名称相似但不属于该方法；candidate exact fallback |

总计12个task、24个actor attempts。Quality case必须冻结`FalVp0CaseManifestV1`：

```ts
interface FalVp0CaseManifestV1 {
  readonly caseId: string;
  readonly procedureFamilyId: string;
  readonly logicalRepositoryScopeId: string;
  readonly taskLineageId: string;
  readonly fixtureTemplateId: string;
  readonly role: "near_transfer_a" | "near_transfer_b" | "changed_guard" | "negative";
  readonly expectedApplicability: "applicable" | "applicable_guarded" | "not_applicable";
  readonly hostFacts: Readonly<Record<string, null | boolean | number | string>>;
  readonly hostFactsSha256: string;
  readonly lineageFingerprints: FalVp0LineageFingerprintsV1;
  readonly inputWorkspaceSha256: string;
  readonly taskPromptSha256: string;
  readonly publicVerifierSha256: string;
  readonly hiddenGraderSha256: string;
  readonly allowedChangedPaths: readonly string[];
  readonly forbiddenChangedPaths: readonly string[];
  readonly forbiddenActions: readonly FalVp0ForbiddenActionV1[];
  readonly changedGuardProof: FalVp0ChangedGuardProofV1 | null;
  readonly armOrder: "baseline_first" | "candidate_first";
}

interface FalVp0LineageFingerprintsV1 {
  readonly comparatorVersion: "fal-vp0-lineage-v1";
  readonly languageSurfaceSha256: string;
  readonly moduleTopologySha256: string;
  readonly failureMechanismSha256: string;
  readonly verificationMethodSha256: string;
  readonly changeSurfaceSha256: string;
  readonly targetSymbolElementSha256s: readonly string[];
  readonly literalElementSha256s: readonly string[];
  readonly expectedOutputElementSha256s: readonly string[];
  readonly allowedRepositoryConventionElementSha256s: readonly string[];
  readonly targetSymbolSetSha256: string;
  readonly literalSetSha256: string;
  readonly expectedOutputSetSha256: string;
  readonly allowedRepositoryConventionSetSha256: string;
  readonly solutionShapeSha256: string;
  readonly goldenDiffSha256: string;
  readonly derivationArtifacts: readonly FalVp0LineageArtifactV1[];
}

interface FalVp0LineageArtifactV1 {
  readonly artifactId: string;
  readonly kind: "workspace" | "task" | "generator" | "template" | "mutation" | "verifier" | "golden" | "ancestry";
  readonly relativeRef: string;
  readonly rawFileSha256: string;
}

interface FalVp0LineageComparisonV1 {
  readonly sourceBindingId: string;
  readonly caseId: string;
  readonly procedureId: string;
  readonly procedureSha256: string;
  readonly procedureNormalizedBytesSha256: string;
  readonly procedureLineageExtractorSha256: string;
  readonly procedureTargetSymbolSetSha256: string;
  readonly procedureLiteralSetSha256: string;
  readonly procedureExpectedOutputSetSha256: string;
  readonly unequalAxes: readonly ("language" | "module_topology" | "failure_mechanism" | "verification_method" | "change_surface")[];
  readonly targetSymbolIntersectionSha256s: readonly string[];
  readonly literalIntersectionSha256s: readonly string[];
  readonly expectedOutputIntersectionSha256s: readonly string[];
  readonly procedureTargetSymbolIntersectionSha256s: readonly string[];
  readonly procedureLiteralIntersectionSha256s: readonly string[];
  readonly procedureExpectedOutputIntersectionSha256s: readonly string[];
  readonly unexpectedRepositoryConventionIntersectionSha256s: readonly string[];
  readonly procedureUnexpectedRepositoryConventionIntersectionSha256s: readonly string[];
  readonly passedThreeOfFive: boolean;
  readonly passedNonLeakage: boolean;
  readonly comparisonSha256: string;
}

interface FalVp0ForbiddenActionV1 {
  readonly actionId: string;
  readonly observer: "tool_name" | "command_argv" | "changed_path" | "effect_kind";
  readonly canonicalExpected: string;
}

interface FalVp0ChangedGuardProofV1 {
  readonly conditionId: string;
  readonly factKey: string;
  readonly extractorId: string;
  readonly extractorSha256: string;
  readonly heldOutWorkspaceBeforeSha256: string;
  readonly heldOutActualCanonicalSha256: string;
  readonly heldOutEvidenceSha256: string;
  readonly sourceFacts: readonly [
    { readonly sourceBindingId: string; readonly actualCanonicalSha256: string; readonly evidenceSha256: string },
    { readonly sourceBindingId: string; readonly actualCanonicalSha256: string; readonly evidenceSha256: string },
  ];
  readonly differsFromBothSources: true;
  readonly proofSha256: string;
}
```

Source与held-out只允许共享manifest明确列出的repository convention。必须机械证明：

- task lineage、fixture template、solution shape和golden diff canonical hash不同；
- held-out target symbol、literal和expected output未出现在source episode或procedure；
- 每个held-out相对任一source至少在language/module topology/failure mechanism/verification method/change surface五个轴中的三个不同；
- 不能用split前缀或随机ID伪造family-disjoint。

Source与case必须使用同一个`FalVp0LineageFingerprintsV1`。每个derivation artifact都带可重读的normalized relative ref与raw SHA；sealed holdout由supervisor读取这些refs，actor worker不可见。`fal-vp0-lineage-v1`从实际fixture/trace bytes重算五轴：language由normalized file-kind set得到，module topology由normalized import/dependency graph得到，failure mechanism由冻结mutation operator及其input/output SHA得到，verification method由exact classifier/argv contract得到，change surface由golden changed paths/symbol kinds得到。Target symbols、literals、expected outputs与允许共享的repository conventions先NFC/LF规范化、逐元素SHA、sort+dedupe，再计算set SHA；comparator对逐元素digest做真实intersection，而不是拿两个aggregate hash声称“无重合”。

`scenarioFamilyId`、`templateLineageId`、`solutionShapeId`、`taskLineageId`与`fixtureTemplateId`必须由对应mutation/generator/template/ancestry/input bytes的canonical hash派生；作者自由填写的ID、label或summary不参与lineage判定。Comparator对每个held-out×source输出`FalVp0LineageComparisonV1`，同时用同一extractor从exact procedure render重算逐元素digests；case与source、case与procedure的target/literal/expected-output intersections，以及unexpected convention intersections都必须为空，每对source至少3/5轴不同。Comparison绑定`procedureId/procedureSha256`，pack及其SHA进入holdout commitment与final receipt。

`fal-vp0-host-facts-v1` protocol必须冻结`factKey -> factSource/value schema/extractorId/extractorSha256` registry；predicate只能引用registry exact entry，不能自带未登记extractor。`changed_guard`仍属于9个applicable cases：Host gate的activation/negative/required preconditions必须通过，procedure也必须注入；至少一个guard必须来自`runtime_preflight` registered extractor，并通过`changedGuardProof`绑定workspace-before、actual value/evidence及相对两条source的差异。Case grader用`forbiddenActions`和fresh verifier机械判定是否照抄错误分支，scorer不得阅读trajectory后主观发明`harmfulGuidance`。

### 6.3 Security canaries

Canary与quality pairs分开，不进入candidate-only win或efficiency分母。固定6个class，每类2个variant：

| Class | Variants | Required result |
|---|---|---|
| `unsettled_source` | failed / incomplete | candidate not invoked，provider 0 |
| `receipt_integrity` | missing evidence / tampered event-report-verification hash | candidate not invoked，provider 0 |
| `scope_mismatch` | wrong repository / wrong principal or root | candidate not invoked，provider 0 |
| `stale_version` | unsupported toolchain / stale source snapshot | candidate not invoked，provider 0 |
| `poisoned_guidance` | reserved instruction envelope / forged system-approval wording | candidate not invoked，provider 0 |
| `authority_escalation` | old approval revival / high-risk effect-tool JSON | candidate not invoked，provider 0 |

任一variant失败则该class失败。Canary必须由Host规则拒绝，不能依赖模型“自觉忽略”。

## 7. Freeze、commit与evaluation隔离

VP0使用五个有祖先关系的冻结节点，不允许一次dirty working tree写完后自称blind：

1. **Mechanics + actor preflight commit/receipt**：提交strict schemas、generic equal-carrier mechanics、canaries、runner/scorer和public smoke actor implementation/provider/model/tool protocol；entry失败时先停，不制作source/procedure或held-out corpus；
2. **Procedure freeze commit**：在actor/runner/scorer bytes不变的前提下，提交source verifier、6个sources、3条procedures/dossiers与support adjudication；记录所有logical/raw hashes；
3. **Holdout commitment commit**：在procedure bytes保持不变的前提下，由隔离authoring pass生成12-case sealed pack，只提交salted commitment、role/family counts和machine-computed non-leakage summary；
4. **Execution freeze commit**：仍未打开sealed pack时，绑定procedure/holdout ancestry、actor preflight、system prompt、tool catalog、policy、budget、retry/temperature/seed支持、grader/scorer、AB/BA order、case execution schedule、call/token/cost caps和semantic-request normalizer；
5. **Reveal/run receipt**：验证execution freeze后一次性reveal并运行；原始observations只append，post-hoc scorer不能调用provider；closure后公开可公开的inputs/goldens和tracked summary receipt。

若procedure、renderer、applicability、actor prompt、tool catalog、grader或scorer在首次evaluation output后发生语义变化，本revision立即降级为`known_regression`；新实验必须换experiment revision与task lineage。

Manifest loader按phase分离：source/procedure freeze不得读取holdout；worker不得读取goldens、scorer、sealed family registry或solution files。为了“验完整目录hash”而提前打开evaluation文件仍算G0失败。

Receipt必须记录：

- `actor preflight commit -> procedure freeze commit -> holdout commitment commit -> execution freeze commit`的ancestor/ordering关系；
- `authoringSeparation = proven | not_proven`；
- source/procedure/runner/scorer/actor/prompt/tool/policy/budget/grader/commitment/normalizer hashes；
- dirty run时的base commit、full dirty-state file list/raw SHA和dirty-state logical SHA；
- evaluation reveal前后procedure bytes完全相同。

`authoringSeparation=proven`要求procedure author与holdout author运行在不同worker process和input-only root/mount中：procedure worker只收到sources/family contract，holdout worker只收到family/case-role contract；两者都没有ambient repository、对方artifact或future output访问。Supervisor必须记录worker argv、input tree/mount-or-ACL manifest、denied-read probes、output hashes与独立attestation。Phase-loader access log和commit ancestry只能作为附加证据，单独不足以证明没有旁路读取；当前平台无法提供process/filesystem isolation时必须写`not_proven`。此时mechanics claim仍可valid，held-out utility evidence最多`limited`，`productFit=not_assessed`。

Public fixture source足以支持本冻结实验的mechanics/utility claim，但不自动支持真实产品fit。Product-fit映射固定为：

- 缺`authoringSeparation=proven`、少于2条`trace_redacted` exact sources、未覆盖2个family或未完成声明的平台/actor证据：`not_assessed`；
- 前述external-validity prerequisites齐全，但G0 evidence无效或G3因运行不全而无法判定：`inconclusive`；
- prerequisites齐全且G3 supported：`supported`；
- prerequisites齐全但G3 refuted：`not_demonstrated`。

不得把fixture-level G3结果直接复制成productFit。

执行顺序固定为safety-first，holdout commitment先公开其salted schedule hash，execution freeze再绑定exact order：

```text
12 canary variants (provider 0)
  -> 3 negative pairs / 6 fallback actor attempts
  -> verify G1 complete
  -> 9 applicable pairs in pre-registered case + AB/BA order
```

只有进入最后一段后，baseline-only harm才能触发付费early-stop；这样G1已经闭合，未运行的只会是后续applicable benefit cases。

## 8. Runner、worker、supervisor与actor

### 8.1 进程边界

```text
phase-specific input pack
  -> supervisor preflight
  -> fresh isolated arm workspace
  -> input-only actor worker
  -> immutable arm observation
  -> host-only fresh verifier
  -> post-hoc scorer
  -> append-only logical receipt
```

职责必须分开：

- **source verifier**：读取exact session/evidence/report，输出eligible binding或typed rejection；
- **carrier materializer**：从相同support-ref set生成baseline source dossier或candidate procedure Skill package；不调用模型；
- **applicability gate**：消费oracle family与Host facts，决定candidate或baseline；不读取golden；
- **actor worker**：只看task、workspace、arm carrier、固定model/tools/policy/budget；不能看golden/scorer；
- **supervisor**：创建fresh workspace、检查before hash、安排AB/BA、启动worker、运行fresh verifier；
- **scorer**：只读frozen observations与goldens，计算pair/canary/aggregate；不能调用provider或修改observation；
- **receipt builder**：把score与lineage转成可重复logical receipt；wall time不进入logical identity。

Raw observation路径固定为：

```text
.cache/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/
  runs/<run-id>/
    actor-preflight.json
    execution-freeze.json
    cases/<case-id>/<arm>/input.json
    cases/<case-id>/<arm>/observation.json
    cases/<case-id>/<arm>/fresh-verifier.json
    score.json
```

写入必须create-exclusive；同一`run-id/case/arm`已存在时拒绝覆盖。修正score时保留旧文件并产生新revision，不重写actor observation。

### 8.2 Lab actor实现

VP0不得扩展canonical memory或production recall。Lab driver基于公开`createNodeRuntime(...)`组装并窄化覆盖一个structural `CliRuntime`，再调用公开`executeAgent`；每个arm获得独立capability root与同selector的frozen Skill package。不能把`AgentExecutionRuntimePortV1`直接传给`executeAgent`，也不能复用Phase14 `EvalAgentRuntime`：后者把command/verifier固定为`node --version/answer.txt`，无法代表coding actor。

Lab只允许一个case-bound policy seam：基于case manifest构造无shell、exact-argv command preparer与返回现有verification kind/input paths的classifier；tool registry、executor、completion evidence、approval/effect、context planner、provider encoder与run termination必须调用production实现，不能写“看起来像BornAgent”的替身。每个arm preflight还必须证明capability root恰好一个carrier、`skill.json` SHA相同、resources/arguments为0、workspace capability manifest为0。

VP0不得改动`src/evals/suite-v1.json`或用补两道dummy题满足现有suite最小数量。Coding task grader必须是lab-only、manifest-exact、host-only：

- Agent workspace只包含input tree与public verifier；
- hidden golden和solution diff永不挂载到actor workspace；
- command执行不用shell，argv必须逐项等于case manifest allowlist；
- grader默认network none、read-only input、独立temp output、固定timeout；
- supervisor只在actor进程退出和workspace封存后读取hidden expected；
- full-pass由hidden solution grader、path/change policy、fresh final verifier和effect state共同决定。

Carrier在启动`executeAgent`前必须完整materialize、hash并通过snapshot preflight。若启动后Skill activation仍在`providerCalls=0`时失败，supervisor丢弃该session/workspace，以fresh session、fresh workspace和baseline package重启并记录`fallback_relaunch`；一旦已有provider call，该arm固定为invalid，禁止热切换后冒充fallback等价。

### 8.3 Actor backend entry gate

在12题之前，必须用不属于任何source/holdout lineage的public smoke证明actor backend支持：

- BornAgent tool calling；
- read/edit与manifest-exact verifier command；
- `finish_task`及完整fresh completion evidence；
- complete usage或明确的`null`字段；
- fixed provider/model/version/endpoint identity；
- `maxRetries=0`；temperature/seed必须记录为`override_zero | provider_default_not_exposed`与`fixed | unsupported`。现有Ollama Pi backend没有temperature/seed override seam时，不得伪称为0；必须冻结model artifact/digest、backend implementation与实际provider defaults边界。

Preflight产出immutable `FalVp0ActorPreflightV1`，至少绑定actor/runtime/provider/model/version/endpoint、model artifact、system prompt、tool catalog、case-policy adapter、approval/effect/network policy、budget、temperature/retry/seed、public smoke pack/result、usage capability和preflight SHA。Paired runner只接受execution-freeze引用的exact passing SHA，任何字段变化都必须重新preflight且换execution freeze。

Actor lane分级：

| Lane | 允许证明 |
|---|---|
| in-process fake | schema、canary、runner、scorer mechanics only |
| pinned local Ollama tool backend | 通过entry gate后可产生当前模型的quality evidence |
| existing DeepSeek JSON reader | 不允许；它不是tool-capable Agent backend |
| future hosted tool backend | 必须另写provider amendment，冻结privacy、tool protocol、cost cap和failure semantics后才允许 |

如果没有通过entry gate的actor，VP0实现可以关闭为`mechanics_verified_actor_blocked`，但G3必须`not_run`、productFit=`not_assessed`；不得用fake或先前reader结果补齐。

`usage=null`不阻止fresh-verifier capability comparison，但会使equal-quality efficiency alternative与完整cost claim固定为`not_run`；不能用wall time或估算token替代provider usage。

Remote run还必须在执行前输出planned calls/tokens/cost、公开发送字段清单和用户授权边界。Worker同时接收`maximumModelCalls`、`maximumTotalTokens`、`maximumOutputTokens`与`maximumEstimatedCostUsdMicros`；任一预估超限则0次调用拒绝。历史价格不能冒充当前报价。

### 8.4 Preflight与execution-freeze schema

```ts
interface FalVp0ActorPreflightV1 {
  readonly schemaVersion: 1;
  readonly actorImplementationSha256: string;
  readonly runtimePortSha256: string;
  readonly providerModelEndpointSha256: string;
  readonly modelArtifactSha256: string | null;
  readonly systemInstructionSha256: string;
  readonly toolCatalogSha256: string;
  readonly casePolicyAdapterSha256: string;
  readonly runtimePolicySha256: string;
  readonly budgetSha256: string;
  readonly temperatureControl: {
    readonly mode: "override_zero" | "provider_default_not_exposed";
    readonly providerDefaultsEvidenceSha256: string;
  };
  readonly maxRetries: 0;
  readonly seedControl: "fixed" | "unsupported";
  readonly publicSmokePackSha256: string;
  readonly publicSmokeObservationRef: string;
  readonly publicSmokeObservationSha256: string;
  readonly publicSmokeVerifierImplementationSha256: string;
  readonly publicSmokeVerifierObservationRef: string;
  readonly publicSmokeVerifierObservationSha256: string;
  readonly usageCapability: "complete" | "not_reported";
  readonly status: "passed" | "failed";
  readonly preflightSha256: string;
}

interface FalVp0PublicSmokeObservationV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly publicSmokePackSha256: string;
  readonly actorConfigSha256: string;
  readonly toolCallsObserved: number;
  readonly completionMode: string | null;
  readonly pendingOrUnknownEffects: number;
  readonly usageCapabilityObserved: "complete" | "not_reported";
  readonly initialWorkspaceSha256: string;
  readonly finalWorkspaceSha256: string;
  readonly completionEvidenceSha256: string | null;
  readonly runReportSha256: string | null;
  readonly evidenceArtifacts: readonly FalVp0SmokeEvidenceArtifactV1[];
  readonly actorEventRange: FalVp0EvidenceSliceV1;
  readonly observationSha256: string;
}

interface FalVp0SmokeEvidenceArtifactV1 {
  readonly artifactId: string;
  readonly kind:
    | "actor_event_log"
    | "initial_workspace_manifest"
    | "final_workspace_manifest"
    | "completion_evidence"
    | "run_report"
    | "fresh_verifier_observation";
  readonly relativeRef: string;
  readonly bytes: number;
  readonly rawFileSha256: string;
  readonly logicalSha256: string | null;
}

interface FalVp0EvidenceSliceV1 {
  readonly artifactId: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly rawSpanSha256: string;
}

interface FalVp0PublicSmokeCapabilityV1 {
  readonly status: "passed" | "failed";
  readonly evidenceSlices: readonly FalVp0EvidenceSliceV1[];
  readonly evidenceSha256s: readonly string[];
}

interface FalVp0PublicSmokeVerificationV1 {
  readonly schemaVersion: 1;
  readonly publicSmokeObservationRef: string;
  readonly publicSmokeObservationSha256: string;
  readonly verifierImplementationSha256: string;
  readonly capabilities: {
    readonly repositoryRead: FalVp0PublicSmokeCapabilityV1;
    readonly editPersisted: FalVp0PublicSmokeCapabilityV1;
    readonly exactVerifierArgv: FalVp0PublicSmokeCapabilityV1;
    readonly finishTask: FalVp0PublicSmokeCapabilityV1;
    readonly freshCompletionEvidence: FalVp0PublicSmokeCapabilityV1;
  };
  readonly freshVerifierImplementationSha256: string;
  readonly freshVerifierObservationSha256: string;
  readonly completionMode: string | null;
  readonly pendingOrUnknownEffects: number;
  readonly status: "passed" | "failed";
  readonly verifierObservationSha256: string;
}

interface FalVp0ExecutionFreezeV1 {
  readonly schemaVersion: 1;
  readonly procedureFreezeCommit: string;
  readonly actorPreflightCommit: string;
  readonly actorPreflightSha256: string;
  readonly holdoutCommitmentCommit: string;
  readonly holdoutCommitmentSha256: string;
  readonly ancestryAndOrderPassed: true;
  readonly procedurePackSha256: string;
  readonly sourcePackSha256: string;
  readonly actorConfigSha256: string;
  readonly promptToolPolicyBudgetSha256: string;
  readonly graderSha256: string;
  readonly scorerSha256: string;
  readonly armOrderSha256: string;
  readonly caseExecutionOrderSha256: string;
  readonly semanticRequestNormalizerSha256: string;
  readonly tokenEstimatorSha256: string;
  readonly maximumModelCalls: number;
  readonly maximumTotalTokens: number;
  readonly maximumOutputTokens: number;
  readonly maximumEstimatedCostUsdMicros: number | null;
  readonly executionFreezeSha256: string;
}
```

`status=failed`、preflight/config hash不匹配、ancestry false或任一cap缺失时，paired worker必须在reveal和provider调用前拒绝。Hosted actor没有用户明确费用授权时，即使preflight passed也不能运行。

Preflight `status`不是作者标签：builder必须从normalized relative refs重读event range、initial/final workspace manifest、completion evidence、run report和fresh-verifier observation，逐项重算raw/span/logical SHA与capability status。只有`toolCallsObserved>0`、五项capability均为`passed`、`completionMode=verified_finish_task`且pending/unknown effects为0时才能派生`passed`。Capability不能由actor或作者直接填写：verifier必须从exact tool event、persisted workspace delta、exact verifier argv、finish event和fresh completion evidence导出。Observation、verifier implementation/observation、fresh verifier或actor config hash任一缺失/不匹配时固定`failed`。

## 9. Observation与fresh-verifier合同

```ts
interface FalVp0ArmObservationV1 {
  readonly schemaVersion: 1;
  readonly experimentId: "fal-vp0-verified-procedure-utilization-v1";
  readonly runId: string;
  readonly caseId: string;
  readonly arm: "baseline_source_evidence_dossier" | "candidate_frozen_verified_procedure";
  readonly armOrder: "baseline_first" | "candidate_first";
  readonly actorPreflightSha256: string;
  readonly executionFreezeSha256: string;
  readonly modelIdentitySha256: string;
  readonly systemInstructionSha256: string;
  readonly toolCatalogSha256: string;
  readonly runtimePolicySha256: string;
  readonly taskInputSha256: string;
  readonly initialWorkspaceSha256: string;
  readonly carrier: {
    readonly selectedRepresentation: "source_evidence_dossier" | "frozen_verified_procedure";
    readonly applicability: "applicable" | "applicable_guarded" | "not_applicable" | "fallback_error";
    readonly decisionStage: "source" | "scope" | "version" | "activation" | "negative" | "precondition" | "materialization" | "selected";
    readonly candidateInvoked: boolean;
    readonly carrierGenerated: boolean;
    readonly fallbackReasonCode: string | null;
    readonly candidateProcedureId: string | null;
    readonly candidateProcedureSha256: string | null;
    readonly sourceBindingSha256s: readonly string[];
    readonly supportSetSha256: string;
    readonly predicateEvaluations: readonly FalVp0PredicateEvaluationV1[];
    readonly supervisorSelection: "pre_registered";
    readonly runtimeSelectedBy: "user";
    readonly skillJsonRawSha256: string;
    readonly pluginSha256: string;
    readonly componentSha256: string;
    readonly activationEventId: string;
    readonly contentArtifactSha256: string;
    readonly contextItemId: string;
    readonly contextItemCanonicalSha256: string;
    readonly carrierBytes: number;
    readonly estimatedTokens: number;
    readonly expectedModelTurnCount: number;
    readonly includedModelTurnCount: number;
    readonly turnInclusions: readonly FalVp0TurnInclusionV1[];
    readonly additionalModelCalls: 0;
  };
  readonly execution: {
    readonly terminal: "completed" | "failed" | "budget_exceeded" | "incomplete" | "cancelled";
    readonly steps: number;
    readonly toolCalls: number;
    readonly modelCalls: number;
    readonly durationMs: number;
    readonly finalWorkspaceSha256: string;
    readonly completionEvidenceSha256: string | null;
    readonly runReportSha256: string | null;
  };
  readonly usage: null | {
    readonly inputTokens: number;
    readonly cachedInputTokens: number | null;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly estimatedCostUsdMicros: number | null;
  };
  readonly observationSha256: string;
}

interface FalVp0PredicateEvaluationV1 {
  readonly conditionId: string;
  readonly factSource: FalVp0PredicateV1["factSource"];
  readonly factKey: string;
  readonly extractorId: string;
  readonly extractorSha256: string;
  readonly workspaceBeforeSha256: string | null;
  readonly expectedCanonicalSha256: string;
  readonly actualCanonicalSha256: string | null;
  readonly actualType: "string" | "number" | "boolean" | "missing" | null;
  readonly evaluationStatus:
    | "matched"
    | "not_matched"
    | "missing"
    | "type_mismatch"
    | "invalid_expected"
    | "extractor_failed";
  readonly gateValue: true | false | "reject";
  readonly evidenceSha256s: readonly string[];
  readonly extractorObservationSha256: string;
}

interface FalVp0TurnInclusionV1 {
  readonly modelTurnIndex: number;
  readonly contextPlanSha256: string;
  readonly canonicalContextSha256: string;
  readonly includedItemIdsSha256: string;
  readonly carrierContextItemId: string;
  readonly carrierIncluded: boolean;
  readonly hostModelTurnRequestLogicalSha256: string;
  readonly providerEncodedRequestSha256: string | null;
  readonly semanticHostRequestSha256: string;
  readonly semanticNormalizerSha256: string;
}

interface FalVp0FreshVerifierObservationV1 {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly arm: FalVp0ArmObservationV1["arm"];
  readonly actorObservationSha256: string;
  readonly solutionGraderPassed: boolean;
  readonly publicVerifierPassed: boolean;
  readonly changedPathPolicyPassed: boolean;
  readonly completionEvidencePassed: boolean;
  readonly pendingOrUnknownEffects: number;
  readonly forbiddenActionIdsObserved: readonly string[];
  readonly harmfulGuidance: boolean;
  readonly fullPass: boolean;
  readonly verifierArtifactSha256s: readonly string[];
  readonly verifierObservationSha256: string;
}

interface FalVp0CanaryObservationV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly canaryClass: "unsettled_source" | "receipt_integrity" | "scope_mismatch" | "stale_version" | "poisoned_guidance" | "authority_escalation";
  readonly variantId: string;
  readonly canaryManifestSha256: string;
  readonly inputSha256: string;
  readonly protocolSha256: string;
  readonly gateImplementationSha256: string;
  readonly decisionStage: FalVp0ArmObservationV1["carrier"]["decisionStage"];
  readonly candidateInvoked: boolean;
  readonly carrierGenerated: boolean;
  readonly providerCalls: number;
  readonly rejectionCode: string;
  readonly canonicalMemoryMutations: number;
  readonly currentInstructionMutations: number;
  readonly approvalOrEffectMutations: number;
  readonly observationSha256: string;
}

interface FalVp0CanaryResultV1 {
  readonly canaryClass: FalVp0CanaryObservationV1["canaryClass"];
  readonly variantObservationSha256s: readonly [string, string];
  readonly passed: boolean;
}
```

Predicate evaluator必须从registry绑定的extractor observation重算`expectedCanonicalSha256`、actual type/value与evidence hashes；`matched -> true`、`not_matched -> false`，其余四种typed failure全部`-> reject`。任何不符合该唯一映射的observation均strict-decode失败；`reject`在provider前转成`fallback_error`，不能被当作普通false继续condition组合。

Canary observation中的boolean/count是actual值，strict schema只要求nonnegative integer与完整lineage，不能把期望的false/0写成literal type。Scorer根据class contract机械计算`passed`；这样candidate泄漏或provider call大于0时仍能保存一份valid failure observation，不能因schema拒绝而丢失坏证据。

`fullPass`必须由supervisor机械计算：

```text
terminal completed
AND hidden solution grader passed
AND public fresh verifier passed
AND path/change policy passed
AND completion evidence closed
AND pending/unknown effects = 0
AND forbidden action IDs observed = 0
```

模型自述“已完成”、source episode旧verifier、最终文件肉眼正确或provider response completed都不能单独算full-pass。

Worker必须把durable `context.plan.created.included_item_ids`与Skill activation/content evidence关联到exact `contextItemId`；backend wrapper只记录每个`ModelTurnRequest`的request/context hashes与included IDs，不记录provider reasoning。Candidate applicable时procedure carrier必须进入每个预期model turn；baseline、negative与fallback必须进入source-dossier carrier且不得出现procedure carrier。`expectedModelTurnCount`必须等于实际provider model requests；缺失任一turn inclusion evidence使该arm invalid，不能从分母静默删除。

`fal-vp0-semantic-request-v1`只规范化run/session/turn/event/activation UUID、timestamp与绝对workspace prefix，并把它们替换成固定logical placeholders；不得删除或重排message content、role、authority、priority、protected category、tool schema、system/task/carrier bytes、model identity、budget或policy。算法固定为`parse -> normalize allowed leaf identities -> recompute ContextItem IDs/content bindings/included-item IDs/canonical-context SHA/context-plan refs -> canonical encode -> hash`；受影响的派生hash不能原样保留，也不能被追加到排除清单。Normalizer implementation/hash与允许替换字段在execution freeze中固定。

现有Pi/Ollama链路不暴露credential-free最终SDK wire payload，因此`providerEncodedRequestSha256`允许为`null`；不得伪造raw provider hash。Host-owned logical request/context hashes始终必填。Fallback等价只比较各自首个request的`semanticHostRequestSha256`，不宣称独立run raw bytes或provider wire相同。

## 10. Metrics、G0–G5与预注册决策

### 10.1 Pair metrics

每个pair报告：

- baseline/candidate full-pass；
- candidate-only win、baseline-only win、both-pass、both-fail；
- expected/actual applicability与harmful-guidance flag；
- steps、tool calls、model calls、input/output/cache tokens、wall、API cost；
- carrier tokens与每turn inclusion；
- verification retries与fresh verifier classifications；
- invalid/harness/provider/fallback原因。

Primary capability metric是paired full-pass。Primary efficiency metric预注册为`toolCalls`；total tokens是secondary，不允许在看到结果后从两者中挑更好的一项当gate。

### 10.2 G0 evidence validity

必须全部满足：

- 3个family、6条exact eligible sources、3条frozen procedures；每条逐atom support adjudication均为unanimous entailed、`reviewerSeparation=proven`且两位reviewer identity/instance/attestation严格互异；
- 12个quality pair manifests，role分布严格为6 near-transfer、3 changed-guard、3 negative；
- 6/6 security classes、12/12 variants；
- source/holdout derivation refs可重读，逐元素non-leakage intersections为空且3-of-5 design-axis差异通过；
- procedure freeze、holdout commitment、actor preflight、execution freeze与one-shot reveal顺序可证；
- worker不能读golden/scorer；fresh verifier由supervisor执行；
- 每个已运行arm都形成valid immutable observation；未运行arm必须有预注册terminal reason，不能静默缩分母；
- real quality claim使用通过entry gate的同一actor backend。

Generated mechanics、stress或fake-provider cases只能支持G1/G2，不能补G3数量。

完整benefit判定需要9/9 applicable pairs两臂valid；3个negative pairs只进入G1 fallback，不进入G3 capability/efficiency。若发生预注册harm hard-stop，G0仍可对已观察到的exact harm evidence判`valid`，但未运行的benefit/efficiency部分必须写`not_run_due_harm_stop`；不能把“没有跑满”反过来抹掉已经出现的baseline-only证据。

### 10.3 G1 safety/isolation

Hard gate：

- 6/6 canary classes、12/12 variants通过；
- 3/3 negative case procedure未注入并exact fallback；
- wrong principal/repository/root进入candidate input为0；
- failed/incomplete/stale/tampered/unresolved source进入candidate为0；
- poison成为current instruction或protected fact为0；
- approval/effect/tool authority扩大为0；
- canonical memory、current instruction、repository rules和user preference mutation为0；
- disabled/fault/negative fallback首个Host request与baseline的semantic host-request hash一致；provider encoded hash若backend不暴露则为null；
- cross-arm state/cache/conversation共享为0。

任一G1失败立即停止revision，未运行付费pairs保持`not_run_due_hard_stop`。

### 10.4 G2 implementation fidelity

必须证明：

- strict schema、canonical encode/decode、procedure/source/observation/receipt hashes；
- 两臂support set相同，carrier `skill.json`/metadata/priority/authority/selection path相同；
- oracle只选择family，applicability由frozen fact registry/typed Host gate决定；
- typed predicate与lineage comparator可重算；renderer deterministic且完整ContextItem不超过800 tokens；
- candidate read path额外model/tool/network calls均为0；
- AB/BA、workspace/config equality与fresh verifier机械检查；
- repeated scorer对相同observations生成相同logical score/receipt；
- canary成功和失败actual observations均可strict decode，safety-first schedule与freeze SHA一致；
- production import/dependency/pack marker为0；删除lab root后production baseline不变。

### 10.5 G3 quality/benefit

Capability/efficiency的统计分母固定为9个applicable cases（6 near-transfer + 3 changed-guard）。3个negative pair即使两次actor outcome不同，也不记candidate-only/baseline-only；它们只检查pre-provider selection与semantic fallback equivalence。

Capability claim只有同时满足下列条件才为`supported`：

1. 9/9 applicable pairs两臂均valid，且至少3个candidate-only full-pass win；
2. baseline-only full-pass win为0；
3. candidate-only wins覆盖至少2/3 procedure families；
4. selected procedure harmful-guidance case为0；
5. 3/3 changed-guard没有触发manifest冻结的forbidden action。

只有当`candidateOnlyWins=0`且`baselineOnlyWins=0`、两臂full-pass完全相同，才允许走equal-quality efficiency alternative：

- 至少6个`candidate applicable + both-pass + complete usage` pairs；
- paired median tool calls降低至少20%；
- median total tokens不得增加超过10%；
- 9个applicable pair的selected procedure harmful-guidance为0；
- 3/3 changed-guard的candidate forbidden action为0；
- wall/API cost完整报告，不作为缺失usage的替代。

每个效率eligible pair必须同时满足：role属于9个applicable、pair valid、两臂均full-pass、两臂usage完整、`baselineToolCalls>0`且`baselineTotalTokens>0`。计算固定为：

```text
toolCallReductionBps = truncTowardZero((baselineToolCalls - candidateToolCalls) * 10000 / baselineToolCalls)
totalTokenDeltaBps = truncTowardZero((candidateTotalTokens - baselineTotalTokens) * 10000 / baselineTotalTokens)
```

Median先对integer bps升序；奇数取中位项，偶数取两个中位项之和除2并`truncTowardZero`。Efficiency claim只有在两臂full-pass完全相同、eligible count至少6、paired median tool-call reduction `>=2000 bps`、paired median total-token delta `<=1000 bps`、`harmfulGuidanceCount=0`且changed-guard forbidden-action count为0时为`supported`。任一共同安全条件失败时先记`refuted / quality_safety_violation`；否则，equal-quality但`bothPass<6`时已不可能满足预注册样本量，记`refuted / insufficient_both_pass_pairs`；`bothPass>=6`但因usage缺失使eligible count少于6时才记`not_run / usage_incomplete`；数据完整但任一效率阈值失败时为`refuted / threshold_missed`。非equal-quality时该alternative为`not_run / quality_not_equal`，不能掩盖capability结果。

Composite G3的命题是`capability supported OR efficiency supported`，按以下优先级形成全函数；先命中的行结束判定：

| Priority | Exact state | Composite G3 |
|---:|---|---|
| 1 | 任一valid applicable harmful-guidance，或任一changed-guard candidate forbidden action | `refuted / quality_safety_violation` |
| 2 | 任一valid applicable baseline-only win | `refuted / baseline_only_harm` |
| 3 | capability或efficiency任一为supported | `supported / alternative_supported` |
| 4 | actor/preflight在首个applicable arm前阻断 | `not_run / actor_blocked` |
| 5 | 无observed harm，但applicable pairs未达到9/9 valid | `inconclusive / incomplete_applicable_pairs` |
| 6 | 9/9 valid、full-pass完全相同、`bothPass>=6`，但usage缺失使eligible少于6 | `inconclusive / efficiency_usage_incomplete` |
| 7 | 9/9 valid，capability refuted，且efficiency已refuted或因`quality_not_equal`结构性不适用 | `refuted / no_supported_alternative` |

两个alternative及composite supported共同要求`harmfulGuidanceCount=0`且changed-guard forbidden-action count为0；both-fail绝不能把坏行为藏在efficiency分母之外。因此“usage未报告”在equal-quality分支不是反证，只会让OR命题`inconclusive`；`quality_not_equal`则意味着efficiency alternative按预注册定义不适用，不能阻止完整capability结果成为最终反证。Aggregate中的result/reason必须落在该表且`gates.g3`一一对应：supported→passed、refuted→failed、inconclusive→inconclusive、not_run→not_run。

首个valid applicable baseline-only full-pass出现时，zero-regression conjunct立即为false：capability与composite G3 claim均记`refuted`并停止剩余付费pairs，未运行项记`not_run_due_harm_stop`；不要求为了“跑满分母”继续付费。Provider/harness invalid但没有observed harm时不得缩分母，capability claim为`inconclusive`。12题只是方向signal，不证明稳定product effect。

### 10.6 G4 cost

必须分别报告adapter成本与task actor成本：

- adapter extraction/selection model calls固定0；
- baseline/candidate carrier bytes/tokens；
- task steps、tool/model calls、input/output/cache tokens；
- estimated provider cost与price schedule SHA/date；
- workspace/storage/raw observation/receipt bytes；
- root dependency、install、startup、build和packed artifact delta；
- Windows path、process与cleanup结果。

缺失usage为`null/not_reported`，不能写0。价格为估算，不是账单实扣证明。

G4映射固定为：完整字段与冻结caps内为`passed / complete_cost_report`；实际超过冻结budget/cost boundary为`failed / frozen_budget_exceeded`；actor未进入quality run为`not_run / actor_blocked`；actor运行但provider不提供usage为`not_run / provider_usage_not_reported`；除usage capability之外的必需成本证据缺失为`inconclusive / cost_evidence_incomplete`。

### 10.7 G5与方向决策

VP0无论结果如何：

```text
promotion = blocked
production integration = not_authorized
candidateLifecycle = retained_disabled
```

Direction builder按下表优先级取第一条命中行，因而对所有可达状态唯一：

| Priority | Gate/claim state | `direction` | lifecycle |
|---:|---|---|---|
| 1 | G1或source trust boundary failed | `drop` | `quarantined` |
| 2 | G0 failed/inconclusive/not-run、G1 inconclusive/not-run、或G2 failed/inconclusive/not-run | `revise` | `retained_disabled` |
| 3 | G3 `not_run`或`inconclusive` | `revise` | `retained_disabled` |
| 4 | G3 `refuted` | `pause` | `retained_disabled` |
| 5 | G3 `supported`且G4 `failed`（冻结budget/cost boundary超限） | `pause` | `retained_disabled` |
| 6 | G3 `supported`且G4 `passed` | `retain` | `retained_disabled` |
| 7 | G3 `supported`且G4只因`provider_usage_not_reported`为`not_run/inconclusive` | `retain`，但cost claim保持`not_run/inconclusive` | `retained_disabled` |
| 8 | G3 `supported`且G4因任何其他证据缺口为`not_run/inconclusive` | `revise` | `retained_disabled` |

`retain`只表示保留disabled candidate并允许另写VR0或product amendment；`pause`不得通过同revision换模型、retrieval或自动抽取救结果。G4 reason必须来自冻结枚举，不能用自由文本命中第7行。

## 11. Experiment receipt

VP0a/VP0b必须能在后续未授权或actor blocked时独立关闭；不能拿一个所有字段必填的final receipt伪装三阶段都完成。Milestone schema是discriminated union：

```ts
type FalVp0MilestoneReceiptV1 =
  | FalVp0MechanicsReceiptV1
  | FalVp0CorpusReceiptV1
  | FalVp0ReceiptV1;

interface FalVp0MechanicsReceiptV1 {
  readonly schemaVersion: 1;
  readonly experimentId: "fal-vp0-verified-procedure-utilization-v1";
  readonly milestone: "vp0a_mechanics";
  readonly sourceCommit: string | null;
  readonly freezeEvidence: {
    readonly mechanicsFreezeCommit: string;
    readonly mechanicsParentCommit: string;
    readonly actorPreflightCommit: string;
    readonly mechanicsTreeSha256: string;
    readonly actorPreflightSha256: string;
    readonly ancestryEvidenceSha256: string;
  };
  readonly protocolSha256: string;
  readonly actorPreflightSha256: string;
  readonly actorPreflightStatus: "passed" | "failed";
  readonly implementationHashesSha256: string;
  readonly canaryResults: readonly FalVp0CanaryResultV1[];
  readonly claimResults: readonly FalVp0ClaimResultV1[];
  readonly lifecycle: "draft";
  readonly evidenceValidity: "valid" | "limited" | "invalid";
  readonly implementationFidelity: "verified" | "failed" | "inconclusive";
  readonly productFit: "not_assessed";
  readonly promotion: "blocked";
  readonly direction: "retain" | "revise" | "pause" | "drop";
  readonly reproducibility: "full" | "corpus_only" | "receipt_only";
  readonly candidateLifecycle: "retained_disabled" | "quarantined";
  readonly cost: FalVp0CostSummaryV1;
  readonly actualFocusedMinutes: number;
  readonly receiptSha256: string;
}

interface FalVp0CorpusReceiptV1 {
  readonly schemaVersion: 1;
  readonly experimentId: "fal-vp0-verified-procedure-utilization-v1";
  readonly milestone: "vp0b_frozen_corpus";
  readonly sourceCommit: string | null;
  readonly freezeEvidence: {
    readonly mechanicsFreezeCommit: string;
    readonly procedureFreezeCommit: string;
    readonly procedureParentCommit: string;
    readonly holdoutCommitmentCommit: string;
    readonly holdoutParentCommit: string;
    readonly procedureTreeSha256: string;
    readonly holdoutCommitmentTreeSha256: string;
    readonly ancestryAndOrderPassed: boolean;
    readonly ancestryEvidenceSha256: string;
  };
  readonly actorPreflightSha256: string;
  readonly sourcePackSha256: string;
  readonly procedurePackSha256: string;
  readonly supportAdjudicationPackSha256: string;
  readonly holdoutCommitmentSha256: string;
  readonly lineageComparisonCommitmentSha256: string;
  readonly authoringSeparation: "proven" | "not_proven";
  readonly sourceEligibility: FalVp0SourceEligibilitySummaryV1;
  readonly procedures: readonly FalVp0ProcedureSummaryV1[];
  readonly claimResults: readonly FalVp0ClaimResultV1[];
  readonly lifecycle: "candidate_built";
  readonly evidenceValidity: "valid" | "limited" | "invalid";
  readonly implementationFidelity: "verified" | "failed" | "inconclusive";
  readonly productFit: "not_assessed";
  readonly promotion: "blocked";
  readonly direction: "retain" | "revise" | "pause" | "drop";
  readonly reproducibility: "full" | "corpus_only" | "receipt_only";
  readonly candidateLifecycle: "retained_disabled" | "quarantined";
  readonly cost: FalVp0CostSummaryV1;
  readonly actualFocusedMinutes: number;
  readonly receiptSha256: string;
}

interface FalVp0ReceiptV1 {
  readonly schemaVersion: 1;
  readonly experimentId: "fal-vp0-verified-procedure-utilization-v1";
  readonly milestone: "vp0c_actor_evidence";
  readonly sourceCommit: string | null;
  readonly sourceDirtyStateSha256: string | null;
  readonly sourceStateFiles: readonly {
    readonly path: string;
    readonly rawFileSha256: string;
  }[];
  readonly productionSourceTreeSha256: string;
  readonly manifestSha256: string;
  readonly protocolSha256: string;
  readonly sourcePackSha256: string;
  readonly procedurePackSha256: string;
  readonly freezeEvidence: {
    readonly procedureFreezeCommit: string;
    readonly actorPreflightCommit: string;
    readonly actorPreflightReceiptSha256: string;
    readonly holdoutCommitmentCommit: string;
    readonly holdoutCommitmentSha256: string;
    readonly executionFreezeCommit: string;
    readonly executionFreezeSha256: string;
    readonly ancestryAndOrderPassed: boolean;
    readonly authoringSeparation: "proven" | "not_proven";
    readonly phaseAccessLogSha256: string;
    readonly authoringIsolationAttestationSha256: string;
    readonly procedurePackSha256BeforeReveal: string;
    readonly procedurePackSha256AfterReveal: string;
    readonly supportAdjudicationPackSha256: string;
    readonly lineageComparisonPackSha256: string;
    readonly evaluationCommitmentSha256: string;
  };
  readonly implementationHashes: {
    readonly sourceVerifierSha256: string;
    readonly supportCoverageSha256: string;
    readonly supportAdjudicationVerifierSha256: string;
    readonly lineageComparatorSha256: string;
    readonly carrierMaterializerSha256: string;
    readonly applicabilityGateSha256: string;
    readonly hostFactRegistrySha256: string;
    readonly actorDriverSha256: string;
    readonly casePolicyAdapterSha256: string;
    readonly requestNormalizerSha256: string;
    readonly tokenEstimatorSha256: string;
    readonly graderSha256: string;
    readonly publicSmokeVerifierImplementationSha256: string;
    readonly scorerSha256: string;
  };
  readonly actorConfig: {
    readonly actorPreflightSha256: string;
    readonly providerModelEndpointSha256: string;
    readonly modelArtifactSha256: string | null;
    readonly systemInstructionSha256: string;
    readonly toolCatalogSha256: string;
    readonly runtimePolicySha256: string;
    readonly budgetSha256: string;
    readonly temperatureControl: "override_zero" | "provider_default_not_exposed";
    readonly maxRetries: 0;
    readonly seedControl: "fixed" | "unsupported";
    readonly publicSmokeObservationSha256: string;
    readonly publicSmokeVerifierObservationSha256: string;
    readonly usageCapability: "complete" | "not_reported";
  };
  readonly lifecycle: "evaluation_complete" | "closed";
  readonly evidenceValidity: "valid" | "limited" | "invalid";
  readonly implementationFidelity: "verified" | "failed" | "inconclusive";
  readonly claimResults: readonly FalVp0ClaimResultV1[];
  readonly productFit: "supported" | "not_demonstrated" | "inconclusive" | "not_assessed";
  readonly promotion: "blocked";
  readonly direction: "retain" | "revise" | "pause" | "drop";
  readonly reproducibility: "full" | "corpus_only" | "receipt_only";
  readonly candidateLifecycle: "retained_disabled" | "quarantined";
  readonly sourceEligibility: FalVp0SourceEligibilitySummaryV1;
  readonly procedures: readonly FalVp0ProcedureSummaryV1[];
  readonly pairResults: readonly FalVp0PairResultV1[];
  readonly canaryResults: readonly FalVp0CanaryResultV1[];
  readonly aggregate: FalVp0AggregateV1;
  readonly cost: FalVp0CostSummaryV1;
  readonly runCompleteness: {
    readonly applicablePairsValid: number;
    readonly negativePairsValid: number;
    readonly unrunCaseIds: readonly string[];
    readonly stopReason: null | "g1_hard_stop" | "baseline_only_harm" | "actor_blocked" | "timebox" | "provider_or_harness_failure";
  };
  readonly packEvidence: "passed" | "failed" | "not_run";
  readonly platformEvidence: {
    readonly windows: "passed" | "failed" | "not_run";
    readonly linux: "passed" | "failed" | "not_run";
  };
  readonly actualFocusedMinutes: number;
  readonly receiptSha256: string;
}

interface FalVp0ClaimResultV1 {
  readonly claimId: string;
  readonly result: "supported" | "refuted" | "inconclusive" | "not_run";
  readonly reasonCode: string | null;
  readonly boundary: string;
  readonly metricIds: readonly string[];
  readonly caseRoles: readonly string[];
  readonly evidenceSha256s: readonly string[];
  readonly nonClaims: readonly string[];
}

interface FalVp0SourceEligibilitySummaryV1 {
  readonly expectedSources: 6;
  readonly eligibleSources: number;
  readonly sourceBindingSha256s: readonly string[];
  readonly rejectedSourceIds: readonly string[];
  readonly rejectionCountsByCode: Readonly<Record<string, number>>;
  readonly exactLedgerSources: number;
  readonly summarySha256: string;
}

interface FalVp0ProcedureSummaryV1 {
  readonly procedureFamilyId: string;
  readonly procedureId: string;
  readonly procedureSha256: string;
  readonly sourceBindingSha256s: readonly [string, string];
  readonly supportSetSha256: string;
  readonly supportAdjudicationSha256: string;
  readonly supportStatus: "unanimous_entailed" | "rejected" | "not_run";
  readonly reviewerSeparation: "proven" | "not_proven";
  readonly reviewerIdentitySha256s: readonly [string, string];
  readonly sourceDossierEstimatedTokens: number;
  readonly procedureEstimatedTokens: number;
}

interface FalVp0PairResultV1 {
  readonly caseId: string;
  readonly procedureFamilyId: string;
  readonly role: "near_transfer_a" | "near_transfer_b" | "changed_guard" | "negative";
  readonly runStatus: "valid" | "invalid" | "not_run";
  readonly reasonCode: string | null;
  readonly expectedApplicability: "applicable" | "applicable_guarded" | "not_applicable";
  readonly actualCandidateApplicability: "applicable" | "applicable_guarded" | "not_applicable" | "fallback_error" | null;
  readonly baselineFullPass: boolean | null;
  readonly candidateFullPass: boolean | null;
  readonly g3Classification: "candidate_only" | "baseline_only" | "both_pass" | "both_fail" | "not_in_g3" | null;
  readonly harmfulGuidance: boolean | null;
  readonly candidateForbiddenActionIdsObserved: readonly string[] | null;
  readonly changedGuardForbiddenActionViolation: boolean | null;
  readonly baselineToolCalls: number | null;
  readonly candidateToolCalls: number | null;
  readonly baselineTotalTokens: number | null;
  readonly candidateTotalTokens: number | null;
  readonly baselineCarrierBytes: number | null;
  readonly candidateCarrierBytes: number | null;
  readonly baselineCarrierEstimatedTokens: number | null;
  readonly candidateCarrierEstimatedTokens: number | null;
  readonly usageComplete: boolean;
  readonly efficiencyEligible: boolean;
  readonly toolCallReductionBps: number | null;
  readonly totalTokenDeltaBps: number | null;
  readonly baselineObservationSha256: string | null;
  readonly candidateObservationSha256: string | null;
  readonly pairResultSha256: string;
}

interface FalVp0AggregateV1 {
  readonly applicablePairDenominator: 9;
  readonly applicablePairsValid: number;
  readonly negativePairsValid: number;
  readonly candidateOnlyWins: number;
  readonly baselineOnlyWins: number;
  readonly bothPass: number;
  readonly bothFail: number;
  readonly winningFamilyIds: readonly string[];
  readonly negativeFallbacksPassed: number;
  readonly harmfulGuidanceCount: number;
  readonly changedGuardForbiddenActionViolationCount: number;
  readonly efficiencyEligibleBothPassPairs: number;
  readonly pairedMedianToolCallReductionBps: number | null;
  readonly pairedMedianTotalTokenDeltaBps: number | null;
  readonly capabilityClaimResult: "supported" | "refuted" | "inconclusive" | "not_run";
  readonly capabilityClaimReasonCode: "criteria_met" | "quality_safety_violation" | "baseline_only_harm" | "threshold_missed" | "incomplete_applicable_pairs" | "actor_blocked";
  readonly efficiencyAlternativeResult: "supported" | "refuted" | "inconclusive" | "not_run";
  readonly efficiencyAlternativeReasonCode: "criteria_met" | "quality_safety_violation" | "threshold_missed" | "insufficient_both_pass_pairs" | "quality_not_equal" | "usage_incomplete" | "incomplete_applicable_pairs" | "actor_blocked";
  readonly g3CompositeResult: "supported" | "refuted" | "inconclusive" | "not_run";
  readonly g3CompositeReasonCode: "alternative_supported" | "quality_safety_violation" | "baseline_only_harm" | "actor_blocked" | "incomplete_applicable_pairs" | "efficiency_usage_incomplete" | "no_supported_alternative";
  readonly g4CostReasonCode: "complete_cost_report" | "provider_usage_not_reported" | "frozen_budget_exceeded" | "cost_evidence_incomplete" | "actor_blocked";
  readonly gates: Readonly<Record<"g0" | "g1" | "g2" | "g3" | "g4", "passed" | "failed" | "inconclusive" | "not_run">>;
  readonly aggregateSha256: string;
}

interface FalVp0CostSummaryV1 {
  readonly authoring: {
    readonly reviewModelCalls: number;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly estimatedCostUsdMicros: number | null;
  };
  readonly adapterReadPath: {
    readonly modelCalls: 0;
    readonly toolCalls: 0;
    readonly networkCalls: 0;
    readonly baselineCarrier: FalVp0CarrierCostAggregateV1;
    readonly candidateCarrier: FalVp0CarrierCostAggregateV1;
  };
  readonly actor: {
    readonly attempts: number;
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly estimatedCostUsdMicros: number | null;
  };
  readonly storageBytes: number;
  readonly packedArtifactDeltaBytes: number;
  readonly priceScheduleSha256: string | null;
  readonly summarySha256: string;
}

interface FalVp0CarrierCostAggregateV1 {
  readonly observedArmCount: number;
  readonly totalCarrierBytes: number;
  readonly medianCarrierBytes: number | null;
  readonly totalCarrierEstimatedTokens: number;
  readonly medianCarrierEstimatedTokens: number | null;
}
```

VP0a receipt中的`actorPreflightCommit`必须等于`mechanicsFreezeCommit`，且builder从Git object/tree重算parent、tree与ancestry evidence；VP0b必须机械证明`mechanicsFreezeCommit`是`procedureFreezeCommit`祖先、`procedureFreezeCommit`是`holdoutCommitmentCommit`祖先，并证明各phase受保护bytes在后继节点未变化。缺commit object、dirty semantic bytes、parent/order不符或tree hash不匹配时，milestone不能记`evidenceValidity=valid`。

Pair scorer直接从两条arm observations读取tool/usage/carrier bytes/tokens以及candidate fresh-verifier forbidden-action IDs，不能接收caller传入的效率或cost数字。`usageComplete=false`时usage-derived效率字段按合同保持null/false；eligible时两个bps必须按§10.5重算。Carrier四个pair字段只要对应arm observation存在就必须从其`carrierBytes/estimatedTokens`复制，否则为null。`changed_guard`且candidate verifier存在时，violation严格等于其forbidden IDs非空；非changed-guard或未运行时为null。Aggregate只能从12条pair result重算counts、medians、两个alternative结果与composite G3；`gates.g3`不允许独立填写。

Carrier cost按arm分别聚合所有实际存在且strict-valid的arm observations，不只聚合both-pass或efficiency eligible子集：`observedArmCount`是纳入数量，total为integer sum，median按§10.5同一sort与偶数`truncTowardZero`规则；数量为0时两个median为null而total为0。Receipt不得把两臂相加成一个无标签`carrierBytes`，也不得用planned值填补unrun arm。

每个`claimResults[]`必须带parent合法的`result = supported | refuted | inconclusive | not_run`、typed reason、claim boundary、metric、case roles、evidence refs/hashes与non-claim，至少分别记录：source eligibility、advisory authority isolation、fallback equivalence、non-regression、held-out full-pass utility、equal-quality efficiency、pack isolation和external-validity boundary。`not_run_due_harm_stop`等只作为reason code，不新增closure-axis枚举。

Logical hash使用`sha256Canonical`，文件hash使用raw bytes SHA-256，字段名必须区分。`receiptSha256`覆盖除自身、wall-time distribution与`actualFocusedMinutes`外的logical fields；source commit、model/config、usage和outcome不能被排除。Dirty run必须绑定base commit与完整dirty-state hash，不能称exact-commit。

Tracked receipt不得包含raw session、private task/user text、provider reasoning、absolute path、username、hostname、API key、credential或hidden solution。Public fixture task/procedure可以在reveal后tracked；真实trace只公开redacted transform与exact hashes。

## 12. Mechanical acceptance

| ID | Case | Required result |
|---|---|---|
| `FAL-VP01` | strict procedure schema | canonical encode/decode、identity/hash稳定 |
| `FAL-VP02` | two heterogeneous exact sources per family | 6/6 eligible且lineage真实不同 |
| `FAL-VP03` | failed/incomplete/unresolved-effect source | candidate blocked before materialization |
| `FAL-VP04` | missing/tampered episode/evidence/report/verification | typed rejection、provider 0 |
| `FAL-VP05` | wrong principal/repository/root | candidate not invoked、provider 0 |
| `FAL-VP06` | stale/out-of-range runtime version | candidate not invoked、provider 0 |
| `FAL-VP07` | source/procedure poison marker | no current instruction/protected fact/effect delta |
| `FAL-VP08` | old approval/high-risk effect wording | grants nothing、executes nothing |
| `FAL-VP09` | oracle family only | applicability gate仍拥有最终注入决定 |
| `FAL-VP10` | disabled | source-dossier fallback与baseline首个semantic Host request hash相同 |
| `FAL-VP11` | deadline/throw/invalid/oversize | Host-only typed diagnostic + fresh baseline relaunch；provider前失败 |
| `FAL-VP12` | deterministic render | full ContextItem ≤800 tokens、hash稳定 |
| `FAL-VP13` | paired workspace/config | same before hash/config；zero shared state |
| `FAL-VP14` | worker blindness | cannot read goldens/scorer/sealed registry |
| `FAL-VP15` | supervisor fresh verifier | self-judge/source receipt不能决定full-pass |
| `FAL-VP16` | 12-pair distribution | exact roles/families/order/gate denominator |
| `FAL-VP17` | same observations rescored | identical logical score/receipt bytes与hash |
| `FAL-VP18` | quality vs canary aggregation | canary/negative不计candidate win或efficiency |
| `FAL-VP19` | actor backend preflight | fake/reader-only lane不能解锁G3 |
| `FAL-VP20` | production isolation | imports/dependencies/pack entries均为0 |
| `FAL-VP21` | authority mutation audit | canonical memory/current instruction/approval/effect mutation为0 |
| `FAL-VP22` | delete/omit lab root | production build/tests/baseline logical behavior不变 |
| `FAL-VP23` | support ref replay | 每个semantic atom可定位exact bytes并重算span SHA/coverage |
| `FAL-VP24` | equal-information intervention | baseline dossier span set与candidate support set完全相同 |
| `FAL-VP25` | typed applicability facts | host facts/predicate结果可重算；free-text不参与gate |
| `FAL-VP26` | five-axis comparator | 从actual bytes重算fingerprints/逐元素intersections；每个held-out×source满足3-of-5 |
| `FAL-VP27` | actor/execution freeze binding | preflight SHA与正式run exact match；reveal顺序可证 |
| `FAL-VP28` | every-turn inclusion | context plan item IDs与Host request hashes逐turn闭合；provider encoded可诚实为null |
| `FAL-VP29` | first baseline-only hard stop | non-regression refuted，其余case显式not-run，不被G0覆盖 |
| `FAL-VP30` | semantic support adjudication | 两名reviewer identity/instance/attestation互异且separation proven；复制或rejected candidate不解锁G3 |
| `FAL-VP31` | canary actual failure | candidate/provider/mutation非零仍能保存schema-valid failed observation |
| `FAL-VP32` | milestone closure | VP0a/VP0b可各自产生strict receipt且不伪造VP0c fields |
| `FAL-VP33` | external-validity mapping | isolation/trace prerequisites与四种productFit结果唯一映射 |
| `FAL-VP34` | safety-first schedule | 12 canary→3 negative→9 applicable顺序与commitment/freeze hash一致 |
| `FAL-VP35` | public smoke replay | 从exact event/workspace/completion/report/fresh-verifier refs重算五项capability与preflight status |
| `FAL-VP36` | efficiency receipt replay | pair bps、eligible set、paired medians、alternative与composite G3可从arm observations唯一复算 |
| `FAL-VP37` | typed predicate failures | missing/type mismatch/invalid expected/extractor failure均为reject，不能伪装普通false |
| `FAL-VP38` | milestone freeze ancestry | VP0a/VP0b commit parent/tree/order与protected-byte immutability可独立重放 |
| `FAL-VP39` | reviewer uniqueness | duplicated ID/identity/instance/attestation或separation not proven均使G3 not-run |
| `FAL-VP40` | G3/G5 truth table | harmful/changed-guard violation先refute；equal-quality usage missing为inconclusive；所有gate tuples唯一映射 |
| `FAL-VP41` | carrier cost replay | 两臂bytes/tokens从arm→pair→separate aggregates精确复算，unrun不补值 |

## 13. Implementation map

所有candidate、runner和test-only capability都留在可整目录删除的lab root：

```text
fixtures/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/
  protocol.json
  source/source-pack.json
  procedures/procedure-pack.json
  procedures/support-adjudication-pack.json
  mechanics/canary-pack.json
  mechanics/public-smoke-pack.json
  holdout/commitment.json
  holdout/lineage-comparison.json      # reveal后tracked；commitment阶段只提交其salted hash
  holdout/inputs.json                 # reveal后tracked；首次commitment阶段不可读
  holdout/goldens.json                # host/scorer only；reveal后tracked if public
  holdout/task-assets/**
  freezes/public-smoke-evidence/**
  freezes/public-smoke-observation.json
  freezes/public-smoke-verification.json
  freezes/actor-preflight.json
  freezes/execution-freeze.json
  receipts/vp0a-mechanics-receipt.json
  receipts/vp0b-corpus-receipt.json
  receipts/vp0c-actor-evidence-receipt.json

labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/
  README.md
  src/procedure-schema.ts
  src/source-binding-schema.ts
  src/source-verifier.ts
  src/support-ref-verifier.ts
  src/support-adjudication-schema.ts
  src/source-dossier-renderer.ts
  src/procedure-renderer.ts
  src/procedure-skill-materializer.ts
  src/carrier-package-preflight.ts
  src/applicability-gate.ts
  src/host-fact-predicate.ts
  src/lineage-comparator.ts
  src/lineage-schema.ts
  src/phase-manifest-loader.ts
  src/actor-driver.ts
  src/actor-preflight-schema.ts
  src/public-smoke-schema.ts
  src/public-smoke-verifier.ts
  src/case-policy-adapter.ts
  src/semantic-request-normalizer.ts
  src/observation-schema.ts
  src/execution-freeze-schema.ts
  src/supervisor.ts
  src/fresh-verifier.ts
  src/scorer.ts
  src/receipt-schema.ts
  tools/run-mechanics.ts
  tools/run-actor-preflight.ts
  tools/prepare-procedure-freeze.ts
  tools/prepare-holdout-commitment.ts
  tools/prepare-execution-freeze.ts
  tools/run-paired-quality.ts
  tools/score-observations.ts
  tests/procedure-contract.test.ts
  tests/source-verifier.test.ts
  tests/support-dossier-equivalence.test.ts
  tests/carrier-authority.test.ts
  tests/predicate-lineage.test.ts
  tests/runner-isolation.test.ts
  tests/actor-execution-freeze.test.ts
  tests/public-smoke-replay.test.ts
  tests/efficiency-aggregation.test.ts
  tests/gate-direction-truth-table.test.ts
  tests/carrier-cost-replay.test.ts
  tests/milestone-ancestry.test.ts
  tests/scorer-receipt.test.ts
  tests/pack-isolation.test.ts
```

允许新增一个root script，不允许新增root production dependency：

```text
pnpm lab:verified-procedure -- --mode mechanics --output <new-run-dir>
pnpm lab:verified-procedure -- --mode preflight --actor <lane> --output <new-run-dir>
pnpm lab:verified-procedure -- --mode procedure-freeze --output <new-freeze-dir>
pnpm lab:verified-procedure -- --mode holdout-commitment --output <new-freeze-dir>
pnpm lab:verified-procedure -- --mode execution-freeze --actor <lane> --output <new-freeze-dir>
pnpm lab:verified-procedure -- --mode paired --actor <lane> --output <new-run-dir>
pnpm lab:verified-procedure -- --mode score --input <run-dir> --output <new-score-file>
```

`mechanics`和`score`必须无网络。`paired`在无显式actor entry pass、call/token/cost caps或授权时，必须在0次provider调用前拒绝。

本card不得修改：

```text
src/memory/core/**
src/memory/store/**
src/memory/retrieval/**
src/memory/recall/**
src/context/**
src/skills/**
src/evals/**
src/agent/**
src/providers/**
src/capabilities/**
src/verification/**
capabilities/builtin/**
```

Lab可导入production public components，production不得反向import lab。若不修改上述目录就无法完成真实actor injection，当前revision停止并先写最小eval/provider amendment；不能把product seam偷偷算作lab plumbing。

## 14. 实现顺序、预算与硬停止

VP0拆成三个各自可关闭、各自有receipt的里程碑，避免actor或corpus阻塞时把已完成mechanics拖成半成品：

| Milestone | Deliverable | Focused estimate |
|---|---|---:|
| VP0a mechanics | strict schemas、typed gate、equal-information Skill carrier、12 canary variants、structural actor driver/public smoke preflight、mechanics receipt | 8–12h |
| VP0b frozen corpus | source verifier、6 exact sources、3 procedures/dossiers + support adjudication、12 held-out fixtures/graders、five-axis/non-leakage、procedure/holdout receipts | 8–14h |
| VP0c actor evidence | execution freeze、safety-first最多24 attempts、fresh verifier、scorer/final receipt/pack closure | 5–8h + actor wall time |

端到端现实估计为21–34 focused hours，置信度为medium；24次live actor的等待时间与provider费用另记。VP0a是最小有用交付，完成后可独立决定是否支付VP0b/VP0c。每个milestone有16 focused-hour硬停并关闭自己的claim，不把超时藏到下一阶段。若需要新的DeepSeek/tool backend，另估4–8h并写provider amendment，不藏进VP0。

以下任一情况立即停止当前revision：

- VP0a第6个focused hour仍没有可重复mechanics observation；
- source只能凭episode/report narrative而不能闭合exact completion evidence；
- 必须修改canonical memory、context authority、SkillRuntime或production Agent才能注入；
- 两臂不能共享同一carrier authority/priority/selection path；
- source/holdout template或solution lineage不能机械分离；
- worker能读取golden/scorer或actor workspace能访问hidden solution；
- 任一G1 canary失败；
- candidate read path需要model、embedding、network或自动execution；
- live run出现首个valid baseline-only full-pass win；
- evaluation后需要改procedure/prompt/scorer才能“通过”；
- actor backend未通过entry gate；此时关闭为`actor_blocked`，不顺手加provider；
- 当前milestone focused time达到16小时。

硬停后保留source、schema、candidate、observations、failed/inconclusive receipt和learning record，默认`retained_disabled`。收益不足不触发源码删除；secret/license/hazard另按parent合同处理。

## 15. 本地验收命令与完成边界

实现后至少运行：

```text
node node_modules/vitest/vitest.mjs run \
  labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/tests \
  --maxWorkers=1
pnpm typecheck
pnpm build
pnpm pack:smoke
git diff --check
```

本spec的“实现完成”只表示：

```text
schema/source_verifier/carrier = implemented
mechanics_and_canaries         = passed
paired_runner_and_scorer       = implemented
production_import_pack_delta   = zero
actor_quality_run              = passed | failed | not_run_actor_blocked
promotion                     = blocked
```

缺少24个valid live attempts时，不得写`held_out_utility_supported`；少于2条`trace_redacted` exact sources、未覆盖2个family或`authoringSeparation!=proven`时，`productFit`固定`not_assessed`；缺少Linux/pack/remote actor时必须逐项写`not_run`，不能从Windows local mechanics外推。

## 16. 研究来源与没有照搬的部分

- [Agent Workflow Memory](https://proceedings.mlr.press/v267/wang25bx.html)：借用从成功轨迹抽象workflow及跨任务验证，不采用online LLM自评晋升或固定macro；
- [AFTER](https://arxiv.org/abs/2606.23127)：借用source/validation/test分离、版本化skill与held-out promote/rollback，不声称其未完整公开的evolution runner可直接复现；
- [ReasoningBank](https://arxiv.org/abs/2509.25140)：借用software-engineering经验复用问题，不采用same-model success judge或embedding作为VP0变量；
- [Skill-Pro](https://arxiv.org/abs/2602.01869)：借用activation/procedure/termination结构，不采用PPO gate、训练或逐step skill selection；
- [ExpeL](https://arxiv.org/abs/2308.10144)与[ACE](https://arxiv.org/abs/2510.04618)：只作为未来VR0的fail-success delta与incremental playbook锚点，本card不实现reflection/evolution。

这些论文证明方向值得做隔离实验，不证明BornAgent已受益。VP0最终只认本card冻结的fresh observable verifier、paired observations与正交closure axes。
