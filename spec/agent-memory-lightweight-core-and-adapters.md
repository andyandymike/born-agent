# BornAgent Lightweight Memory Core and Frontier Adapters Spec

> Status: Active implementation contract（updated 2026-08-26）
> Current slice: ML3 local-backend safe automatic recall `implemented` and Windows local product/full/pack gates passed; Agent default remains `off`, remote provider injection remains zero; `preview_usable`仍等待同一exact commit的Linux/Windows CI evidence
> Product boundary: local, single-user, repository-scoped, cross-session memory
> Explicit non-claim: this document does not complete AM2–AM6, Memory v1, user lifecycle, remote disclosure, or frontier adapters

## 0. 文档地位

本 spec 把 [`Agent Memory 学习与交付路线`](../docs/agent-memory/learning-and-delivery-track.md) 中的“轻核心、多实验适配器”落实为可实现合同。它有两个目的：

1. 尽快让 BornAgent 获得真正可观察的跨 session 长期记忆；
2. 让 embedding、graph、consolidation、procedure、reflection 等先锋方向可以大量实验，但不会把每个实验永久写进主架构。

文档权威按下列顺序理解：

1. 当前用户指令与既有 Host security/authority/effect contract；
2. `ROADMAP.md` 选择当前路线；
3. learning track 决定切片顺序、学习问题、预算与 stop condition；
4. 本 spec 决定 Memory Lite 的数据、端口、行为与机械验收；
5. live code、tests、CLI evidence 和 exact-commit CI 决定已经实现了什么；
6. `agent-memory-and-context-maintenance.md` 仅为本地 exhaustive research/threat-model 参考，不构成当前 backlog 或完成百分比。

本 spec 只能收窄当前切片，不能借“未来兼容”扩张它。未来实验如需改变核心 schema、authority 或 source-of-truth，必须另写 amendment，不得在 adapter 内暗改。

## 1. 产品承诺：记什么、何时用、怎样变化

### 1.1 Memory Lite 存什么

Memory Lite 不复制整段对话，也不保存 hidden chain-of-thought。原始 session JSONL、artifact、Outcome、当前 repository source 继续是 evidence；memory 只保存一小条可检索记录和精确来源。

| Kind | Memory Lite v1 target内容 | Producer | 何时使用 |
|---|---|---|---|
| `episode` | 一次 terminal task 的目标、结果、可观察验证与 source range | Host 的 deterministic builder | 找回“之前做过什么、结果怎样、去哪里看证据” |
| `fact` | 用户明确要求保存的事实 | `born memory remember` | 回答历史事实；若涉及当前代码，使用前仍 fresh read |
| `preference` | 用户明确保存的工作偏好 | `born memory remember` | 作为 historical preference 提醒，不恢复当前 authority |
| `decision` | 用户明确保存的项目决定 | `born memory remember` | 帮助定位过去选择与来源，不覆盖当前指令 |
| `constraint` | 用户明确保存的项目约束 | `born memory remember` | 提醒当前 Agent 复核；不等同 system policy |

`procedure`、模型自动抽取的偏好、reflection、graph edge 和 embedding 不属于首版 canonical record。它们先作为实验 candidate 或 derived index 存在，只有独立证据支持时才可能晋级。

### 1.2 对话是否产生记忆

会，但不是“每句话都写入长期记忆”。

- 当前对话仍由现有 session store 保存和恢复；这属于 session history，不等于长期 memory。
- ML1 只在 terminal safe point 从 completed agent session 生成一条 deterministic episode。
- ML4 才增加用户明确 `remember` 的 fact/preference/decision/constraint。
- 模型自动从普通对话提炼记忆只允许进入实验 candidate，默认不成为 active memory。

### 1.3 Memory 会不会增长、会不会改变

- canonical memory会随ML1 episode rows与ML4 explicit revisions增长，但有record/byte hard cap；达到上限时停止自动写入并返回typed capacity error，不无限扩张。
- ML1 episode 写入后不原地改写。ML4引入显式记忆时，变化再通过 `SUPERSEDE` 新 revision或 `RETRACT` operation表达。
- FTS、embedding、graph和summary是可删除、可重建的projection；adapter candidate是可丢弃实验数据，删除不改变core logical state，但不承诺零成本重建。
- 每次 provider request 实际使用的 memory 有 top-k、text bytes 和 token budget；不会把全部历史不断塞进 prompt。
- `retract` 表示停止 active recall，不等于物理删除原 session/artifact；产品不得把它命名为 secure erase。

### 1.4 什么时候使用

```text
write path
  ML1 completed Session A; ML4 explicit user command
    -> validate scope/source/secret/bounds
    -> ML1 episode row; ML4 record revision + lifecycle operation
    -> ML2/ML4 rebuildable active/FTS projection

read path
  Session B current query
    -> hard principal/repository filter
    -> concrete bounded lexical search service
    -> source/status revalidation
    -> bounded Host-rendered historical excerpt in ContextPlan
    -> historical_only or untrusted_content provider context
```

ML1 只完成 write path 与 CLI inspection；ML2 完成检索；ML3 才允许 Agent 使用。内部组件或 benchmark 不能替代这个顺序中的用户可观察行为。

## 2. 设计目标与明确不做

### 2.1 必须实现

1. 完全退出进程后，同principal、同canonical repository root的新session仍能读取active memory。
2. 每条 record 都有精确 source、scope、origin、status 和 content hash。
3. mode `off` 是默认值；普通agent off path不打开memory DB、不执行hidden retrieval、不改变ContextPlan/ModelRequest。显式`born memory ...`管理命令除外。
4. 先做 exact/lexical/temporal baseline，再以相同 corpus 比较 embedding、graph 或 model-assisted adapter。
5. 用户可 `status/list/show/search --explain/remember/retract/rebuild/doctor`。
6. derived adapter 可以独立禁用和删除；基础 record/list/show/retract 仍工作。
7. 每个切片同时留下 product、engineering、learning 和 time proof。

