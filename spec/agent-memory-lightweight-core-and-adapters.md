# BornAgent Lightweight Memory Core and Frontier Adapters Spec

> Status: Active implementation contract（updated 2026-08-29）
> Current slice: ML5 closed; Memory v1 core is `preview_usable` at exact commit `e329a4b4aad968870505e36ba0bfc1b4d7e00511`; CF2 and EM-R1 candidates remain disabled and never entered production. FAL Memory Shared Benchmark v1 has run public development/calibration: embedding passed only the retrieval-stage gate, Context Folding was not beneficial on 12/12 timelines, and the fixed reader produced zero must-answer grounded successes, so the committed evaluation remains unopened. Shared evidence has `sourceCommit=null` and is not promotion eligible; Agent default remains `off`, remote provider injection remains zero
> Product boundary: local, single-user, repository-scoped, cross-session memory
> Explicit non-claim: `preview_usable` does not mean stable or prove remote/live model quality, AM2–AM6, remote disclosure, frontier adapters, secure erase, or global memory

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
- FTS、embedding、graph和summary是可删除、可重建的projection；adapter生成的model/cache/vector/derived state可丢弃，删除不改变core logical state，但不承诺零成本重建。Candidate源码、tests与rehydration manifest按第10节默认保留，不能与derived state混称“可丢弃candidate”。
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
| canonical record revisions | ML4 | 10,000 rows / 64 MiB | episode与explicit revision共用；ADD/SUPERSEDE达到任一上限即typed拒绝 |
| lifecycle operations | ML4 | 20,000 rows / 64 MiB | 每个record revision至多产生一个ADD/SUPERSEDE，另为每个logical record保留一次RETRACT |

ML1 capacity只按strict canonical JSON UTF-8 bytes和row count机械执行；SQLite DB、WAL与page bytes只观测并由`status`报告，不能拿不稳定的physical file size充当admission truth。默认值可以在后续spec delta基于真实使用调整，但配置不得超过code hard maximum。

ML4把record cap解释为全部canonical revisions的全局上限，不因supersede或retract回收；这保留append-only provenance。`ADD/SUPERSEDE`同时消耗一条revision和一条operation，达到revision row/byte cap后automatic episode ingest与explicit remember均停止。`RETRACT`不新增revision，也不检查revision cap；operation hard cap固定为revision hard cap的两倍，因此即使10,000条revision已满，仍为每个logical record保留一次retract。重复retract幂等且不继续增长operation ledger。

### 5.3 Sensitive content admission

首版拒绝已知 token、private key、credential、cookie、raw environment dump 和显式 `non-persistable` content。Redaction不能把“先写入再清洗”变安全：ML1命中时整条episode skip；ML2以后secret scan仍必须发生在canonical transaction和FTS insert之前。

ML4 explicit remember复用同一admission scanner，并在MemoryService builder、SQLite revision transaction和FTS rebuild三处fail closed；错误只返回typed code，不回显被拒绝文本。operation不保存用户文本。这里是已知pattern admission，不声明通用DLP。

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

#### 7.2.1 ML4 frozen mutation and migration delta

ML4当前只有`born memory ...`这一位本地、同步、单用户consumer；命令先通过既有Host repository registry解析exact principal/repository/canonical-root scope，再直接调用同一个MemoryService。它不接入Phase21 ApplicationService、不新增action registry或session journal，因为memory mutation既不调度Agent/effect，也没有第二位需要统一编排的consumer。未来若出现TUI、daemon或remote writer，再以真实并发/鉴权需求单独迁移。

CLI固定为：

- `memory remember <fact|preference|decision|constraint> <text> [--supersedes <record-id>]`；无`--supersedes`产生logical record revision 1 + `ADD`，有该参数时要求target active、explicit且kind相同，产生同record ID的新revision + `SUPERSEDE`；
- `memory retract <record-id>`对任意active episode或explicit record追加`RETRACT`；重复调用返回幂等结果而不追加operation；
- `memory rebuild`删除当前scope的全部FTS derived data，再从canonical logical dump建立`fts5-v2`；前后logical hash必须相同；
- `memory doctor`只读检查SQLite quick-check/schema、active source、FTS、capacity reserve和private-path mode，不修复canonical state。

