# BornAgent Architecture Simplification Maintenance Spec

> 状态：AS0.1–AS5.1 Local Gate Passed / Exact-Commit CI Pending；AS5.2 Ready（2026-08-14）
> 性质：Personal Open-Source Maintenance工作项；不创建Phase 22，不形成新里程碑
> 前置：Phase 0–20 Implemented、M11 Passed、21A local gate Passed；实施提交仍须服从21A exact-commit release closure
> 优先顺序：recovery correctness -> bounded resources -> authority/lifecycle simplification -> duplicate-path removal -> efficiency

## 0. 文档地位

本spec落实[`Personal Open-Source Maintenance Roadmap`](personal-open-source-maintenance-roadmap.md)中的`Architecture simplification`轨道。它解决的是已经通过gate的本地产品如何降低长期维护成本，不增加provider、surface、Agent能力或远程产品面。

本文件不取代Phase 0–21的行为合同。发生冲突时：

1. 用户当前任务中的明确要求优先；
2. 已通过Phase spec中的authority、effect、persistence和recovery不变量优先；
3. 本文件可以收窄依赖、删除重复实现和优化资源使用，但不能放宽既有合同；
4. 不能用“架构更干净”覆盖真实行为或证据回归。

本spec由多个可独立验收的maintenance item组成，不要求一次性完成。每次只实施一个item；未满足该item的gate时，不并行展开后续大重构。

AS0.1至AS5.1已按依赖顺序完成本地实现与验证：evidence/characterization、handoff/scanner、single Host/runtime attenuation、shared session evidence/cancellation/read ports、product/TUI boundary以及terminal/resource ownership均已落地。当前tracked manifest为102项（default 54、metric 35、built paths 12、pack 1），四个本地profile均已生成并回读验证receipt；`pnpm check`为263文件/1225测试通过（8文件/16测试为既有opt-in skip），Phase21A required gate为165测试且required skip 0，built-path required cases为12/12，installed-tarball pack smoke通过。characterization v3 canonical SHA-256为`7e362f1a05856f504947e8e678bd202aa6578dc77550db7025061ad53e80db91`。这些工作包当前均为`local_gate_passed`；只有同一exact commit的Linux/Windows CI receipts均通过后才可标`passed`。AS5.2是下一`ready`工作包，尚未实施；AS6仍未解锁。

## 1. Review基线

2026-08-13只读审查得到以下事实：

- `src/`约611个TypeScript文件、149k行；`tests/`约274个TypeScript文件、64k行；
- 当前静态分析未发现runtime/value import cycle；type-only依赖存在一个约54文件的强连通分量；
- `CliRuntime`已经混合Agent、Docker、MCP、Plugin、Graph、worker、Delegation、worktree和TUI能力；
- `executeAgentExecution`、`TuiController`、Node runtime和composite adapters承担了过多编排职责；
- product CLI/TUI已经使用21A ApplicationService，但仍保留大量`controlPlaneStateRoot === undefined`的legacy写入分支；
- background handoff CAS使用无owner identity的持久`.handoff.lock`，崩溃后可能永久阻断takeover；
- workspace snapshot会两次保留全树内容并构造base64比较，512MiB逻辑上限不能限制实际峰值内存；
- session catalog、run owner/cancel barrier和高频polling共享同一日志与全量projection；
- message与resume重复实现run cancellation生命周期；Graph与Delegation重复实现exact JSONL evidence reader；
- `pnpm typecheck`、`pnpm lint`和`git diff --check`在审查时通过；本审查未以完整测试结果宣告任何新实现完成。

这些数据是排序依据，不是永久阈值，也不是用删代码或删测试达成的KPI。

## 2. 目标

### 2.1 必须实现的方向

1. 消除会让本地session永久wedged的可恢复性缺口。
2. 让文件数、字节数和日志长度的bounded contract在实际资源使用中成立。
3. 每个product process/state root只存在一个明确拥有生命周期的`LocalApplicationHost`。
4. 领域owner、child和worker只获得完成职责所需的最小typed ports。
5. product CLI/TUI mutation只有ApplicationService一条authority路径；legacy读取、回放和formal adoption继续存在。
6. run cancellation、exact session evidence和terminal publication各有唯一共享实现与明确owner。
7. TUI只拥有surface state和presentation；application/domain routing通过窄facade进入。
8. 架构依赖方向、required evidence和package行为可以机械验证。

### 2.2 成功不以这些指标定义

- 不以文件数、class数、LOC下降或“设计模式数量”作为完成条件；
- 不要求拆成monorepo、多package、daemon、service或plugin framework；
- 不以删除legacy数据支持、crash tests、PTY tests或cross-platform gates换取简化；
- 不以提高Graph/Delegation并行度或增加cache掩盖错误边界。

## 3. 明确不做