### 2.2 首版明确不做

- user-global、跨 repository、team、cloud 或跨设备 memory；
- background daemon、remote vector database、sync、backup/import/export；
- remote provider 的 private memory 自动披露；
- TUI memory panel、legacy `born chat`、child/subagent memory；
- 模型自动写入 active preference/constraint；
- 自动把 procedure 安装为 Skill/Plugin 或授权任何 effect；
- at-rest encryption、secure erase、物理 source deletion；
- old/new binary mixed-writer protocol、分布式 lease、企业级全 crash matrix；
- 为尚不存在的 adapter 预留 canonical 字段或通用 framework。

### 2.3 六条不可破坏的不变量

1. **Off equivalence**：普通agent execution的memory off路径与现有行为等价，且不创建store；显式memory管理命令不属于该baseline。
2. **Explicit mutation**：模型没有 active memory write/retract tool；canonical mutation 仅来自 Host deterministic episode 或当前用户的本地显式命令。
3. **Scope before score**：principal/repository hard filter 必须发生在 ranker、embedding、graph 或 LLM 之前。
4. **Authority attenuation**：recall 只能是 `historical_only` 或 `untrusted_content`；不能恢复旧 instruction、approval、provider/tool selection、completion 或 effect authority。
5. **Verify before use**：inspection、search与request prepare前重验active status和source；missing/tampered/retracted record返回typed stale，不拿摘要冒充evidence。
6. **Hard bounds**：store、record、candidate、recall count、recall tokens和injected bytes全部有硬上限。

## 3. 小核心与多适配器

### 3.1 稳定核心只拥有这些能力

- 当前切片实际使用的最小record与strict codec；正式`MemoryRecordV1`只在ML4有producer、consumer和migration时冻结；
- local SQLite store、schema migration 与 logical dump；
- existing local principal + Application repository registration + canonical root identity scope；
- deterministic episode 与 explicit user admission；
- episode ingest、capacity和source verification；ML4再增加supersede/retract；
- concrete lexical search、bounded recall selection 与 authority attenuation；
- CLI inspection、rebuild、doctor 和 benchmark harness。

稳定核心不理解 vector、graph、LLM prompt、procedure 或 Skill。它只接受经过 strict validation 的 record/candidate/hit/view，并重新执行 scope、source 和 bounds 检查。

### 3.2 Adapter 只能拥有派生能力

| Adapter family | 输入 | 输出 | 是否可写 active core |
|---|---|---|---|
| extractor | bounded verified source | candidate | 否 |
| retriever/ranker | 已完成 hard-scope filter 的 summaries | ranked record IDs + reason | 否 |
| view/folding | exact source refs + budget | derived view/placeholder | 否 |
| consolidator | active records + recurrence evidence | supersede proposal | 否 |
| procedure miner | verified outcomes | procedure candidate | 否 |
| reflection | bounded trajectory | learning candidate | 否 |

Adapter 不获得 store transaction、session writer、Application mutation、approval、tool execution 或 provider credential。Adapter crash、timeout、invalid output 或被删除时，系统回到 deterministic builder + exact/FTS baseline。

### 3.3 不提前建立 framework

- ML1 直接实现第一个 SQLite store；第二个真实 store 出现前不建立 store plugin registry。
- ML2 直接实现 concrete `LexicalMemorySearchService`；第二个真实 ranker 实验证明有价值后才抽最小接口。
- 每个持久化字段必须同时有当前 producer、consumer 和 required assertion；缺一即删除。
- 每个 adapter 一条清晰目录边界、一个 manifest/card、一个开关；不新增常驻进程。
- adapter-specific schema 放在 adapter namespace，可整目录删除；不能修改 canonical table 才能卸载。

## 4. ML1 exact domain contract

本节只冻结ML1真正有producer、consumer和required assertion的episode-only合同。`fact/preference/decision/constraint`、revision、supersede、retract和通用adapter接口留到对应切片，不预埋字段。

### 4.1 Scope

```ts
interface Ml1MemoryScopeV1 {
  readonly ownerPrincipalId: string;
  readonly applicationRepositoryId: string;
  readonly canonicalRootIdentitySha256: string;
}
```

- `ownerPrincipalId`复用现有local owner principal identity，并与`run.started.data.application_commit.principal_id`exact match。
- `applicationRepositoryId`与`canonicalRootIdentitySha256`来自现有`RepositoryRegistry`同一active registration；Host按current canonical root解析后注入`MemoryService`。
- current root必须exact命中一个active registration；零个返回`memory_repository_unregistered`，多个返回`memory_scope_ambiguous`，不得自动register。
- ML1只读取现有Repository/Session registry identity，不新增Phase21A action/query kind、resource scope、principal scope或registry migration。
- legacy session缺少任一identity时不产生episode；不得根据用户名、路径、目录名或Git remote猜测。
- v1因此把不同canonical checkout/worktree视为不同scope。是否共享到Application repository是未来真实需求，不是ML1前置。

### 4.2 Exact session range

```ts
interface Ml1SessionRangeSourceV1 {
  readonly kind: "session_run_range";
  readonly sessionId: string;
  readonly runId: string;
  readonly startEventId: string;
  readonly startSequence: number;
  readonly startRawSha256: string;
  readonly endEventId: string;
  readonly endSequence: number;
  readonly endRawSha256: string;
  readonly rangeSha256: string;
}
```