canonical SQLite从schema 1原子迁移到schema 2：旧`episode_records`的canonical JSON、record ID和record hash原样进入`memory_records` revision 1，并生成Host-owned deterministic `ADD` operation；迁移后schema固定为`metadata + memory_records + memory_operations`。正式`MemoryRecordV1`是原字节不变的`Ml1EpisodeRecordV1`与新的explicit record strict union。explicit record固定包含stable logical `memory_<sha256>` ID、`revision`、`revision_<sha256>` identity、kind/text/scope/hash，以及Host生成的`local_user_command` source（command ID、timestamp、可选superseded revision）。operation固定为strict canonical `ADD|SUPERSEDE|RETRACT`、全局单调sequence、target/new revision identity、scope、actor与hash。

active state只从ordered operation ledger计算：`ADD/SUPERSEDE`的new revision active，`RETRACT`使logical record不可检索；records从不原地更新。ML2/ML3改为只读取active `MemoryRecordV1`，并在request前同时refetch active head、revision identity、record hash、scope和source。explicit user-command source由canonical command provenance自证；episode仍重验exact session range。`show`可以观察retracted latest revision，但`list/search/automatic recall`只能观察active且source-available revision。

ML4把derived projection升级为`memory/v1/retrieval/fts5-v2/<scope-sha256>.sqlite3`与`records_fts`；candidate同时绑定record/revision identity。任何logical hash变化都会重建，remember/supersede/retract命令还会立即移除当前scope projection。旧`fts5-v1`和整个retrieval目录均可删除，不改变schema 2 logical dump。

## 8. Maturity model

每个 core capability 和 adapter 独立标记 maturity；不能因 Memory Lite 核心通过就继承等级。Product maturity与lab evidence是两套不同维度：新实验不得再用一个`lab_verified`或`lab_rejected`同时表示实现忠实度、数据充分性、质量、产品收益与promotion决定。

| Maturity | 能力边界 | 晋级条件 |
|---|---|---|
| `mechanism_verified` | isolated source/tests证明候选按冻结合同运行；不进入 provider context | implementation anchors、determinism、correctness/safety/fallback gates与可恢复源码 |
| `promotion_eligible` | evidence-protocol v2证明指定claim和当前workload的净收益；仍未接product | adequate held-out/trace evidence、cost、quality与explicit promotion amendment |
| `preview_usable` | local explicit opt-in；允许 bounded product path | 完整restart demo、off equivalence、wrong-scope 0、stale injection 0、hard bounds、Windows/Linux same-exact commit与pack smoke |
| `stable` | 可作为正式能力，但不要求默认开启 | preview后真实使用期、至少一次migration/rollback演练、capacity evidence与public docs |

禁止使用 `done`、`passed`、无范围的`rejected`或“长期记忆已完成”代替具体状态。历史receipt中的`lab_verified/rejected`保持原字节，但v2解释必须使用第10节的正交结论；`promotion=blocked`不等于论文、模型、算法方向或实现机制被否定。

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

实现校准：根据ML2约0.7h、ML3约1.3h的Agent实测，ML4 Agent wall-clock暂估2–5h；这不修改原始人工预算，也不替代功能与回归证据。

### ML5 — Cross-platform product closure

目标：把已达到 preview 的核心能力形成可复现开源交付，而不是补企业平台。

交付 Windows/Linux exact-commit evidence、pack/install smoke、full new-process demo、public docs、learning summary和实际时间复盘。

只有本 spec 的唯一发布演示全部通过，Memory Lite core 才能标 `preview_usable`；`stable` 需要后续真实使用、migration/rollback与容量 evidence。

预算：4–8 focused hours。

## 10. Frontier Adapter Lab

只有ML5完成`preview_usable`跨平台闭环后，Frontier Adapter Lab才进入实现队列；ML0–ML5期间可以读论文和写experiment card，但不得用实验打断核心闭环。之后最多同时进行一个active experiment，并按“一项技术、一张card、一个isolated intervention”推进：

Frontier Adapter Lab不是第二套memory system。Adapter只能消费已经通过对应Host authority filter的输入：memory方向先做principal/repository hard scope，context/task方向先做session/Goal/Plan/source/receipt exact binding；若需要持久化，只能写独立、可整目录删除的derived store。disabled、crash、timeout或invalid output时必须回到该方向的existing baseline；memory retrieval默认为FTS + recency，context folding默认为current verified receipt projection。`mechanism_verified`不等于`promotion_eligible`或`preview_usable`，实验也不能修改canonical memory、current instruction、approval或effect authority。

每张 experiment card 必须记录 primary source、baseline、intervention、correctness/quality/latency/token/storage、poisoning/failure cases、正交结论和实际时间。