- 不实现21B Web/IDE、21C browser/computer-use、21D remote worker、21E team governance；
- 不增加hosted service、marketplace、automatic Git publish或dynamic Agent tree；
- 不替换AgentLoop、session JSONL、TaskGraph、Delegation envelope或worktree格式；
- 不把ApplicationService变成domain/effect owner；
- 不构造generic durable store、generic composite reconciler或万能state machine；
- 不用mtime、lock age、PID单值、broker absence或timeout推断owner死亡/effect成功；
- 不改变现有CLI命令、TUI确认语义、公开exit code或持久事件taxonomy，除非另有独立兼容spec；
- 不访问互联网、真实remote provider或ambient credential完成本工作项。

## 4. 不可破坏的不变量

以下复杂度具有明确安全价值，必须保留：

- human mutation统一经过prepare/commit、authorization、exact target、idempotency和operation journal；
- append-before-effect；pre-effect、effect-started和unknown-effect严格区分；
- unknown effect禁止自动重放，并继续占用需要保留的budget/lease；
- owner identity绑定PID与process-start identity，不能只看PID；
- storage head、projection identity、delivery cursor和live observation是不同authority；
- active owner通过broker/owner port读取；inactive reader持锁读取，不能降级为无锁JSONL；
- run cancel先有durable request、owner generation、session binding，之后才signal并绑定terminal；
- Graph/Delegation/worktree/capability/envelope/receipt使用exact revision/hash；
- worktree allocation、promotion、origin verification和cleanup继续独立批准和fresh revalidation；
- child保持独立session shard、attenuated authority与Host验证receipt；
- terminal event最后发布；writer/persistence失效后禁止补写“成功”terminal；
- legacy JSONL不重写，historical principal/origin不升级；
- Phase19 single-active attempt与Phase20 max2 children保持不变；
- local-free、zero-network、zero ambient credential和no automatic fallback保持不变。

## 5. 目标架构

### 5.1 依赖方向

```text
CLI bootstrap / TUI host
  -> surface adapter
  -> LocalApplicationHost
       -> ApplicationService / QueryService
       -> action/query use-case ports
       -> exact owner router / delivery coordinator
  -> domain owner ports
  -> durable domain stores and effects
```

依赖规则：

- `domain/runtime`不得依赖`cli`、`commands`或TUI component；
- `coordination`不得依赖`tui`；surface-neutral intent放到application/coordination contract；
- `control-plane/adapters`不得依赖`commands` helper或renderer；
- MCP、repository intelligence和其他core模块不得依赖TUI sanitizer/component；
- durable application-commit/user-origin schema放到surface-neutral durable contract模块，domain event schema不得依赖ApplicationService实现模块；
- composition root可以依赖所有下层模块，但下层不得反向依赖composition root；
- 以上规则由ESLint或专门dependency test机械验证。

### 5.2 LocalApplicationHost

一个product process/state root只创建一个`LocalApplicationHost`。它拥有：

- Host control authority与principal authority；
- repository/session/run-lifecycle registries；
- prepared-action、operation、artifact和pagination stores；
- broker、delivery coordinator和active owner router；
- application action/query services；
- 明确的`dispose()`/process shutdown生命周期。

CLI/TUI adapter不再构造concrete control plane，也不再维护多组module-global state-root maps。terminal IO、prepared-action review和一次command的presentation作为短生命周期surface ports传入Host或adapter，不由长期Host保存。

### 5.3 Runtime capability slices

现有`CliRuntime`逐步收口为composition产物，至少拆成以下窄能力：

- `ProcessHostPorts`：clock、UUID、timer、process identity、filesystem/process factories；
- `AgentOwnerPorts`：model、tools、approval、session writer、capability/hook/MCP ports；
- `TaskOrchestrationPorts`：Graph scheduler、worktree、background worker、Delegation owner ports；
- `ApplicationHostPorts`：actions、queries、owner controls与delivery；
- `SurfacePresentationPorts`：stdout/stderr、TUI review/render与terminal sanitation。

Graph node、Delegation child和background worker直接构造attenuated ports；禁止展开完整`CliRuntime`后覆盖少数字段来表达authority attenuation。

### 5.4 Session authority slices

- `SessionCatalogRegistry`只负责session create、legacy adoption、materialization intent/marker；
- `RunLifecycleRegistry`负责run owner generation、started/progress observation、cancel request/binding/terminal；
- `ExactSessionEvidenceReader`唯一负责stable JSONL读取、strict UTF-8/JSON、sequence、raw-line hash与exact head验证；
- `RunCancellationLifecycle`唯一负责owner-side的`register -> observe -> request -> bind -> signal -> verify terminal -> close`；
- message/resume保留各自payload、launch、result和reconciliation predicate，不复制cancel协议；
- Graph/Delegation保留各自complete predicate，不复制ledger reader。

物理journal是否分离分两步决策：先拆接口和projection；只有测量证明共享journal仍造成catalog staleness或高频全量扫描时，才把run lifecycle迁入按session/run分片的append-only journal。迁移必须兼容existing state root并fail closed，不能重写历史。

### 5.5 Surface边界

产品链路固定为：

```text
terminal input
  -> pure parser
  -> surface-neutral intent
  -> CLI/TUI application facade
  -> LocalApplicationHost
```