Source只能由现有`ExactSessionEvidenceReader`的stable two-read、strict decode和raw-line hashes构建。`SessionRegistry`在`applicationRepositoryId`内定位`sessionId`，`RepositoryRegistry`提供host-internal canonical root；若catalog、source file或exact identity不可用，admission拒绝，读取时标`stale`。

`rangeSha256`固定为下列canonical value的SHA-256：

```ts
sha256Canonical({
  schema_version: 1,
  session_id: sessionId,
  run_id: runId,
  records: eventsInInclusiveSessionRange.map((event) => ({
    event_id: event.eventId,
    sequence: event.sessionSeq,
    raw_sha256: exactRawSha256ByEventId.get(event.eventId),
  })),
});
```

range从matching `run.started`开始，到同一`runId`的`run.completed`结束，并按session sequence包含两者之间的每一条stored event；该run的全部events都必须落在range内。读取时重新计算整个preimage；只比较terminal hash不算source verification。

### 4.3 Episode record

```ts
interface Ml1EpisodeRecordV1 {
  readonly schemaVersion: 1;
  readonly recordId: string;
  readonly kind: "episode";
  readonly origin: "deterministic_episode";
  readonly scope: Ml1MemoryScopeV1;
  readonly source: Ml1SessionRangeSourceV1;
  readonly taskInputSha256: string;
  readonly taskPreview: string;
  readonly completion: Readonly<{
    mode: "model_final" | "plan_ready" | "verified_finish_task";
    evidenceSha256: string | null;
    reportSha256: string | null;
    steps: number;
    toolCalls: number;
  }>;
  readonly text: string;
  readonly occurredAt: string;
  readonly recordSha256: string;
}
```

生成条件全部满足才返回record：

1. exact range第一条是`command=agent`的`run.started`，最后一条是同一run的`run.completed`；
2. existing strict reconstruction把该run证明为`completed`，没有pending/unmatched tool call或unknown effect；
3. scope identity存在，session catalog的repository与run application principal均与current ML1 ingestion scope exact match；
4. terminal是该run最后一条event，`completion_mode`存在；
5. task input与canonical record通过pre-admission secret/non-persistable scan；命中时整条skip，不先写后清洗；
6. source与record均在logical bounds内。

Canonical task preview：原`run.started.data.input.text`先做NFC、CRLF/CR到LF、首尾trim；最多保留2,048 UTF-8 bytes并在Unicode scalar边界截断，截断时追加`…`。`taskInputSha256`始终hash原始UTF-8 input，不hashpreview。

`text`严格使用下列LF模板，不加入model自由摘要、changed paths、tool output、artifact body或rebuild时间：

```text
Task: <taskPreview>
Outcome: completed
Completion mode: <completion.mode>
Steps: <decimal steps>
Tool calls: <decimal toolCalls>
Evidence: <evidenceSha256 or none>
```

- `occurredAt` exact复制terminal UTC timestamp。
- `recordId = "episode_" + sha256Canonical({ schema_version: 1, scope, source })`。
- `recordSha256`覆盖除自身外全部canonical fields。
- 相同scope/source重复构建必须byte-equivalent；不同wall clock、进程或SQLite page layout不得改变结果。

### 4.4 ML1 store port

```ts
interface Ml1EpisodeStorePort {
  ingestEpisode(record: Ml1EpisodeRecordV1): Promise<
    | Readonly<{ status: "inserted" }>
    | Readonly<{ status: "already_present" }>
  >;
  getEpisode(input: Ml1EpisodeGetInputV1): Promise<Ml1EpisodeRecordV1 | null>;
  listEpisodes(input: Ml1EpisodeListInputV1): Promise<Readonly<{
    items: readonly Ml1EpisodeRecordV1[];
    nextCursor: string | null;
  }>>;
  logicalDump(scope: Ml1MemoryScopeV1): Promise<Ml1EpisodeLogicalDumpV1>;
}
```

ML1没有generic `add`、operation ledger、update、retract、search、rebuild或adapter port。`ingestEpisode`是唯一transaction入口：相同ID+hash为idempotent no-op，相同ID+不同hash为`memory_store_corrupt`，不能覆盖。

所有get/list SQL都必须包含exact scope predicate。List顺序固定为`occurredAt DESC, recordId ASC`，limit为1–100；opaque cursor绑定scope与最后一对`occurredAt/recordId`，malformed或foreign-scope cursor strict reject。

### 4.5 ML1 golden fixture

ML1 manifest必须至少固定一个完整、无secret、`verified_finish_task`的agent run：

- exact `run.started` task为`Update README and run pnpm check`；
- terminal `run.completed`包含固定steps/tool_calls/evidence/report hashes；
- fixture保存每条raw JSONL hash、range hash、task preview、record ID、record canonical JSON和record hash；
- mutation variants覆盖duplicate ingest、wrong scope、missing line、changed raw byte、future schema、incomplete run和mode off。

实现不得先根据代码输出更新golden；若preimage合同需要改变，先修改本spec并说明原因。

### 4.6 Admission owner and failure boundary

- Episode ingest不能放进`beforeTerminal`，因为此时`run.completed`尚未durable。
- 普通`--memory local`路径只在`RunTerminator`确认terminal已经persisted后，由agent execution owner调用exact reader与`MemoryService.ingestCompletedRun()`；正常返回前等待SQLite transaction结束。
- `--memory off`不构造该service或打开DB。
- terminal已落盘后若memory read/write失败，原run仍保持原terminal与exit semantics；用户必须看到typed `memory_ingest_failed` diagnostic，store不得留下half row。
- ML1不承诺session ledger与SQLite跨store原子提交。若进程恰好死在terminal commit与episode commit之间，结果可以是“terminal存在、episode缺失”，不能是partial/corrupt episode；ML4 `rebuild`再负责扫描和补齐。该边界不能冒充full crash recovery。