默认时间盒为4–12小时，16小时硬停。达到硬停时必须保留已有source/evidence、逐轴标明`verified/failed/inconclusive/not_run`并提出下一实验；不能把实验依赖偷偷搬进核心来证明“已经投入很多所以继续”。

### 10.0 Evidence protocol v2

从2026-08-28起，新的experiment revision使用生命周期加正交结论，不再产出一个包办所有含义的overall outcome：

```text
lifecycle:
draft -> baseline_frozen -> candidate_built -> evaluation_complete -> closed

closure axes:
evidenceValidity       = valid | limited | invalid
implementationFidelity = verified | failed | inconclusive
claimResults[]         = supported | refuted | inconclusive | not_run
productFit             = supported | not_demonstrated | inconclusive | not_assessed
promotion              = eligible | blocked | not_assessed | promoted
direction              = retain | revise | pause | drop
reproducibility        = full | corpus_only | receipt_only
candidateLifecycle     = retained_disabled | quarantined | archived_recoverable | removed_legacy_policy | removed_for_hazard
```

每个`claimResults[]`必须同时写清claim边界、metric、case role、evidence provenance和不能外推的部分。例如“E5在固定语料提高semantic Recall@5”与“E5能可靠拒答”是两个claim；“dictionary fold可lossless expand”与“它在真实任务有净收益”也是两个claim。

Gate按以下顺序解释：

1. **G0 evidence validity**：golden独立性、数据来源、case role、calibration/evaluation隔离、真实baseline路径与样本覆盖。失败只使证据`limited/invalid`，不得归因算法或模型；
2. **G1 safety/isolation**：wrong scope进入adapter、stale/retracted/forged数据实际泄漏、authority提升、canonical mutation或fallback不等价。这才是零容忍安全硬门；
3. **G2 implementation fidelity**：候选是否忠实实现冻结算法，例如lossless、pooling、normalization、fusion、bounds、hash与determinism；
4. **G3 quality/benefit**：Recall、MRR、abstention、risk-coverage、token收益与task completion。失败可以refute当前candidate claim或阻止promotion，但不能覆盖G1/G2结论；
5. **G4 cost**：模型体积、延迟、storage、dependency、pack与startup；只描述当前实现成本并决定是否值得晋级；
6. **G5 promotion**：真实product path、explicit opt-in、跨平台、rollback和观察点。未通过只表示不接入production。

因果归因也受约束：reference anchor或冻结公式不一致才叫implementation fault；adequate calibration中不存在满足预注册risk/coverage目标的任何operating point，才能refute该selection algorithm；同selector、同corpus的固定model comparison才能归因model。Calibration通过但family-disjoint evaluation失败，只能先记generalization failure。

历史v1 receipt、manifest和case pack不修改hash。新的解释通过spec/learning record引用旧receipt SHA，并使用新experiment ID与新holdout；已经公开或用于讨论的evaluation case只能作为`known_regression`，不能再次冒充blind evidence。CF v1 evidence已经进入Git；EM v1 evidence在EM-R1运行时仍只在working tree中byte-frozen。本轮按用户明确要求先重试，保留旧原字节并记录`sourceCommit=null/working_tree_full`偏差；因此当前证据不能称durably immutable或exact-commit，后续发布前仍须提交并重跑适用门禁。EM-R1后续审计还确认calibration loader为全manifest验hash而读取过evaluation文件，且split-prefixed IDs掩盖了语义孪生family；append-only correction只保留“calibration无eligible point、evaluation未评分、promotion blocked”，并把旧holdout降级为`known_exposed_holdout_development_only`。

Candidate源码、candidate-only tests、fixture、runner与rehydration manifest默认保留在不参与production build的lab目录，必须默认disabled且production import/pack graph为0。模型权重、vector DB、cache、临时目录、隔离lab dependency root中的`node_modules`、含用户数据或绝对路径的输出默认删除。只有secret/license/hazard、无法限制的依赖、用户明确要求，或源码已经进入可恢复Git历史后，才允许从working tree移除唯一源码；此时分别记录`removed_for_hazard`或`archived_recoverable`。历史上按旧合同删除且从未进入Git的候选记录`removed_legacy_policy`。收益不足绝不能自动触发源码删除。

### 10.1 研究结论：9个功能方向，3条横向验证线