- product runtime必须提供Application Host；state root不再是“新路径或直写路径”的feature switch；
- legacy read/replay/formal adoption保留；legacy direct execution只允许在明确命名的`DomainHarness`或eval harness中；
- TUI controller只负责input、dialog、ephemeral state、render scheduling与surface lifecycle；
- mutation/resume/Graph/Delegation/session query通过一个`TuiApplicationFacade`；
- terminal sanitizer移动到presentation/security公共模块；
- parser是pure function，command语法不与controller并发状态绑定。

## 6. Maintenance items与顺序

### AS0 — Characterization and architecture gate

目的：先固定现状，再开始移动边界。

#### AS0.1 Evidence contract and gate self-test

先建立tracked、machine-readable的证据合同，不修改生产行为：

- 新增`tests/evidence/architecture-simplification-v1.json`；该文件是required case identity的authority，不能只把机器合同放在被Git忽略的`spec/`；
- 新增validator读取Vitest JSON和其他runner report，不重复执行测试；
- validator以exact case ID、platform和profile判定，不使用“总测试数超过阈值”替代必需证据；
- validator自测必须证明missing case、duplicate ID、unexpected skip、wrong platform/profile、manifest/receipt hash不匹配全部失败；
- conditional/default skip只有在同一required platform的opt-in profile中exact case通过才算补偿；
- 当前`phase21a:gate`的count/skip检查保留为兼容gate，但不能成为新maintenance item的唯一证据。

manifest顶层使用strict `{ schemaVersion: 1, manifestId, cases }`，未知字段拒绝；其中每个case至少包含：

```ts
interface RequiredEvidenceCaseV1 {
  readonly blocking: boolean;
  readonly file?: string;
  readonly fullName?: string;
  readonly id: string;
  readonly invariant: string;
  readonly platforms: readonly ("linux" | "win32")[];
  readonly profiles: readonly ("default" | "built_paths" | "pack" | "metric")[];
  readonly runner: "vitest" | "dependency" | "build" | "pack" | "metric";
  readonly workPackage: string;
}
```

manifest是稳定合同；run receipt是一次执行的观察结果，二者不得混为一份文件。receipt也具有strict schema/version，至少绑定manifest SHA-256、commit SHA、dirty paths/patch SHA-256（若非clean）、OS/arch/Node/pnpm、exact argv、exit/signal、runner report SHA-256、每个required case的`passed | failed | skipped | missing`和确定性metrics。local receipt可以保存在临时evidence目录；`passed`状态必须引用exact-commit CI receipt，不能只引用本地dirty run。

#### AS0.2 Characterization baseline

在AS0.1通过后，产出版本化baseline，而不只是人工笔记：

- import-boundary机械gate；
- background handoff fault-point编号、crash-prefix与两进程CAS characterization；
- workspace snapshot hash、`payloadReadCount`、`retainedPayloadBytes`和limit characterization；
- run/session的`catalogFullScanCount`、`fullProjectionCount`、`exclusiveSnapshotCount`与polling读取次数基线；
- Agent terminal/cleanup event golden；
- product/legacy command-surface route inventory；
- 每项baseline的可重复命令、machine-readable report和receipt。

RSS、poll interval和wall-clock只作诊断；correctness与efficiency gate必须优先使用确定性计数器。AS0不修改authority、durable format或产品行为。

### AS1 — Recovery and bounded resources

#### AS1.1 Background handoff CAS

- V2先写入并fsync content-addressed immutable candidate，再以跨Windows/Linux验证过的atomic no-replace primitive发布确定性`revision-<n>.json`；同一next revision只能出现一个完整winner，partial candidate不构成head；
- 每条revision至少绑定`schemaVersion`、`revision`、`previousRevisionSha256`、`recordSha256`、`transitionId`、owner PID/process-start identity及既有operation/worker/graph identity；
- `transitionId`必须由调用者durably保留或从immutable transition identity确定性派生，exact retry不得生成新ID；
- transition以完整`expected revision/hash`竞争；response loss后以`transitionId + exact revision/hash`读取winner并判定幂等完成；
- reader拒绝gap、fork、多个head、duplicate revision、hash mismatch和identity drift；
- 新协议不得创建持久`.handoff.lock`；
- active exact owner不可替换；只有`missing|different`且所有identity匹配时允许takeover；
- 新operation写V2；进行中的V1 operation保持V1 reader/writer，不做原地双写或自动升级；
- AS1.1之后发布的writer看到V2 marker必须拒绝V1写；早于该guard的binary按§8.3视为不支持V2 state root；V2 writer不得失败后回退V1 mutation；
- legacy `handoff.json`只读兼容；legacy无owner identity `.handoff.lock`不得按age自动删除或自动迁移，doctor只报告exact operation/path并零mutation；
- 产生第一条V2 revision前允许代码回滚；产生后只能forward-fix或read-only downgrade，不允许旧binary继续写该operation；
- session ledger仍是domain authority，sidecar只做cross-process coordination。