## 5. Storage 与 bounds

### 5.1 SQLite layout

ML1在现有private state root下使用一个`memory/v1/memory.sqlite3`，不写repository working tree。SQLite负责transaction、crash recovery与single-machine writer serialization；BornAgent不再自研多文件two-phase publication。

ML1只创建：

- `episode_records`：`record_id` primary key、三列exact scope key、`occurred_at`、`record_sha256`、strict canonical JSON bytes与`canonical_bytes`；
- `metadata`：唯一`schema_version=1`。

`episode_records`只为`(owner_principal_id, application_repository_id, canonical_root_identity_sha256, occurred_at DESC, record_id ASC)`建立core index。读取canonical JSON后必须再跑strict codec并核对columns/hash/byte count，不能只相信SQL columns。

Store启用`foreign_keys=ON`、`journal_mode=WAL`、`synchronous=FULL`和bounded busy timeout；每次ingest使用一个`BEGIN IMMEDIATE` transaction。Busy返回typed `memory_store_busy`，不做无限retry。数据库路径不存在时可创建；路径存在但header/schema/integrity无效时fail closed，禁止rename-and-replace或猜测性新建。

ML2确认FTS5 probe后，在scope-bound derived DB中增加`episodes_fts`；canonical ML1 DB与`schema_version=1`不迁移。ML4开始前另写migration delta，届时才决定正式record revisions、operations与active projection；这些不是ML1 hidden schema。

实验adapter不得在canonical DB内建表。其index/candidate位于`memory/adapters/<adapter-id>/<version>/`独立derived store，整目录删除不得改变core logical dump。

Domain只依赖`Ml1EpisodeStorePort`，不传播`node:sqlite`类型。ML1 preflight只要求Node 22.19+ Windows/Linux与packed CLI的`node:sqlite` open/transaction/reopen probe；FTS5属于ML2。若SQLite probe失败，停止并修订存储决定，不静默加入native dependency或同时维护两套canonical store。

验收比较canonical logical dump/hash，不比较SQLite文件bytes、page order或WAL bytes。

### 5.2 Hard bounds by slice

| Dimension | Introduced | Default | Hard behavior |
|---|---|---:|---|
| ML1 episode canonical bytes | ML1 | 8 KiB | admission reject |
| ML1 total episode records | ML1 | 10,000 | automatic ingest stops |
| ML1 total logical canonical bytes | ML1 | 64 MiB | automatic ingest stops |
| list page | ML1 | 100 | stable cursor required |
| lexical candidates | ML2 | 100 | truncate before later ranker |
| manual search results | ML2 | 20 | stable ordered prefix only |
| manual search text | ML2 | 16 KiB | stop before the next hit |
| manual search estimate | ML2 | 4,096 tokens | UTF-8 conservative estimate; stop before the next hit |
| selected records | ML3 | 3 | never exceed |
| injected context | ML3 | min(1,024 tokens, 8%) | current protected context wins |
| explicit/revision capacity | ML4 | spec delta required | retract reserve must be defined then |

ML1 capacity只按strict canonical JSON UTF-8 bytes和row count机械执行；SQLite DB、WAL与page bytes只观测并由`status`报告，不能拿不稳定的physical file size充当admission truth。默认值可以在后续spec delta基于真实使用调整，但配置不得超过code hard maximum。

### 5.3 Sensitive content admission

首版拒绝已知 token、private key、credential、cookie、raw environment dump 和显式 `non-persistable` content。Redaction不能把“先写入再清洗”变安全：ML1命中时整条episode skip；ML2以后secret scan仍必须发生在canonical transaction和FTS insert之前。

Memory Lite 只声明 local private storage，不声明 encryption 或 secure erase。ML3 automatic recall 只支持 loopback/local backend；remote provider 看到的 memory records 必须为 0，直到单独 disclosure spec 存在。

## 6. Retrieval 与安全使用

### 6.1 Deterministic lexical baseline

ML2 固定执行：

1. exact principal + canonical root + available episode SQL filter；ML4后再扩展active lifecycle status；
2. exact ID/quoted term match；
3. FTS5 lexical score；
4. deterministic recency tie-break；
5. top-k 与 text/token admission；
6. source verification；
7. 返回 selection reason 与 score components。

失败或得分不足时 abstain。Embedding、graph 或 LLM rerank 不得成为 lexical baseline 的隐式依赖。

#### 6.1.1 ML2 frozen retrieval contract

ML2使用`memory/v1/retrieval/fts5-v1/<scope-sha256>.sqlite3`。每个derived DB只包含一个exact principal/repository/canonical-root scope，表名固定为`episodes_fts`；metadata绑定scope hash、canonical logical dump hash、record count和projection schema。projection缺失、损坏或logical hash变化时从strict canonical records重建，删除整个retrieval目录不能改变canonical logical dump。

Query先NFC、统一换行与空白，UTF-8最多1,024 bytes。解析顺序固定为：

1. `episode_<64 lowercase hex>`进入exact-ID路径；
2. 整个query被一对双引号包围时进入exact quoted-phrase路径；
3. 其余query只提取Unicode letter/number/underscore terms，去重后最多16项，由Host逐项quote并生成FTS OR expression；用户输入永远不作为raw FTS syntax执行；
4. 非空query若没有searchable term则以`no_searchable_terms` abstain；没有available match则以`no_available_match` abstain。