论文和开源系统数量很多，但Mem0、A-MEM、Hindsight等是多机制组合，不应各算成一个独立adapter。按BornAgent可以隔离替换的底层机制拆分，当前共有9个功能方向：

| Family | Direction | Simple baseline | 最小问题 | 进入preview前的必要证据 |
|---|---|---|---|---|
| short-term/context | context folding lite | raw child receipt + bounded projection | branch return是否比raw tail更有效 | exact source、parent active token下降、completion不回退；额外model/tool calls已测量 |
| short-term/context | progressive views / PACE | bounded direct historical excerpts | full/detailed/brief/placeholder能否在相同budget保留更多任务信息 | protected closure不回退，glimpse exact，quality/token/latency净收益 |
| short-term/context | ARC active context repair | current ContextPlan + deterministic checklist | 独立context manager能否发现遗漏并修复working state | blind completion净胜，串行/重叠延迟已测量，无authority elevation |
| retrieval/formation | local embedding hybrid | FTS + recency | 是否改善中文、同义词与paraphrase recall | fixed scope/token/latency下显著优于FTS，abstention不回退，无新泄漏 |
| retrieval/formation | recurrence consolidation / RecMem | one record per admitted event | recurrence-triggered merge能否减噪并减少整理调用 | update/temporal/abstention不回退，raw source保留，节省量可量化 |
| retrieval/formation | automatic formation/evolution | deterministic episode + explicit remember | model抽取、ADD/UPDATE/DELETE或note evolution能否提高后续使用质量 | 只能生成candidate；provenance/retraction/poisoning通过，零direct canonical mutation |
| knowledge reuse | graph multi-hop | flat multi-key retrieval | 真实coding multi-hop query是否确实需要graph | 只在multi-hop子集净胜，index可重建，无graph authority |
| knowledge reuse | verified procedure | episode search | success/failure能否形成可复用步骤候选 | verifier来自observable evidence，适用scope/version/rollback明确，零自动effect |
| knowledge reuse | verified reflection / ACE-style playbook | deterministic episode/candidate | verified delta能否改善后续任务而非只写更长文本 | blind eval净胜，helpful/harmful可计数，规则可retract，poisoning不过线 |

ACE与ARC必须分开理解：ACE是Agentic Context Engineering的Generator–Reflector–Curator增量playbook；ARC是Active and Reflection-driven Context Management的主动上下文管理器。现有文档不得再用“Agentic Context Engineering / ARC”指代同一方向。

另外有3条横向验证线，它们不是adapter，也不增加功能方向计数：

1. **LongMemEval-lite**：覆盖extraction、跨session、temporal、update、conflict与应当abstain；
2. **Mem2ActBench-lite**：检查memory是否让tool/action参数发生正确变化，而不只检查“检索到了没有”；
3. **AgentPoison canary**：poisoned memory不能提高authority、跨repository泄漏、改变approval/effect或诱导高风险参数。

### 10.2 工程难度与成本估算

下表是基于当前TypeScript/Node 22、SQLite FTS5、Memory v1 derived-store边界的单人工程估算，不是论文给出的工时，也不包含论文级RL/SFT训练、不可控CI等待或远程模型费用。`产品化总投入`从零开始计算，并非在lab时间之外必然追加。

| # | Direction | 难度 | Isolated lab | 产品化总投入 | 主要持续成本 | 当前研究判断 |
|---:|---|---:|---:|---:|---|---|
| 1 | context folding lite | 3/5 | 8–16h | 20–50h | active token下降，但model/tool call可能上升；derived receipt很小 | 最适合第一个context实验 |
| 2 | progressive views / PACE | 3/5；faithful 4/5 | 8–16h | 24–56h | local embedding、异步summary、多级view与vector storage | 候选池长期大于约10–20条后再做；该阈值是工程启发式，不是论文结论 |
| 3 | ARC active context repair | 5/5 | 12–16h feasibility only | 1–2 engineer-weeks以上，另计训练 | 每step增加context manager；延迟与训练硬件高 | 暂缓，不作为轻量adapter起点 |
| 4 | local embedding hybrid | 3/5 | 8–16h | 20–40h | 首次模型包约140MiB量级；CPU embedding与vector scan | 最务实的第一个retrieval实验 |
| 5 | recurrence consolidation / RecMem | 4/5 | 8–16h recurrence-only | 30–60h | 每次写入embedding、命中recurrence后偶发LLM、三层store | embedding baseline后研究 |
| 6 | automatic formation/evolution | 5/5 | 12–16h candidate-only | 40–80h | 典型方案每次写入至少一次LLM/embedding；provenance与poison风险最高 | 最后研究，永不直写canonical |
| 7 | graph multi-hop | 5/5 | 12–16h SQLite-lite | 50–120h | entity/relation extraction、graph index；full方案还需DB/GPU | 先用eval证明真实multi-hop缺口 |
| 8 | verified procedure | 3–4/5 | 12–16h | 30–70h | verified success后一次抽取，另有replay/test/version storage | 产品收益最高的优先方向 |
| 9 | verified reflection / ACE | 5/5 | 12–16h delta-only | 50–120h | model/evaluator calls与持续增长的playbook | procedure稳定后再做 |