#### AS1.2 Bounded workspace scanner

- 本项同时覆盖`captureOriginBaseline`与`captureWorkspaceSnapshot`，但不得改变persisted manifest schema/version、entry排序、mode/size/hash、snapshot/archive identity；若任何durable hash必须变化，停止本项并另开format migration spec；
- scanner接受可注入budget与IO-observation port，使limit和retained bytes可以确定性测试；
- traversal过程中累计file/byte budget，读下一个payload前先做size预检，stable read后按实际bytes复检；
- 第一轮最多保留最终调用者确实需要archive/write的一份payload总量；
- 第二轮只生成排序后的`path/mode/size/sha256` manifest metadata，retained content不得超过单文件或单chunk；
- 禁止构造全树base64用于identity比较；
- snapshot/archive identity与当前静态fixture保持一致；
- 两轮之间的add/delete/mode/content变化使用既有stale/error taxonomy，不能因优化改成静默接受；
- allocation、promotion、origin verification和cleanup的approval后revalidation仍必须存在。

AS1是最高优先实现项；完成前不展开大范围模块移动。

### AS2 — Host composition and runtime attenuation

- 在product composition root一次创建`LocalApplicationHost`；
- adapter改为接收Host ports，不再import concrete factory；
- 合并process-local owner registries为显式`ActiveOwnerRouter`，记录state root/session/owner kind/parent operation；
- 移除adapter module-global lifecycle maps；
- 将`CliIO/OutputWriter`移到presentation-neutral contract；
- child、worker与domain owner不再依赖完整`CliRuntime`；
- durable origin/application-commit schema移入neutral contract；
- 每迁一类能力都保留原有authority attenuation负测。

### AS3 — Session evidence and run lifecycle

- 抽`ExactSessionEvidenceReader`并迁Graph/Delegation/session-resume重复reader；
- 消除`control-plane -> commands`依赖；
- 抽`RunCancellationLifecycle`并迁message/resume；
- 将`SessionRegistry`先拆为catalog与run lifecycle接口；
- recurring cancel observation不得每25ms全量扫描repository catalog；使用run-specific增量cursor、bounded notification或等价小范围读取；
- 一个writer critical section只做一次stable full projection，后续本次append使用incremental reducer或已算projection；
- query/action的strict result codec与error-to-exit mapping由Host contract统一拥有，surface不维护第二套schema和错误码拼写。

### AS4 — Production single path and TUI boundary

- product `CliRuntime`/Host配置中state root为必需；
- Goal/Plan -> Graph/Delegation -> Agent/chat/resume顺序删除production legacy write branch；
- legacy read、replay、adoption和old-session resume继续通过；
- direct owner unit/eval测试改用显式`DomainHarness`；
- intent schema移出TUI；
- 抽pure `TuiCommandParser`与`TuiApplicationFacade`；
- controller不再持有domain mutation、raw session writer或application composition authority；
- MCP/repository core不再import TUI module。

### AS5 — Terminal and projection ownership

- 抽纯error classification和terminal mapping；
- `RunTerminator`唯一负责before-terminal hook、error -> terminal、terminal publish与persistence fail-closed；
- `RunResourceScope.close()`幂等负责listener、MCP、capability、writer等resource cleanup；
- AgentLoop只返回typed outcome，不与outer execution重复发布同类terminal；
- TaskExecution消费已投影TaskGraph，scheduler transition不重复full replay；
- child cancellation从last sequence/cursor读取新增durable facts，启动或歧义恢复才full replay；
- 不把durable cancellation替换为纯AbortSignal。

### AS6 — Bootstrap and release efficiency

- `--version`与root help使用轻量bootstrap，不加载TUI、Docker、Eval、MCP、TypeScript repository engine或worker graph；
- command功能按需加载，Node runtime使用lazy feature factories；
- 每个OS job的full Vitest与build原则上各执行一次；focused gate复用machine-readable报告；
- 复用AS0.1的versioned evidence manifest与run receipts；删除required case即使总数仍够也必须失败；
- pack smoke复用同一build和同一实际tarball；可拆成多个可定位case，但不能用source tree替代installed package；
- built worker、child、ConPTY/PTY和process-tree tests继续单独opt-in运行，因为默认skip不能算证据；
- startup只比较固定机器上的cold/warm median与loaded-module contract，不设置跨机器绝对毫秒门槛。

## 7. Work package治理

### 7.1 依赖与启动顺序

```text
AS0.1 evidence contract
  -> AS0.2 characterization
  -> AS1.1 handoff CAS
  -> AS1.2 bounded scanner
  -> AS2.1 single Host
       -> AS2.2 runtime attenuation
  -> AS3.1 exact evidence reader
       -> AS3.2 cancellation lifecycle
       -> AS3.3 registry/projection read path
  -> AS4.1 product single path
       -> AS4.2 TUI boundary
  -> AS5.1 terminal ownership / AS5.2 projection ownership
  -> AS6.1 lazy bootstrap / AS6.2 CI and pack reuse
```