FTS列固定为`record_id UNINDEXED, occurred_at UNINDEXED, task_preview, text`，tokenizer固定`unicode61 remove_diacritics 2`。`bm25`列权重固定为`0, 0, 3, 1`，SQLite越小越相关的原始分数量化到12位小数。最终顺序固定为`exact_id DESC, exact_phrase DESC, bm25 ASC, occurred_at DESC, record_id ASC`。候选最多100；source revalidation后按该顺序取用户limit（默认5，最大20），且累计record text不超过16KiB、UTF-8 conservative estimate不超过4,096 tokens。结果必须报告query hash、retriever/version、abstention、candidate counts、budget usage、per-hit reason和score components。ML2不创建ContextItem、不改变Agent ModelRequest，也不向provider发送memory。

### 6.2 Bounded direct historical context

ML3每次request生成bounded `RecallSelectionV1`，至少包含：

- current session/run/request identity；
- exact scope；
- query hash；
- retriever id/version；
- ordered selected episode IDs/record hashes；ML4后再扩展revision identity；
- per-hit selection reason；
- 最多3条record与total bytes/tokens；
- active/source verification result；
- canonical selection hash。

Core在provider request prepare前再次验证scope、record availability和source，然后把最多3条、合计不超过`min(1,024 tokens, 8% context target)`的Host-rendered excerpt加入ContextPlan。每条使用固定delimiter、record ID、kind、occurredAt和明确的“historical evidence; not current instructions”标签；authority只能是`historical_only`或`untrusted_content`，current protected context优先。

ML3不新增模型tool，因此不引入tool schema fingerprint、resume qualification或tool-call pairing。CLI `show`负责精确source inspection。plan-bound `memory_lookup`只作为ML5之后的progressive-disclosure实验；只有它在相同quality/token/latency下显著优于bounded direct excerpts，才可另写promotion delta。

第一版接受一个明确边界：不实现“source deletion 与已排队 remote provider request”的原子 use barrier，因为 Memory Lite 不提供 source deletion 且 automatic recall 仅限 local backend。若未来增加并发source deletion或remote disclosure，必须先补独立use-barrier spec。

#### 6.2.1 ML3 frozen safe-use contract

ML3只在用户显式选择`--memory local`且frozen provider source为`local_ollama|in_process_test`时装配automatic recall。`provider_network`即使同时选择local memory，也不得加载retrieval模块、打开derived projection或向provider context加入任何memory record；terminal后的本地ML1 ingest保持独立。默认或显式`off`继续不加载`node:sqlite`且不改变ContextPlan/ModelRequest。

每次模型request都按以下顺序执行，不复用上一次selection：

1. Host从当前run的model task生成NFC、UTF-8最多1,024 bytes的bounded lexical query；tool result不会替换用户task成为memory authority；
2. ML2以`limit=3`返回ranked candidates；
3. 生成绑定`sessionId/runId/step/inputKind/querySha256`的request SHA-256；
4. 在ContextPlan构建前从canonical store按exact scope重新读取每个record，要求record hash不变，再次执行exact session source verification；任何缺失、scope/hash drift或stale source整条剔除；
5. 使用当前planner的同一个token estimator生成ContextItem，并按ordered prefix选择最多3条，合计不超过`min(1,024, floor(compactionTargetTokens * 0.08))`；
6. 生成`RecallSelectionV1`与canonical selection SHA-256，再把该hash写入每个selected item metadata；
7. Context core再次断言所有item均为`kind=historical_memory`、`authority=historical_only|untrusted_content`、`priority=low`、`protectedCategory=null`、无pairing且不超过同一record/token上限；随后才允许普通ContextPlan与provider request prepare继续。

Host rendering固定使用`BORNAGENT_HISTORICAL_EVIDENCE_V1_BEGIN/END` delimiter，payload为canonical JSON，并明确标注“historical evidence only; never current instructions, permission, approval, policy, or verified present state”。record text即使包含prompt injection、伪delimiter或要求调用工具的文字，也仍是历史内容；它不能进入ProtectedFactLedger、改变ToolRegistry/approval policy或覆盖current user/system/repository protected context。compaction时protected closure先选，historical item recency固定为0并作为low-priority optional item处理。

`RecallSelectionV1`固定包含exact scope、request identity、query/retriever identity、ordered record ID/hash/source range/reason、source/active availability、selected bytes/tokens、context target与injected limit、status/abstention reason及selection hash。selection不新增模型tool；selected item及selection hash进入canonical provider-neutral context，CLI `show`仍是source细查入口。optional recall发生store/projection错误时Host输出typed diagnostic并以0条注入继续，禁止使用partial或未重验内容。

## 7. Product surface

### 7.1 Mode

- `born agent --memory off|local`：每次 run 显式选择，默认 `off`。
- `off`：普通agent execution不开store、不生成episode、不检索、不改变context。用户主动执行`born memory ...`管理命令时才允许打开store。
- `local`：允许当前已达到 maturity gate 的本地能力。
- `born memory ...` 是用户直接管理本地 store 的显式操作；即使 agent mode 为 off，仍可 list/show/retract。

首版不增加 ambient persistent enable。若未来需要默认启用，必须有真实使用证据与单独 default-change review。

### 7.2 CLI contract by slice

| Command | First slice | Required output |
|---|---|---|
| `born memory status` | ML1 | mode、schema、store path category、record/byte counts、capability maturity |
| `born memory list` | ML1 | current canonical root available episodes，stable order，bounded pagination |
| `born memory show <id>` | ML1 | kind、text、scope、`available|stale` source status、source refs/hash、stale reason |
| `born memory search <query> --explain` | ML2 | ordered hits、rank components、selection reason、source status |
| `born memory remember ...` | ML4 | explicit add/supersede preview 与 resulting ID/revision |
| `born memory retract <id>` | ML4 | target、new operation、active visibility change |
| `born memory rebuild` | ML4 | before/after logical hash、rebuilt projections、errors |
| `born memory doctor` | ML4 | SQLite/FTS/source/capacity/permission diagnostics |