本地embedding首个实验不引入vector DB或HNSW：独立SQLite BLOB保存384维vector，在候选硬上限内用JavaScript exact cosine scan，再与FTS做rank fusion。FAL-EM0证实10,000条`float32 × 384`需要16 KiB SQLite page避免payload overflow；最终store为23,461,888 bytes、scan p95为37.79 ms。性能不是v1 promotion blocker；直接原因是3个safe-distractor abstention false accepts，而其data/algorithm/model根因因calibration不足保持inconclusive。

### 10.3 论文结果对BornAgent的约束

- **Context Folding**：branch/return能减少父任务active context，但论文收益依赖针对性训练；轻量实现必须先复用现有child receipt/task graph，只返回结论、exact evidence、未解决项和change receipt，并单独统计增加的调用数。
- **PACE**：多分辨率view在超长任务中有效，但当前ML3每request最多3条、`min(1,024 tokens, 8%)`；在候选规模仍小时，summary/view基础设施可能比节省的上下文更贵。
- **ARC**：它是每步主动维护和反思working state的context manager，不是ACE缩写；论文级训练和额外推理路径超出当前轻量实验边界。
- **Embedding hybrid**：优先评估multilingual-e5-small一类384维多语言模型；all-MiniLM-L6-v2只适合做小包smoke，不作为中文质量结论。
- **RecMem**：recurrence减少的是LLM整理频率，不代表raw store停止增长；论文中的raw/subconscious store对准确率重要，因此canonical/source不能为了“consolidation”被删除。
- **Automatic formation/evolution**：Mem0、A-MEM和Hindsight说明自动抽取、链接、更新可能有价值，但也把错误抽取、错误覆盖与poison传播带进写路径；BornAgent首个实验只能输出有source-bound proposal的candidate。
- **Graph**：只允许先做deterministic SQLite explicit-edge、1–2 hop实验；没有multi-hop子集净收益时，不引入Graphiti/Neo4j/FalkorDB或LLM OpenIE。
- **Verified procedure**：只有observable test/build/environment receipt支持的成功步骤才能成为candidate；memory提供建议，不恢复旧approval，也不能直接执行。
- **Verified reflection/ACE**：只保存test/build/environment证明过的delta及helpful/harmful计数；raw reflection、自由文本“经验”或自动active instruction不进入产品路径。

### 10.4 FAL0共用评测底座

在实现任一adapter前，先用8–16 focused hours冻结一个轻量FAL0（Frontier Adapter Lab baseline 0）measurement envelope与concrete runner，不建立企业级gate。FAL0共用的是report schema、metric语义、G0–G5 gate和baseline/candidate比较方法；每张card使用自己的applicable case pack，不强迫context folding运行embedding retrieval case，也不能用`not_applicable`凑数量。

Case数量本身不是证据充分性。每个case必须标明且由runner机械证明其role与provenance：

- `generated_fixture`只证明mechanics；
- `verified_route_fixture`证明走过live code path，但不证明payload来自真实workload；
- `calibration`只允许选择冻结参数，且必须实际触发被校准的分支；
- `known_regression`只防止已知错误复发，不能再次称blind；
- `family_disjoint_evaluation`只评估冻结candidate，不允许回调参数；
- `trace_replay`才可支持当前BornAgent真实workload收益；
- `stress`只证明边界和成本，不能补足representative/trace数量。

整个frontier lane的起始BornAgent cases至少逐步覆盖：

- exact、paraphrase、中文改写与negative/abstention；
- supersede、retract、temporal与conflict；
- wrong principal/repository、missing/tampered source；
- memory正确或错误地改变tool/action参数；
- poisoned instruction、旧approval复活、跨repository诱导与高风险effect canary。