规则：

- AS0.1至AS5.1当前均为`local_gate_passed`；实现保持既有durable event、authority与effect-order合同，并由逐包receipt绑定；
- AS1至AS5.1已经按依赖顺序独立收口；下一次只允许启动AS5.2，不得顺带展开AS6；
- AS1的recovery/resource前置条件已经满足，Host、TUI与Agent边界迁移均已在后续独立包完成；
- AS4.1依赖AS2的Host boundary与AS3的shared lifecycle/evidence boundary；
- AS5.1至少依赖AS3.2，AS5.2至少依赖AS3.3；
- AS6可以测量和设计，但结构性修改等AS1–AS5稳定后再做，避免CI/启动变化掩盖行为回归；
- 维护者可以把某个包继续拆小，但不能跨越依赖或把两个durable protocol合成一次提交。

### 7.2 每个work package的必需合同

开工前必须在本文件或独立implementation note中写清：

1. `ID / Goal / Non-goals`；
2. `Inputs / Preconditions / Dependency receipts`；
3. `Touched modules / Explicitly excluded modules`；
4. `Durable compatibility / Reader-writer matrix`；
5. `Migration / Cutover / Rollback boundary`；
6. `Fault points / Unknown-effect policy`；
7. `Deliverables / Required evidence IDs / Exact commands`；
8. `Exit definition / Deferred follow-ups`。

缺少任一项时，该包保持`not_started`。实施中发现需要改变public schema、durable hash、authority taxonomy或跨越excluded modules时，立即停止并修改spec；不能把范围扩张隐藏在实现PR中。

### 7.3 通用Definition of Done

work package只有同时满足以下条件才能离开`in_progress`：

- required evidence IDs在编码前已登记，targeted cases全部通过且zero unexpected skip；
- 只解决一个recovery/resource/authority/boundary目标；
- compatibility、migration、rollback和negative/corrupt路径均有测试；
- 影响面的旧crash、cross-process、legacy、PTY、pack证据未被删除或弱化；
- lint、typecheck、build、`git diff --check`与package-specific gate通过；
- local evidence绑定dirty patch；最终`passed`绑定exact commit及所需Windows/Linux receipts；
- state/evidence同步更新，失败run作为历史保留，不用后一次成功覆盖失败事实；
- 没有默认skip冒充通过，也没有用wall-clock/RSS替代结构性boundedness证明。

### 7.4 第一个开工包：AS0.1

`AS0.1 — Evidence Contract and Gate Self-Test`的固定范围如下：

- Inputs：现有Phase21A gate、default Vitest、built worker/child/PTY opt-in、build与pack smoke identities；
- Candidate modules：`tests/evidence/architecture-simplification-v1.json`、`scripts/validate-architecture-simplification.mjs`、validator focused tests、`package.json`以及最小CI report/validator wiring；
- Excluded：`src/**` production behavior、durable files、CI去重、既有test semantic修改；
- Deliverables：strict manifest codec、report normalizer、receipt schema、validator、negative self-tests；
- Required negatives：missing、duplicate、renamed、pending、unexpected skip、wrong profile/platform、report hash mismatch、manifest hash mismatch；
- Rollback：删除新validator/manifest即可，不产生durable或product migration；
- Exact commands：`pnpm test tests/unit/architecture-simplification-evidence.test.ts --maxWorkers=1`；`pnpm architecture:gate -- --manifest tests/evidence/architecture-simplification-v1.json --receipt <receipt.json>`；
- Exit：validator能消费runner report/receipt，逐case给出pass/fail/missing/skip，并且不重新运行测试；Windows/Linux exact-commit CI均执行该validator。

AS0.1是`ready`规则的唯一bootstrap例外。以下bootstrap IDs现已原样进入tracked manifest；`tests/evidence/architecture-simplification-v1.json`从落地起就是机器authority，以下列表只保留为审计说明：

- `as0.1.manifest.valid`；
- `as0.1.manifest.missing-case-denied`；
- `as0.1.manifest.duplicate-id-denied`；
- `as0.1.manifest.renamed-case-denied`；
- `as0.1.manifest.unexpected-skip-denied`；
- `as0.1.manifest.wrong-profile-platform-denied`；
- `as0.1.receipt.report-hash-mismatch-denied`；
- `as0.1.receipt.manifest-hash-mismatch-denied`。

当前tracked manifest已扩展为102项：default 54项、built paths 12项、pack 1项、metric 35项。AS0.1 bootstrap时的2026-08-13本地Windows证据为：`pnpm check`通过（253 files passed、1192 tests passed、16个既有conditional skip），Phase21A 163/163且required skip为0，default receipt 54/54通过并复验；`pnpm pack:smoke`通过，pack receipt 1/1通过并复验；built-path真实档位在正常Windows process authority下完整执行18项并通过，required receipt 12/12通过并复验。Codex managed process sandbox会拒绝`taskkill /T`并使process-tree/PTY链产生`verified:false`或超时，因此该档位必须在保留零网络/零凭据边界的正常本地或CI process authority下运行，不能把sandbox权限失败误记为产品回归。