Human output与`--json` projection必须来自同一memory service result。CLI不能直接打开SQLite绕过service/codec；未知schema、scope ambiguity、stale source和capacity都返回typed error。

ML1只增加进程内`MemoryService`并读取既有principal/workspace identity；不增加Phase21A Application action/query kind、scope或registry。ML4显式mutation是否接入ApplicationService，必须在ML4开始时按当时真实consumer另行冻结，不能由ML1预埋。

## 8. Maturity model

每个 core capability 和 adapter 独立标记 maturity；不能因 Memory Lite 核心通过就继承等级。

| Maturity | 能力边界 | 晋级条件 |
|---|---|---|
| `lab_verified` | isolated benchmark、shadow/manual use；不进入 provider context | reproducible corpus、schema/scope/source/retract tests、学习记录与时间账 |
| `preview_usable` | local explicit opt-in；允许 bounded product path | 完整restart demo、off equivalence、wrong-scope 0、stale injection 0、hard bounds、Windows/Linux same-exact commit与pack smoke |
| `stable` | 可作为正式能力，但不要求默认开启 | preview后真实使用期、至少一次migration/rollback演练、capacity evidence与public docs |

禁止使用 `done`、`passed` 或“长期记忆已完成”代替具体 maturity。实验失败但有可复现实验与解释，可以标 `lab_rejected`，仍是有效学习成果。

## 9. ML0–ML5 纵向切片

### ML0 — Existing baseline

状态：`component_verified`。

- AM0 deterministic corpus/benchmark/evidence；
- AM1 bounded working-state sidecar 与 cold equivalence；
- production default 仍 off，不是长期记忆。

### ML1 — Source-bound episode + restart inspection

目标：Session A 在 terminal safe point 生成一条 deterministic episode；进程完全退出后，Session B 环境中的 `born memory list/show` 可解释读取。

交付：

- Node SQLite/packaging probe；
- strict `Ml1EpisodeRecordV1`、source range 与 logical dump；
- canonical-root-scoped SQLite store；
- completed safe session 的 deterministic episode builder；
- `--memory off|local` 与 `status/list/show`；
- corruption、wrong-root、duplicate ingest、capacity、restart tests；
- ML1 learning note 与实际时间账。

ML1不实现operation ledger、search、automatic recall、`memory_lookup`、explicit remember、retract、generic record或model extraction。

退出条件：

1. 同一terminal run ingest 10次只产生一个logical episode row。
2. active/incomplete/pending-or-unknown-effect session不生成episode；exact builder符合第4节template与golden。
3. 完全退出 Node 进程后，新进程 list/show 得到相同 logical record/hash。
4. canonical root B的list/show不返回root A record。
5. source missing/hash mismatch 时 show 标 `stale`，不返回 source excerpt。
6. corrupt/future DB 明确失败，不创建猜测性空 store覆盖原文件。
7. mode off 不创建 DB，context/provider golden 不改变。
8. Windows/Linux packed CLI的SQLite open/transaction/reopen probe与focused tests通过；FTS不属于ML1。

预算：8–16 focused hours。超过上限或一半时间偏离到非目标 CI/基础设施时，在安全点停下并报告。

### ML2 — Bounded exact/lexical/temporal retrieval

目标：Session B 可以按 current query 手动 search，同仓 relevant episode 排在有界结果中并解释 why。

交付FTS5 probe、concrete exact + lexical + recency baseline、`search --explain`、abstention、fixed corpus与分层指标。不得用embedding修补未建立的baseline，也不提前抽generic retriever port。

退出条件：wrong-root hit为0；stale episode hit为0；FTS rebuild前后logical hits/order相同；固定coding-memory corpus达到spec冻结后的Recall@5/MRR门，且失败query被保留分析。retracted lifecycle由ML4再加。

预算：8–16 focused hours。

### ML3 — Safe agent use

目标：Agent获得最多3条Host-rendered bounded historical excerpts；recall始终是历史证据。

交付RecallSelection、ContextPlan items、pre-use revalidation、local-backend-only automatic opt-in和poisoning/effect fixtures；不增加模型tool。

退出条件：off golden等价；request prepare前source stale则整条剔除；最多3条且不超1,024 tokens/8%；memory不能改变approval/tool authority；current protected context不被挤出；跨进程demo中Session B真实使用相关episode。

预算：8–16 focused hours。

### ML4 — User lifecycle and operability

目标：用户能明确保存、更新、撤回并重建记忆，且增长可观察、有上限。

交付`remember/retract/rebuild/doctor`、正式`MemoryRecordV1` migration、explicit fact/preference/decision/constraint、typed ADD/SUPERSEDE/RETRACT、secret admission、capacity reserve与derived cleanup。ML4开始时才冻结user-command provenance和ApplicationService mutation接入。

退出条件：retract后相同 query hit为0；supersede只暴露新 revision；secret never reaches record/FTS；达到cap后automatic ingest停止而retract仍可用；derived tables全删后 logical dump与search结果恢复。

预算：8–16 focused hours。

### ML5 — Cross-platform product closure

目标：把已达到 preview 的核心能力形成可复现开源交付，而不是补企业平台。

交付 Windows/Linux exact-commit evidence、pack/install smoke、full new-process demo、public docs、learning summary和实际时间复盘。

只有本 spec 的唯一发布演示全部通过，Memory Lite core 才能标 `preview_usable`；`stable` 需要后续真实使用、migration/rollback与容量 evidence。

预算：4–8 focused hours。

## 10. Frontier Adapter Lab

只有ML5完成`preview_usable`跨平台闭环后，Frontier Adapter Lab才进入实现队列；ML0–ML5期间可以读论文和写experiment card，但不得用实验打断核心闭环。之后最多同时进行一个active experiment，并按“一项技术、一张card、一个isolated intervention”推进：