每个experiment revision固定自己的corpus identity；旧case可作为regression复用，但新的calibration/evaluation必须用新identity与group-disjoint families。至少报告correctness/quality、token、wall latency、model/tool calls、storage、dependency/install size、startup、Windows pack结果与fallback。若AgentPoison canary未并入首版runner，可另设4–8 focused hours，但不得用安全case缺失宣称promotion eligible。

新的[`FAL Memory Shared Benchmark v1`](frontier-adapter-lab-shared-memory-benchmark-v1.md)把横向验证线落实为24条独立时间线、每条6个must-answer + 4个must-abstain probes。Local Embedding位于retrieval层，Context Folding位于verified-receipt projection层；二者使用A/B/C/D四arm与同一canonical pool，但Recall、fold exactness、reader grounded success和cost分别报告，不产生一个混合总分。Public development/calibration各60 probes已运行：embedding calibration Recall@5提升0.111111且无candidate-added safety case，CF在12/12 timeline均`not_beneficial`，fixed reader四arm must-answer grounded success均为0。Evaluation 120 probes仍只公开salted commitment，因reader gate与source freeze失败而未运行。

### 10.5 推荐实验顺序

推荐顺序是研究优先级，不是已承诺backlog：

1. FAL0 shared corpus/runner；
2. context folding lite；
3. local embedding + FTS rank fusion；
4. verified procedure；若目标是最快产品收益，可与第3项互换；
5. RecMem recurrence trigger；
6. 只有候选池和task horizon实际变长后才做PACE；
7. verified reflection delta；
8. graph multi-hop；
9. ARC与automatic formation/evolution最后研究。

因此“第一个方向”按目标区分：学习先锋context engineering选context folding lite；补齐retrieval选local embedding hybrid；追求直接产品收益选verified procedure。三者不是互相矛盾的总冠军。

首张experiment card[`FAL-CF0 — FAL0 Baseline and Context Folding Lite`](frontier-adapter-lab-fal0-context-folding-lite.md)留下了immutable v1 receipt：lossless/security mechanics通过，但没有trace-backed workload；字面Spec要求4个`representative + verified_route`，case pack实际只有3个，而validator错误地只统计7个all-class verified routes。因此v1只能支持fixture mechanics，不能支持“代表性净收益不足”的产品结论。CF2已在working tree按`reimplementation_from_v1_contract`重写tiny candidate：20/20 mechanics通过、7例走真实verifier/projector route、5例为security case，源码保留disabled且production import/pack为0；但合格naturalistic trace与model-quality task均为0，所以`productFit=inconclusive`、promotion blocked。第二张experiment card[`FAL-EM0 — Local Embedding + FTS Rank Fusion`](frontier-adapter-lab-fal-em0-local-embedding-hybrid.md)的v1 receipt证明旧pinned multilingual E5在3-row cases上提高semantic ranking、成本可控且actual forbidden target leak为0，但calibration不足。EM-R1现已保留重建源码、pinned lock/model manifest、双128-row corpus与完整9,538点curve：12个self-frozen anchors一致，16个effective vector negatives和8个baseline collision可在delta gate下不退化，但任何threshold的semantic top-5最多8/16，未达到13/16。Rehydrated artifact与旧manifest不一致、历史输出只匹配26/36，所以不能把差异单独归因data、selector、RRF或model；旧evaluation未解析/评分但文件被manifest verifier读取，且semantic family-disjoint被审计refute，现只作known regression。CF2与EM-R1源码均按v2规则保留disabled，product integration从未发生。共享benchmark作为第三张横向card已完成development/calibration四arm执行；结论分别为embedding `retrieval_calibration_passed_only`、CF `not_selected_no_shared_benefit`、reader/evaluation `blocked`。

### 10.6 Research anchors

每个实验开始时必须重新核验primary source、reference implementation、license与版本。当前方向的起始锚点按机制分组如下：