AS0.1本地gate通过后已经建立AS0.2具体baseline case；exact-commit CI尚未完成，因此两项都不能标`passed`，也不能用AS0.2测量结果冒充handoff修复。

### 7.5 后续starter boundaries

这些边界用于减少下一次开工的重新调查，但不把相应package提前标成`ready`。

**AS0.2 Characterization Baseline**

- Candidate modules：新的architecture report/metric helpers、dependency validator及focused tests；生产模块只允许注入不改变行为的observer/counter seam；
- Outputs：versioned JSON baseline、exact reproduction commands、patch-bound receipt；
- Excluded：修复handoff、改变scanner算法、改变poll interval、删除legacy path；
- Exit：AS1.1/AS1.2需要的fault points、hash goldens和deterministic metrics均已在manifest登记。

2026-08-13初始本地实现证据使用`architecture-simplification-characterization-v1.json`；随逐包迁移，当前authority为`tests/evidence/architecture-simplification-characterization-v3.json`，canonical SHA-256为`7e362f1a05856f504947e8e678bd202aa6578dc77550db7025061ad53e80db91`。v3固定0个dependency violation、V2 handoff/scanner/session read与poll指标、4组不变的Agent terminal goldens、8条显式DomainHarness surface route。metric profile现为35/35 required cases并由patch-bound receipt独立复验；同一exact commit的Linux/Windows receipts仍待CI。

**AS1.1 Handoff Revision CAS**

- Inputs：AS0.1/AS0.2 receipts与现有V1 handoff fixtures；
- Candidate modules：`src/background/background-schema.ts`、`src/background/background-operation-store.ts`、launcher/runtime/takeover的handoff consumers，以及Phase19D protocol/takeover/crash tests；
- Excluded：session event taxonomy、workspace scanner、Application Host、`CliRuntime`、Delegation protocol；
- Deliverables：V2 strict codec、revision-chain reader、atomic no-replace publisher、V1/V2 selector、read-only legacy diagnostic；
- Exit：new operation零`.handoff.lock`，same revision恰一winner，publish后response loss可exact恢复，各fault prefix重启后不永久busy，legacy异常零自动mutation。

**AS1.2 Bounded Workspace Scanner**

- Inputs：AS0.2 snapshot/archive hash goldens与retained-byte baseline；
- Candidate modules：`src/worktrees/workspace-baseline.ts`及直接使用capture结果做revalidation的worktree callers、new focused scanner/worktree tests；
- Excluded：manifest/event schema、archive语义、approval流程、Host/runtime重构；
- Deliverables：shared traversal、materialize consumer、manifest-only verify consumer、injectable limits/IO observer；
- Exit：durable hashes byte-identical，limit在payload读取前后均执行，second pass无整树bytes/base64，全部stale/unsafe/worktree regressions通过。

### 7.6 AS1.1–AS5.1本地实施结果

- AS1.1：new background operation使用V2 hash-linked revision CAS，不再创建`.handoff.lock`；legacy V1仅按固定兼容矩阵读取，异常lock不自动删除；
- AS1.2：workspace capture改为遍历时pre/post-read budget与manifest-only二次验证，snapshot/archive identity保持兼容；
- AS2：每个`stateRoot`只有一个可dispose的Application Host；domain/runtime改用窄ports与显式`DomainHarness`，不再把`CliRuntime`作为owner service locator；
- AS3：Graph、Delegation与resume共享strict raw JSONL evidence reader；message/resume共享run cancellation lifecycle；SessionRegistry对外拆为catalog、run owner/cancel与projection read ports，但durable journal taxonomy不变；
- AS4：product mutation只走ApplicationService，legacy mutation仅存在于显式DomainHarness；TUI command parser为纯函数，controller只调用typed facade，不持有writer/composition authority；
- AS5.1：`RunTerminator`唯一拥有terminal Hook与durable terminal publication，`AgentLoop`只返回typed outcome；`RunResourceScope`幂等关闭listener、MCP、capability lease与writer，persistence failure后禁止补写terminal；
- 本轮不实施AS5.2；scheduler/projection增量化与child tail cursor仍按下一工作包验收。

## 8. Compatibility、migration与rollback

### 8.1 全局规则

- durable cutover始终只有一个writer protocol；禁止V1/V2双写；
- new reader可以读取明确列出的old format；new writer失败时不得退回legacy mutation；
- Host或adapter构造失败必须fail closed，不能以“保持可用”为由走direct write；
- mixed-version、partial-prefix、corruption和owner unknown必须有显式结果；没有规则就拒绝写；
- rollback只能回到仍理解当前durable state的版本。写入新format后，不支持旧writer的代码回滚；只能forward-fix或read-only downgrade；
- 任何会改变persisted event、record reference、ledger ID、sequence或identity hash的优化，都需要独立format migration spec。

### 8.2 Migration matrix

每个涉及durable或product cutover的work package必须填写以下矩阵：