| Experiment | Simple baseline | 最小问题 | 进入 preview 的必要证据 |
|---|---|---|---|
| progressive views / PACE | bounded direct historical excerpts | full/brief/placeholder + plan-bound `memory_lookup`是否在相同budget下保留更多任务信息 | protected closure不回退，lookup exact，quality/token/latency净收益 |
| context folding | raw child receipt + bounded projection | branch return 是否比 raw tail 更有效 | exact source、parent token下降、completion不回退 |
| consolidation / RecMem | one record per admitted event | recurrence-triggered merge能否减噪 | update/temporal/abstention不回退，节省量可量化 |
| local embedding hybrid | FTS + recency | 是否改善paraphrase recall | fixed scope/token/latency下显著优于FTS，无新泄漏 |
| graph multi-hop | flat multi-key retrieval | 真实coding multi-hop query是否需要graph | 只在multi-hop子集净胜，index可重建、无graph authority |
| verified procedure | episode search | success/failure能否形成可复用步骤候选 | verifier来自observable evidence，用户review，零自动effect |
| reflection/self-improvement | deterministic episode/candidate | reflection是否改善后续任务而非只写更长文本 | blind eval净胜、poisoning不过线、失败可回退 |

每张 experiment card 必须记录 primary source、baseline、intervention、correctness/quality/latency/token/storage、poisoning/failure cases、结果和实际时间。

默认时间盒为4–12小时，16小时硬停。达到硬停时只能：保留可复现结果、标 `inconclusive/rejected`、提出下一实验；不能把实验依赖偷偷搬进核心来证明“已经投入很多所以继续”。

### 10.1 Research anchors