- Context management：[PACE](https://aclanthology.org/2026.acl-long.1252/)、[Context Folding](https://openreview.net/forum?id=lNRgWoGfYg)、[FoldAgent](https://github.com/sunnweiwei/FoldAgent)、[ARC](https://aclanthology.org/2026.findings-acl.930/)与[ACE](https://arxiv.org/abs/2510.04618)；
- Retrieval/formation：[multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small)、[Multilingual E5 report](https://arxiv.org/abs/2402.05672)、[RRF](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)、[Selective Classification](https://papers.neurips.cc/paper_files/paper/2017/hash/4a8423d5e91fda00bb7e46540e2b0cf1-Abstract.html)、[Selective QA under Domain Shift](https://aclanthology.org/2020.acl-main.503/)、[Transformers.js Node](https://huggingface.co/docs/transformers.js/main/tutorials/node)、[RecMem](https://aclanthology.org/2026.findings-acl.1619/)、[Mem0](https://arxiv.org/abs/2504.19413)、[A-MEM](https://arxiv.org/abs/2502.12110)与[Hindsight](https://aclanthology.org/2026.acl-demo.27/)；
- Knowledge reuse：[HippoRAG 2](https://arxiv.org/abs/2502.14802)、[Zep / Graphiti](https://arxiv.org/abs/2501.13956)、[Agent Workflow Memory](https://proceedings.mlr.press/v267/wang25bx.html)、[Voyager](https://arxiv.org/abs/2305.16291)、[AFTER](https://arxiv.org/abs/2606.23127)、[Reflexion](https://arxiv.org/abs/2303.11366)与[ExpeL](https://arxiv.org/abs/2308.10144)；
- Evaluation/security：[LongMemEval](https://arxiv.org/abs/2410.10813)、[Mem2ActBench](https://aclanthology.org/2026.acl-long.370/)与[AgentPoison](https://proceedings.neurips.cc/paper_files/paper/2024/hash/eb113910e9c3f6242541c1652e30dfd6-Abstract-Conference.html)。

这些链接是研究入口，不是采用证明。每张card仍需写清BornAgent baseline、没有照搬的部分和复现实验结果。

### 10.7 Adapter promotion gate

Adapter从`mechanism_verified`到`promotion_eligible`必须先有一份独立promotion amendment，并同时满足：

1. 在固定 baseline 上有明确净收益，而不是只展示成功例；
2. adapter使用独立derived store；删除整个adapter目录后core logical dump不变；
3. disabled/crash/timeout/invalid output 均回到 baseline；
4. 对应authority filter发生在adapter前；memory cross-repository leak为0，context/task wrong-binding input为0；
5. adapter不得自动 activate candidate、写 current instruction 或触发 effect；
6. 额外 dependency、install size、startup、storage和Windows成本已测量；
7. 有真实 CLI/product观察点，而非只有内部 class。

未满足某项时记录对应轴为`not_demonstrated/blocked/not_run`；只有G1 safety/isolation或G2 implementation fidelity失败时才允许无范围地描述“当前candidate实现失败”。Promotion amendment通过后仍需按第8节另做`preview_usable`的跨平台、pack、restart与rollback证据。

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
- [x] `311c3cc`的GitHub `quality`与`windows-phase20` jobs重新执行repository gate和pack probe并通过；这只证明ML1–ML3候选；
- [x] 确认exact private state root、local principal和canonical root identity读取路径；
- [x] 本spec已冻结`Ml1EpisodeRecordV1`、exact range、builder template与episode-only store port；
- [x] 把第4.5节golden contract落为tracked fixture与manifest；
- [x] 冻结 `MEM-L01`–`MEM-L06` 的 focused manifest；
- [x] 给出8–16小时估算分解和stop condition；
- [x] 本spec已明确ML1完成后仍没有search/automatic recall/remember/retract。

本地实现仍不得扩张到embedding、graph、TUI、procedure、sync或Application registry全量迁移。ML1已随`311c3cc`获得exact-commit跨平台证据，Memory v1 core随后由ML5唯一演示与专用跨平台jobs闭环为`preview_usable`。

## 16. ML2 implementation evidence

- [x] Windows Node `v22.23.1` FTS5 `MATCH/bm25/rebuild/close/reopen` probe通过；
- [x] 冻结12-document coding corpus、12 positive queries、2 abstention queries与Recall@5/MRR门；
- [x] 冻结scope-per-derived-DB、Host-generated query grammar、rank order与candidate/result/text/token hard bounds；
- [x] 实现`memory search <query> --explain`，不接入Agent ContextPlan/ModelRequest；
- [x] wrong-scope 0、stale 0、100 candidate cap、recency tie、删除/损坏projection重建与canonical-change rebuild通过focused tests；
- [x] extracted tarball正向读取exact source、搜索available episode，并在删除retrieval projection后恢复相同logical hits；
- [x] 当前工作树lint/typecheck、1,310项non-PTY tests、适用PTY与clean build通过；
- [x] `311c3cc`的GitHub Linux/Windows repository gate与packed artifact均通过；该切片当时不单独标`preview_usable`，现已由ML5闭环覆盖。

## 17. ML3 implementation evidence

- [x] 冻结`RecallSelectionV1`、每request identity、3-record与`min(1,024 tokens, 8% compaction target)`合同；
- [x] 冻结poisoning/effect fixture与5项blocking evidence manifest；
- [x] 实现ML2 candidate之后的canonical scope/hash refetch与第二次exact source verification；
- [x] 实现固定delimiter/canonical JSON的`historical_memory` ContextItem，authority固定为`historical_only`、low priority且不进入ProtectedFactLedger；
- [x] Context core在plan前再次拒绝record/token超限、protected/pairing或authority elevation；
- [x] 新进程Session B通过真实product path使用Session A episode；off和provider-network均为0条注入，remote路径不创建FTS projection；
- [x] installed tarball直接加载ML3模块并通过bounded historical-only preparation probe；
- [x] 当前工作树lint/typecheck、1,315项non-PTY tests、适用PTY与clean build通过；
- [x] `311c3cc`的GitHub Linux/Windows repository gate与packed artifact均通过；该切片当时不单独标`preview_usable`，现已由ML5闭环覆盖。

## 18. ML4 implementation evidence

- [x] 冻结直接本地MemoryService mutation而不扩张Phase21 ApplicationService的单consumer边界；
- [x] 实现schema 1到schema 2原子迁移，旧episode canonical JSON、ID与hash原样成为revision 1，并补deterministic `ADD`；
- [x] 实现strict explicit fact/preference/decision/constraint `MemoryRecordV1`、stable logical ID、immutable revision与typed `ADD/SUPERSEDE/RETRACT` ledger；
- [x] 实现`memory remember/retract/rebuild/doctor`，human与JSON投影来自同一MemoryService结果；
- [x] ML2/ML3升级为active-only record/revision refetch，superseded与retracted revision在manual/automatic recall均为0；
- [x] builder、SQLite transaction与FTS rebuild三层secret admission通过，fixture secret的canonical/FTS rows均为0且错误不回显；
- [x] 10,000 revision/64 MiB record cap与20,000 operation/64 MiB reserve冻结；record cap满时新episode/remember停止，retract仍成功且重复retract不增长；
- [x] `fts5-v2`绑定record/revision identity；删除整个retrieval后canonical logical hash不变，显式rebuild恢复active search；
- [x] 本地全部16个`agent-memory`文件/54测试通过；完整repository gate的non-PTY 288 files/1,323 tests、适用PTY与clean build通过；
- [x] final extracted-tarball smoke真实执行ML1 close/reopen、ML2 search/rebuild、ML3 bounded historical context与ML4完整lifecycle；
- [x] ML4已进入ML5 exact release commit并通过唯一发布演示及专用同一SHA Linux/Windows jobs；Memory v1 core标为`preview_usable`。

## 19. ML5 release evidence

- [x] 冻结唯一11步fixture、4-case blocking manifest和不含用户文本的machine-readable pack receipt；
- [x] extracted tarball通过7个独立Node Agent进程完成mode-off baseline、Session A terminal ingest、Session B episode recall、explicit new-session recall、retract、wrong repository、rebuild与final off；
- [x] list/show/search explain保持exact source与`historical_only`；retracted record uses=0、wrong repository records=0、remote billable requests=0；
- [x] 删除整个derived retrieval后canonical logical hash和active hit order不变；前后mode-off stable non-memory request shape相同；
- [x] 演示暴露的第二repository non-zero catalog-head binding已修复，并由Phase21A顺序双仓库回归覆盖；
- [x] 本地17个`agent-memory`文件/56测试、non-PTY 289 files/1,326 tests、适用PTY、clean build与final extracted-tarball 11/11 demo通过；
- [x] 整仓`quality/windows-phase20`的无关Phase9/16/20 timing在两轮candidate CI中触发stop rule；ML5验收已收窄为专用`memory-v1-linux`/`memory-v1-windows` focused contract + pack jobs，不删除或伪装原整仓失败。
- [x] exact commit `e329a4b4aad968870505e36ba0bfc1b4d7e00511`的`memory-v1-linux`与`memory-v1-windows`均通过focused contract和packed demo；两项成功路径要求绑定同一`GITHUB_SHA`的`memory_v1_release_demo_passed` receipt，因此Memory v1 core标为`preview_usable`。