| Item | Old reader/writer | New reader/writer | Cutover marker | Mixed-version behavior | Rollback截止点 | Corrupt/partial behavior |
|---|---|---|---|---|---|---|
| AS1.1 handoff | V1 `handoff.json` + legacy lock | V1 reader for active V1；new operation使用V2 revision chain | `handoff-v2/revision-000000000000.json` | V1 operation保持V1；V2 operation禁止V1 writer | first V2 publish之前 | gap/fork/hash/partial target fail closed；unreferenced candidate忽略 |
| AS1.2 scanner | current manifest V1 | same manifest V1；streaming/bounded internals | none | byte-identical output | 任意时刻代码回滚 | stale/unsafe/limit继续使用既有错误taxonomy |
| AS2 Host | adapter-local composition | one process/state-root Host | command/surface cutover table | 同一mutation只允许新Host path | 每个surface删除fallback之前 | Host unavailable即无mutation |
| AS3 registry/lifecycle | one `CatalogJournal` implementation | split interfaces/shared lifecycle，仍写同一journal | none | exact same record kinds/references | 任意时刻代码回滚 | 原有projection/corruption规则 |
| AS4 product path | ApplicationService + production legacy fallback | ApplicationService only；legacy read/harness保留 | per command/surface gate | 已切mutation不得回退direct write | 删除该surface fallback之前 | Host failure返回typed nonzero/diagnostic |

### 8.3 Handoff V2固定决策

- V2 authority位于operation目录下独立的`handoff-v2/`；revision filename使用十二位zero-padded nonnegative safe integer，`revision-000000000000.json`是protocol marker；V1 `handoff.json`与任一V2 revision同时存在视为corrupt；
- genesis revision固定`revision = 0`、`previousRevisionSha256 = null`，并包含完整strict launch descriptor与initial handoff payload；它必须在child spawn、session append或其他外部effect之前发布；
- crash在genesis publish之前时，没有V1/V2 authority且不得已有外部effect；只有仍持有exact genesis/transition identity的creator可重试，其他恢复者只能把该operation视为non-authoritative orphan并开始新的operation；crash在genesis之后时，reader明确选择V2并可从genesis重建launch observation，不存在protocol判定空窗；
- contiguous revision chain是authority；可选head cache只能验证后使用，不能取代chain；
- `recordSha256`计算canonical identity content，不递归包含自身；
- immutable candidate必须完整写入并fsync后才可atomic no-replace publish；target一旦可见必须是完整strict record；
- candidate位于非authority的content-addressed candidate目录；reader忽略未被revision path发布的candidate，AS1不以自动GC为完成条件；
- no-replace publication必须封装成窄Host filesystem primitive，并在Windows与Linux真实文件系统证明不覆盖existing target；不支持该primitive的filesystem直接fail closed；
- two contenders发布同一revision时恰一winner；loser读取winner，只有相同`transitionId`与content才返回idempotent success，否则conflict；
- 进行中的V1 operation不升级；legacy ownerless lock只由doctor报告，不自动unlink/quarantine；
- 不能承诺早于V2 guard的旧binary理解V2；一旦state root产生V2，运维规则禁止旧binary写该state root。

### 8.4 Host与surface cutover表

AS2/AS4对每个command/surface维护一行：

| Surface/action family | Legacy read | Legacy write | Host read/query | Host mutation | Preconditions | Failure result | Rollback target |
|---|---|---|---|---|---|---|---|

迁移顺序为Goal/Plan、Graph/Delegation、Agent/chat/resume、TUI。每行在CLI/TUI parity、legacy read/adopt/resume与exact application/domain binding通过后，才删除该production mutation fallback。回滚目标只能是上一个ApplicationService实现，不能恢复direct writer作为故障降级。

### 8.5 Session lifecycle边界

- AS3只拆接口和共享算法，继续使用现有`CatalogJournal`、record kinds、schema version、hash chain、`ledgerId`、sequence和reference semantics；
- `RunCancellationLifecycle`必须覆盖`register -> started -> request -> session-bound -> signal -> terminal -> close`；
- 每个前缀定义replay结果、是否可再次signal、怎样验证exact binding、何时只能unknown/block；
- signal最多一次；terminal/close可按exact evidence幂等收口，但不能根据broker absence制造terminal；
- 物理journal分拆不属于当前spec。若测量仍证明必要，另开migration spec，包含epoch marker、combined projection与禁止旧writer规则。

## 9. Mechanical acceptance matrix