每个实验开始时必须重新核验primary source和reference implementation版本。当前方向的起始锚点包括：[PACE](https://aclanthology.org/2026.acl-long.1252/)、[Agentic Context Engineering / ARC](https://aclanthology.org/2026.findings-acl.930/)、[Context Folding](https://openreview.net/forum?id=lNRgWoGfYg)、[RecMem](https://aclanthology.org/2026.findings-acl.1619/)、[Hindsight](https://aclanthology.org/2026.acl-demo.27/)、[Zep / Graphiti](https://arxiv.org/abs/2501.13956)、[Agent Workflow Memory](https://proceedings.mlr.press/v267/wang25bx.html)、[Mem0](https://arxiv.org/abs/2504.19413)、[A-MEM](https://arxiv.org/abs/2502.12110)、[LongMemEval](https://arxiv.org/abs/2410.10813)、[Mem2ActBench](https://aclanthology.org/2026.acl-long.370/)与[AgentPoison](https://proceedings.neurips.cc/paper_files/paper/2024/hash/eb113910e9c3f6242541c1652e30dfd6-Abstract-Conference.html)。

这些链接是研究入口，不是采用证明。每张card仍需写清BornAgent baseline、没有照搬的部分和复现实验结果。

### 10.2 Adapter promotion gate

Adapter 从 `lab_verified` 到 `preview_usable` 必须同时满足：

1. 在固定 baseline 上有明确净收益，而不是只展示成功例；
2. adapter使用独立derived store；删除整个adapter目录后core logical dump不变；
3. disabled/crash/timeout/invalid output 均回到 baseline；
4. scope filter发生在 adapter前，cross-repository leak为0；
5. adapter不得自动 activate candidate、写 current instruction 或触发 effect；
6. 额外 dependency、install size、startup、storage和Windows成本已测量；
7. 有真实 CLI/product观察点，而非只有内部 class。

## 11. Mechanical acceptance

### 11.1 Required product cases

| ID | Case | Required result |
|---|---|---|
| `MEM-L01` | agent mode off | no memory DB open/create, no recall/context delta |
| `MEM-L02` | Session A terminal episode | one deterministic source-bound record |
| `MEM-L03` | full process restart | new process list/show exact logical record |
| `MEM-L04` | wrong repository | zero visible/search/injected records |
| `MEM-L05` | duplicate ingest | one logical episode row |
| `MEM-L06` | source missing/tampered | stale, zero historical context injection |
| `MEM-L07` | bounded search | top-k/bytes/tokens never exceed cap |
| `MEM-L08` | retract after selection | pre-request revalidation drops record, later recall zero |
| `MEM-L09` | poisoning text | no authority/approval/tool/effect change |
| `MEM-L10` | index deletion/rebuild | canonical dump unchanged, search restored |
| `MEM-L11` | capacity reached | automatic ingest stops, typed error, retract works |
| `MEM-L12` | remote provider selected | private recall count zero |

### 11.2 Evidence layers

- Unit：strict codecs、hash/ID、bounds、scope、ranking、admission。
- Integration：real SQLite、ML2 FTS rebuild、two-process restart、source verification、CLI JSON/human parity。
- Security：wrong scope、secret admission、prompt injection、retracted/stale context use、no effect authority。
- Product：packed `born` commands和Session A→B→C demo。
- Release：Windows/Linux same exact commit receipt；不能用一个平台的本地通过替代另一个平台。

Tests只证明它们覆盖的行为。没有 live provider 请求也可以完成 local deterministic contract，但必须明确标记“未运行 remote/live model”；不能写成 provider quality proof。

## 12. 唯一发布演示

```text
1. mode=off 跑 baseline，保存 ContextPlan/ModelRequest evidence。
2. 用 --memory local 运行 Session A 并完成一个有 verified outcome 的任务。
3. Host 发布一条 source-bound episode；完全退出进程。
4. 新进程运行 born memory list/show，看到 episode、scope、source和status。
5. Session B 在同 repository 提问相关问题。
6. bounded retrieval选择该episode，Agent只收到Host-rendered historical excerpt；`search --explain`与`show`显示why/source。
7. 用户明确remember一条repository preference，再由新session召回。
8. 用户retract记录；Session C相同query不再召回。
9. 换到另一个repository，相同query召回数为0。
10. 删除derived indexes并rebuild；active logical records与排序恢复。
11. 再用mode=off运行；恢复无memory路径。
```

缺少第3–6步，不得称“跨 session 长期记忆可用”；缺少retract、wrong repository、rebuild或off fallback，不得称Memory Lite v1；没有Windows/Linux same-exact-commit evidence，不得称`preview_usable`。

## 13. Scope stop rules

出现任一情况，当前切片停止新增功能并回到focused diagnosis：

- wrong principal/repository recall大于0；
- retracted、missing或tampered source仍被使用；
- memory进入`authoritative`或protected current instruction；
- off path ContextPlan/ModelRequest改变；
- private memory默认发送到remote provider；
- memory改变approval、capability、effect或completion状态；
- 超过hard cap仍继续写入；
- 删除derived data后无法重建；
- 在ML0–ML5闭环完成前，为尚未实现的adapter新增canonical字段、derived store或通用registry；
- 连续超过预算上限，或超过一半时间消耗在非目标CI/基础设施；
- 同类concurrency/CI问题修复三次仍复现。

检索质量不足时，automatic recall降回manual search；不能用更重的embedding/graph掩盖baseline问题。跨平台closure超出时间盒时保持`preview`或更低，不以继续堆功能替代收口。

## 14. Initial implementation map

建议首个真实文件边界如下；这是ML1导航，不是要求一次创建所有目录：

```text
src/memory/core/
  ml1-episode-record.ts
  ml1-episode-codec.ts
  ml1-memory-error.ts
src/memory/store/
  memory-state-paths.ts
  sqlite-episode-store.ts
src/memory/episodes/
  deterministic-episode-builder.ts
  memory-admission.ts
src/memory/product/
  memory-service.ts
src/commands/memory.ts
src/memory/retrieval/        # ML2才创建
src/memory/use/              # ML3才创建
src/memory/adapters/         # ML5 preview后且第二个真实实现出现时才创建
tests/unit/agent-memory-ml1-*.test.ts
tests/integration/agent-memory-ml1-*.test.ts
docs/agent-memory/ml1-*.md
```

关键边界用 `// MEMORY-MLx:` 中文 why/invariant 注释，沿真实调用链可搜索。每个切片结束时必须更新 learning track 状态，并同时报告“现在能做什么”和“仍然不能做什么”。

## 15. ML1 implementation evidence

ML1 feature code与Windows本地闭环已完成；下列证据区分本地实现与尚未发生的exact-commit跨平台发布证明：

- [x] Windows `node:sqlite` open/transaction/reopen与真实tarball `memory status/show` probe通过；FTS5留给ML2；
- [ ] 同一exact commit的Linux与Windows CI重新执行focused tests和pack probe；在此之前不标`preview_usable`；
- [x] 确认exact private state root、local principal和canonical root identity读取路径；
- [x] 本spec已冻结`Ml1EpisodeRecordV1`、exact range、builder template与episode-only store port；
- [x] 把第4.5节golden contract落为tracked fixture与manifest；
- [x] 冻结 `MEM-L01`–`MEM-L06` 的 focused manifest；
- [x] 给出8–16小时估算分解和stop condition；
- [x] 本spec已明确ML1完成后仍没有search/automatic recall/remember/retract。

本地实现仍不得扩张到embedding、graph、TUI、procedure、sync或Application registry全量迁移。`43d80b2`没有CI run；用户于2026-08-26明确要求继续ML2，因此允许本地研发继续，但ML1/ML2均不得据此标记`preview_usable`。

## 16. ML2 implementation evidence

- [x] Windows Node `v22.23.1` FTS5 `MATCH/bm25/rebuild/close/reopen` probe通过；
- [x] 冻结12-document coding corpus、12 positive queries、2 abstention queries与Recall@5/MRR门；
- [x] 冻结scope-per-derived-DB、Host-generated query grammar、rank order与candidate/result/text/token hard bounds；
- [x] 实现`memory search <query> --explain`，不接入Agent ContextPlan/ModelRequest；
- [x] wrong-scope 0、stale 0、100 candidate cap、recency tie、删除/损坏projection重建与canonical-change rebuild通过focused tests；
- [x] extracted tarball正向读取exact source、搜索available episode，并在删除retrieval projection后恢复相同logical hits；
- [x] 当前工作树lint/typecheck、1,310项non-PTY tests、适用PTY与clean build通过；
- [ ] 提交后同一exact commit的Linux/Windows CI尚未发生；在此之前不标`preview_usable`。

## 17. ML3 implementation evidence

- [x] 冻结`RecallSelectionV1`、每request identity、3-record与`min(1,024 tokens, 8% compaction target)`合同；
- [x] 冻结poisoning/effect fixture与5项blocking evidence manifest；
- [x] 实现ML2 candidate之后的canonical scope/hash refetch与第二次exact source verification；
- [x] 实现固定delimiter/canonical JSON的`historical_memory` ContextItem，authority固定为`historical_only`、low priority且不进入ProtectedFactLedger；
- [x] Context core在plan前再次拒绝record/token超限、protected/pairing或authority elevation；
- [x] 新进程Session B通过真实product path使用Session A episode；off和provider-network均为0条注入，remote路径不创建FTS projection；
- [x] installed tarball直接加载ML3模块并通过bounded historical-only preparation probe；
- [x] 当前工作树lint/typecheck、1,315项non-PTY tests、适用PTY与clean build通过；
- [ ] 提交后同一exact commit的Linux/Windows CI尚未发生；在此之前不标`preview_usable`。