| Work package | Blocking evidence |
|---|---|
| AS0.1 Evidence contract | validator negative self-tests；exact case/profile/platform；manifest与receipt hash binding |
| AS0.2 Characterization | import graph、fault-point inventory、route inventory、terminal golden、deterministic scanner/replay/read counters的JSON baseline |
| AS1.1 Handoff CAS | publish前/后、return前、domain append前/后的crash/response loss；双进程single winner；corrupt/gap/fork/unknown owner；legacy lock零删除；Windows/Linux |
| AS1.2 Bounded scanner | manifest/archive hash golden；pre-read/post-read limit；second-pass retained bound；add/delete/mode/content/symlink/hardlink/path拒绝；worktree lifecycle regression |
| AS2.1 Host lifecycle | same process/state-root Host count=1；adapter共享；dispose一次；dispose后owner/router零残留 |
| AS2.2 Runtime attenuation | dependency gate；owner/child/worker零`CliRuntime`依赖；capability negative tests；existing authority attenuation |
| AS3.1 Exact evidence | Graph/Delegation/resume同fixture一致；invalid UTF-8、duplicate key、seq gap、raw hash/head mismatch、concurrent append |
| AS3.2 Cancellation | message/resume同一lifecycle trace；request-before-signal；binding；response loss；signal once；close once |
| AS3.3 Registry/projection | idle observation的catalog full-scan delta=0；writer critical section full projection<=1；歧义恢复允许bounded full read |
| AS4.1 Product path | AST/import gate无production undefined-root mutation fallback；CLI/TUI binding parity；legacy read/adopt/resume |
| AS4.2 TUI boundary | pure parser table；facade parity；controller无writer/composition authority；Windows ConPTY/Linux PTY golden |
| AS5.1 Terminal ownership | cancel/budget/provider/tool/storage/Hook/TUI-fatal event、exit、hook-order table；persistence error后零补写；cleanup幂等 |
| AS5.2 Projection ownership | scheduler mutation initial reconstruction<=1；idle child exclusive full snapshot delta=0；cursor ambiguity recovery |
| AS6.1 Lazy bootstrap | isolated loaded-feature IDs；version/help denylist；stdout/stderr/exit golden；AS0冻结后的相对startup observation |
| AS6.2 CI/pack | 每OS full suite/build各一次；default skip由same-platform exact opt-in补偿；同一dist inventory与tarball SHA贯穿pack |

## 10. 项目级回归证据

任何item标记完成前，至少保留与其影响面相称的以下证据：

- lint、typecheck、targeted unit/integration、build与`git diff --check`；
- Phase21A action/query、prepared action、multi-process CAS、cross-store crash与response-loss；
- active owner、run/Graph/Delegation cancel与TUI surface-fatal provenance；
- legacy adoption、old-session replay、seq0 materialization；
- foreground/background Graph、worktree allocation/promotion/cleanup；
- controlled child authority attenuation、receipt、budget、cancel与process-tree cleanup；
- Windows/Linux PTY/ConPTY、resize、Ctrl+C与parent shell restoration；
- zero-network/credential tripwire；
- installed tarball及exact runtime asset smoke。

不在某个item影响面内的昂贵evidence可以在exact-commit CI运行，但不能永久删除或改成默认skip后仍宣称完整通过。machine-readable manifest列出的blocking case优先于本节文字清单。

## 11. 状态与完成规则

- 当前总状态为`AS0.1–AS5.1 Local Gate Passed / Exact-Commit CI Pending`；本地receipt只能证明当前patch，尚未获得同一exact commit的Linux/Windows CI receipts，故不标`passed`；
- 下一工作包为`AS5.2 Projection Ownership`，状态`ready`但未开始；AS6.1与AS6.2仍为`not_started`；
- work package状态使用`not_started | ready | in_progress | local_gate_passed | passed | deferred_by_evidence`；
- `ready`表示输入、依赖和evidence IDs齐全；`local_gate_passed`只绑定本地patch receipt；`passed`只绑定exact-commit CI；
- AS0–AS6逐包记录状态，不得用一个总百分比替代；
- 每个item独立提交、独立证据、可独立回退；禁止big-bang rewrite；
- 若真实测量否定某个性能假设，该优化可以`deferred_by_evidence`，但correctness、authority、durable compatibility和dependency inversion项不能用“当前个人规模较小”跳过；
- 全文不会产生Phase 22或新M12状态；完成项回写[`Personal Open-Source Maintenance Roadmap`](personal-open-source-maintenance-roadmap.md)，并把下一项重新交给真实使用证据排序。

| Work package | Current status |
|---|---|
| AS0.1 Evidence contract | `local_gate_passed` |
| AS0.2 Characterization | `local_gate_passed` |
| AS1.1 Handoff revision CAS | `local_gate_passed` |
| AS1.2 Bounded scanner | `local_gate_passed` |
| AS2.1 Single Host | `local_gate_passed` |
| AS2.2 Runtime attenuation | `local_gate_passed` |
| AS3.1 Exact evidence reader | `local_gate_passed` |
| AS3.2 Cancellation lifecycle | `local_gate_passed` |
| AS3.3 Registry/projection read path | `local_gate_passed` |
| AS4.1 Product single path | `local_gate_passed` |
| AS4.2 TUI boundary | `local_gate_passed` |
| AS5.1 Terminal ownership | `local_gate_passed` |
| AS5.2 Projection ownership | `ready` |
| AS6.1 Lazy bootstrap | `not_started` |
| AS6.2 CI and pack reuse | `not_started` |
