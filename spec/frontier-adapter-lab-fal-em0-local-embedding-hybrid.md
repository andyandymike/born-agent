# FAL-EM0 — Local Embedding + FTS Rank Fusion Experiment Spec

> 状态：historical EM0/EM1 v1 receipt closed；EM-R1 corpus revision 2、retained candidate与calibration evidence已完成，calibration refuted、evaluation未评分、promotion blocked；后续审计确认旧evaluation文件曾被manifest verifier读取且semantic family-disjoint不成立，现降级为`known_exposed_holdout_development_only`（2026-08-29）
> Parent contract：[`Lightweight Memory Core and Frontier Adapters Spec`](agent-memory-lightweight-core-and-adapters.md)
> Predecessor：[`FAL-CF0 — Context Folding Lite`](frontier-adapter-lab-fal0-context-folding-lite.md) v1 receipt已完成；CF2 redesign已冻结
> Existing product baseline：Memory v1 ML5 `preview_usable`；production默认 `off`
> Historical timebox：8–16 focused hours；EM-R1 has a new 8–16 focused-hour budget
> Product default：unchanged；EM-R1 candidate源码/tests/lock/manifest保留disabled，模型与derived DB仅留在ignored lab cache，production adapter/import/package dependency不存在

## 0. 文档地位与当前决定

本spec冻结Frontier Adapter Lab的第二张experiment card：先用独立、hash-bound语料量化BornAgent当前FTS5 + recency在中文改写、同义表达、英文paraphrase和中英跨语言query上的真实缺口；只有baseline gate证明缺口存在，才允许实验一个固定模型、一个固定fusion算法和一个可整目录删除的derived vector store。

本card的唯一intervention是：

```text
current exact / quoted / FTS5 retrieval
  + one pinned local multilingual embedding model
  + bounded exact cosine top-k
  + deterministic reciprocal-rank fusion
```

它继承并细化下列Frontier Adapter Lab不变量：

1. 一次只进行一个active experiment；
2. principal/repository hard scope必须发生在adapter之前；
3. adapter只读canonical active memory，且只能写独立derived store；
4. exact-ID和quoted-phrase语义不变；
5. result返回前仍须重新读取canonical record并检查source freshness；
6. disabled、missing model、corrupt index、throw、timeout或invalid output必须返回existing lexical baseline；
7. adapter不得写canonical memory、current instruction、approval、effect、Goal/Plan或provider policy；
8. `lab_verified`只表示隔离实验通过，不表示`preview_usable`或production默认启用；
9. v1历史上使用`baseline_sufficient/lab_verified/rejected/inconclusive`；EM-R1必须使用父合同evidence-protocol v2的正交结论，不能扩张为vector platform。

EM0完成36-case live lexical baseline：hard-gate failure为0、security leak为0，12个当时冻结的semantic cases的Recall@5与MRR@5均为0，因此entry gate允许EM1。EM1随后以固定`0.78`阈值运行evaluation：semantic Recall@5为1.00、MRR@5为0.7083，全部成本门通过，wrong-scope、stale、retracted target进入embedding input/vector row/hit均为0；但3个`must_abstain` cases返回了当前scope内安全但无关的distractors。v1把这类precision/abstention false accept与security invariant折叠成一个hard failure并写`rejected`，随后删除candidate/model/vector dependency。

Evidence-protocol v2保留上述机器事实，但撤销“已证明算法或模型有问题”的因果解释：8个calibration中只有2个negative，其中`!!! ???`绕过embedding，真正校准向量拒答的负例基本只有1个；每个quality case只有3条records，多个security cases还复用同一distractor模板。当前只能判定v1固定candidate不适合promotion，不能判定失败来自data、single-threshold selector、RRF或E5模型。

### 0.1 EM0实验结论

EM0实现与证据见[`Local Embedding Hybrid 实验记录`](../docs/agent-memory/local-embedding-hybrid-experiment-record.md)和[`machine receipt`](../fixtures/frontier-adapter-lab/fal-em0-local-embedding-v1/experiment-receipt.json)。当前working-tree corpus固定36 cases、8 calibration / 28 evaluation；exact、phrase、scope、source、supersede/retract和action-sensitive硬门全部通过。当前FTS在12个词面不重叠的中文、英文与cross-lingual blind semantic cases中没有召回golden target，满足“Recall@5低于75%或至少5例miss”准入门。该fixture/receipt目录在EM-R1开始时仍未进入Git；本轮按用户明确重试要求保留原字节并以`working_tree_full/sourceCommit=null`运行，记录为durability contract deviation，不能称为exact-commit或durably immutable evidence。

### 0.2 EM1历史结果与证据更正

EM1 receipt的logical SHA-256为`a6a9c5563b421342c7c21f1d1efb0470cdd04aa322ff4b77a2c0ec5ce4b88b6c`，actual focused minutes为60。Model artifacts为135,138,424 bytes、conservative lab dependency closure为356,256,406 bytes、pack delta为18,305 bytes且model bytes为0；Windows cold load、warm embedding、10k scan、hybrid和vector-store gates全部通过。历史机器outcome和3个abstention false accepts不改；按v2解释为`evidenceValidity=limited`、`implementationFidelity=inconclusive`（源码已删除，不能复核）、safety/isolation claim supported、semantic-ranking claim supported、v1 fixed-selector abstention claim refuted on known fixtures、root-cause claim inconclusive、`productFit=inconclusive`、`promotion=blocked`、`direction=revise`、`reproducibility=corpus_only`、`candidateLifecycle=removed_legacy_policy`。不在同一experiment revision内使用evaluation改threshold、prefix、model、margin或fusion。

### 0.3 EM-R1审计更正与替代测试集

EM-R1原始receipt与logical SHA `4e20762f11447a136423699bda44ac09268374f62f8907fa603a59ecc084220f`保持不变，追加[`evidence-correction-v2.json`](../fixtures/frontier-adapter-lab/fal-em-r1-selective-hybrid-v2/evidence-correction-v2.json)。审计确认runner在calibration阶段为全manifest验hash而读取evaluation文件，只是未解析/评分cases；`scenarioFamilyId/queryTemplateId/distractorPoolId`又由split前缀构造，语义孪生主题没有真正隔离。因此本spec第16节的strict sealed/group-disjoint设计意图没有被该实现满足，旧evaluation不能再用于blind promotion或后续调参。

保留的历史结论是：当前reimplementation在旧48-case calibration上没有eligible global threshold、evaluation scoring未运行、promotion blocked。后续比较已改用[`FAL Memory Shared Benchmark v1`](frontier-adapter-lab-shared-memory-benchmark-v1.md)的24条独立时间线、2×2分阶段指标与one-shot salted commit/reveal；public development/calibration上embedding通过retrieval-stage gate。固定Qwen 2B reader must-answer grounded success为0；相同packet的DeepSeek Flash diagnostic恢复fixed-packet回答并观察到development `+0.050000`、calibration `+0.066666` embedding effect，但冻结calibration reader gate因abstention-semantics regression失败。历史receipt中的`end_to_end_benefit_observed`已由[`effect-scope correction`](../fixtures/frontier-adapter-lab/fal-memory-shared-v2/agent-memory-effect-scope-correction-v1.json)撤回并改名为`retrieval_to_fixed_packet_reader_effect_observed`；BornAgent Agent+Memory任务效果仍为`not_tested`，product fit未评估，evaluation未运行。

## 1. Live baseline：现在的Memory retrieval到底做了什么

当前真实调用链是：

```text
memory search query
  -> Host normalizes query and builds safe FTS expression
  -> exact_id bypass OR quoted_phrase / lexical FTS5
  -> at most 100 FTS candidates
  -> BM25(title=3, text=1), occurredAt, stable IDs
  -> canonical record refetch + revision/time check
  -> exact phrase verification when applicable
  -> source availability inspection
  -> fixed result/text/token budgets
  -> optional ML3 automatic recall
  -> canonical refetch + source revalidation again
  -> <=3 low-priority, unprotected, historical_only excerpts
```

具体baseline固定为：

- query UTF-8上限1,024 bytes、最多16个Host解析terms；
- FTS candidate cap为100；
- 默认返回5条、最多20条；
- 单次search最多16 KiB文本与4,096 estimated tokens；
- FTS5用`bm25(records_fts, 0, 0, 0, 3, 1)`排序，title权重3、text权重1；
- BM25同分时按`occurredAt`倒序，再按record/revision ID稳定排序；
- exact record ID不依赖FTS；
- quoted phrase必须在current canonical title/text中真的出现，不能用语义近似替代；
- FTS projection是可删除重建的`fts5-v2` derived store，不是事实源；
- ML3 automatic recall仍受自己的最多3条和`min(1,024 tokens, 8%)`注入边界约束；
- stale/missing source、superseded/retracted revision和scope外记录不能成为最终hit。

### 1.1 已知能力

当前baseline擅长：

- exact record ID；
- query与memory共享关键词的中文/英文检索；
- quoted exact phrase；
- 明确时间排序与current revision；
- 无模型、无网络、低启动成本；
- projection损坏时从canonical logical dump重建。

### 1.2 待证实缺口

当前baseline可能错过：

- “给发布包做离线检查”与“validate the installed artifact without network”这类词面重叠很少的paraphrase；
- 中文query找英文memory，或英文query找中文memory；
- 同义词、缩写展开和自然改写；
- 关键词只出现在错误distractor，而正确memory只在语义上相关的collision case。

“embedding理论上更聪明”不构成实现理由。EM0必须先让同一组golden cases证明上述缺口在BornAgent真实query contract下存在。

## 2. 研究选择与最小技术栈

### 2.1 首选模型

若EM0允许进入EM1，首选候选为`Xenova/multilingual-e5-small`的Transformers.js兼容ONNX版本，其上游为`intfloat/multilingual-e5-small`：

- multilingual E5方向，适合中文、英文和cross-lingual retrieval；
- output dimension固定384；
- model max positions为512；
- upstream license为MIT；
- 首选`int8`或等价`quantized` ONNX权重；当前公开artifact约118 MB，完整selected manifest仍须在实现时实测；
- CPU/Node 22为首个实验runtime；WebGPU、CUDA和remote inference不在本card内。

模型ID或`main`分支不是可复现identity。EM1开始前必须冻结：

```ts
interface FalEm0ModelArtifactManifestV1 {
  readonly schemaVersion: 1;
  readonly upstreamModelId: "intfloat/multilingual-e5-small";
  readonly runtimeModelId: "Xenova/multilingual-e5-small";
  readonly revision: string; // full immutable commit SHA, never "main"
  readonly license: "MIT";
  readonly dtype: "int8" | "quantized";
  readonly dimensions: 384;
  readonly maxModelTokens: 512;
  readonly files: readonly {
    readonly relativePath: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly manifestSha256: string;
}
```

实现时必须重新核验exact revision、license、selected ONNX、tokenizer和config文件；任何字段不明确，结果为`inconclusive`，不能临时换模型继续。

### 2.2 为什么不是all-MiniLM或vector database

- `all-MiniLM-L6-v2`可作小模型smoke，但不作为中文或cross-lingual质量结论；
- 不比较多个embedding model，不做model tournament；
- 不引入Pinecone、Qdrant、Weaviate、Milvus、pgvector或常驻服务；
- 不引入HNSW、IVF、GPU kernel或background daemon；
- Memory v1每scope已有10,000 active/revision量级hard bound，首版先测384维Float32 exact scan是否足够；
- 10,000 × 384 × 4 bytes的raw vector约14.7 MiB，先验证真实延迟、dependency和模型成本，再决定是否需要ANN。

### 2.3 模型获取边界

Transformers.js默认可以在首次使用时从Hub下载并缓存；BornAgent实验不能把这个side effect藏进search：

1. 普通`born`、`memory search`、test和pack smoke永远不自动下载模型；
2. 只有用户显式运行lab的`prepare-model`动作时可以联网；
3. prepare后生成上面的artifact manifest并逐文件hash；
4. baseline和compare run都必须设置remote models disabled，只读显式`--model-root`；
5. model files保存在ignored lab root，不提交Git、不进入npm pack、不进入canonical memory；
6. missing/hash mismatch必须typed fail并回到baseline，不能fallback到网络或另一个model revision。

## 3. 目标与明确不做

### 3.1 必须交付

1. 一个tracked、无secret、hash-bound的36-case retrieval corpus；
2. 一个先运行current production FTS路径的EM0 baseline runner；
3. baseline gap receipt，明确哪些case失败、为什么失败；
4. 只有entry gate通过后才存在的local embedding provider；
5. 一个独立SQLite Float32 vector projection与bounded exact scan；
6. 一个固定RRF算法，不训练权重、不手调每个case；
7. exact/quoted bypass、scope-before-adapter、canonical refetch和source revalidation证明；
8. recall@k、MRR、abstention、latency、startup、storage、install/pack delta和local inference calls；
9. missing/corrupt/timeout/invalid candidate到byte-equivalent lexical baseline的fallback；
10. machine-readable experiment receipt和中文学习记录。

### 3.2 明确不做

- 不把embedding接入production `memory search`或ML3 automatic recall；
- 不更改`Ml2SearchResultV1`、retriever version或`born memory` CLI；
- 不把vector score写入canonical memory；
- 不做memory自动抽取、自动合并、RecMem、PACE、graph或procedure；
- 不新增remote provider、API key、telemetry或billable call；
- 不chunk整仓代码或建立repository-wide RAG；
- 不训练、蒸馏或微调embedding model；
- 不让embedding结果恢复旧approval或成为current instruction；
- 不以synthetic paraphrase、单个demo或模型card数字宣称product quality；
- 不建立generic adapter registry、generic vector interface或第二套Memory Store；
- 不在本spec内晋级`preview_usable`；product接入必须另写promotion amendment。

## 4. 实验切片、entry gate与假设

### 4.1 EM0 — freeze corpus and characterize lexical baseline

EM0只允许fixture、baseline runner、metrics、tests和receipt；不新增embedding dependency，不下载model。

EM0先对全部36 cases运行current`LexicalMemorySearchService`。候选entry gate必须同时满足：

1. manifest/golden hash通过，36 cases均能执行；
2. exact/quoted、scope、freshness和negative baseline观察没有runner错误；
3. 28个blind evaluation cases中至少12个为semantic representative；
4. 这12个semantic cases的baseline Recall@5低于75%，或至少5例golden target未进入top 5；
5. 缺口来自词面不重叠/paraphrase/cross-lingual，而不是错误scope、错误revision、stale source、fixture typo或FTS projection bug。

若第4或第5项不成立，outcome固定为`baseline_sufficient`，EM1文件和dependency不得创建。修baseline bug不属于embedding intervention；应另开fix并重新跑EM0。

### 4.2 EM1 — pinned local embedding mechanism

只有EM0 receipt写出`candidatePermitted: true`后才允许：

- 增加exact-version lab-only Transformers.js dependency；
- 显式准备一个exact model artifact；
- 对query与scope-filtered active records生成embedding；
- 建立可删除vector projection；
- 运行vector top-k与RRF candidate；
- 只用calibration split选择一个全局similarity threshold；
- 冻结threshold后运行blind evaluation split。

### 4.3 假设

- **H0 / baseline sufficient**：FTS + recency已满足当前BornAgent memory query；semantic recall缺口不足以抵消约118 MB模型、local inference与新derived store。
- **H1 / hybrid useful**：在固定scope、top-k、result/token budget下，hybrid使blind semantic Recall@5提高至少20 percentage points并达到80%，同时exact/phrase/temporal/abstention/security不退化，且本地成本落在第8节预算内。

证明H0、拒绝H1或得到inconclusive evidence都是有效学习结果。实验价值不按新增代码量衡量。

## 5. FAL-EM0 corpus合同

### 5.1 固定36 cases

首版case pack固定36个cases：

| Category | Count | Purpose |
|---|---:|---|
| exact / phrase / lexical controls | 6 | exact ID、quoted phrase、共享关键词、stable ordering |
| Chinese paraphrase / synonym | 8 | 中文改写、近义词、缩写与低词面重叠 |
| English paraphrase | 4 | English task/memory rewording |
| cross-lingual zh ↔ en | 4 | 中文query找英文memory及反向 |
| temporal / update / conflict | 4 | supersede、retract、latest applicable fact、action-sensitive stale distractor |
| negative / abstention / collision | 4 | unrelated query、only distractor、low-confidence semantic neighbor |
| security / scope / freshness / poison | 6 | wrong repository/principal、stale/tampered source、instruction-shaped memory |
| **Total** | **36** | 至少24 representative；security不少于6；stress不超过6 |

每个case使用独立temporary scope或显式shared-scope group，避免一个case的record成为另一个case的偶然golden。每个scope包含3–12条active/distractor records；另有一个不调用embedding的10,000-vector synthetic scaling fixture。

至少4个representative cases标记`actionSensitive: true`：golden record包含正确的下一步参数，forbidden record包含过时或高风险参数。它们只机械检查retrieved evidence是否支持正确参数，不让lab runner执行tool/effect。

### 5.2 v1 Calibration与evaluation split（历史、不得再次称blind）

36 cases固定分为：

- 8个`calibration` cases：4 semantic、2 negative/collision、2 lexical/temporal；
- 28个`evaluation` cases：至少12 semantic、4 exact/phrase/lexical、4 temporal/update、2 negative，且全部critical security cases都在此split。

Goldens都tracked，但candidate implementation在threshold selection API中只能读取calibration结果。Runner在threshold冻结后才加载evaluation expected fields；receipt记录`thresholdFrozenBeforeEvaluation: true`。这些evaluation cases现在已经公开、运行并用于根因讨论，后续只能作为`known_regression`；任何新candidate必须换experiment revision、group-disjoint calibration/evaluation和完整baseline。

### 5.3 Fixture layout

```text
fixtures/frontier-adapter-lab/fal-em0-local-embedding-v1/
  manifest.json
  cases.json
  experiment-receipt.json
```

`cases.json`只保存无secret synthetic/local-free memory records和独立人工golden。不得保存真实用户memory、absolute path、credential、provider prompt或从candidate输出反向生成的expected IDs。

```ts
interface FalEm0CorpusManifestV1 {
  readonly schemaVersion: 1;
  readonly experimentId: "fal-em0-local-embedding-hybrid-v1";
  readonly casePackRef: "cases.json";
  readonly casePackSha256: string;
  readonly caseIds: readonly string[];
  readonly calibrationCaseIds: readonly string[];
  readonly evaluationCaseIds: readonly string[];
  readonly corpusContractSha256: string;
  readonly manifestSha256: string;
}
```

每个case至少定义：

- `caseId`、`class`、`split`、`category`；
- exact principal/repository/scope facts；
- canonical revisions、active/superseded/retracted状态与source fixture；
- raw query与expected parsed query kind；
- ordered `relevantRecordIds` 和 `forbiddenRecordIds`；
- `expectedAbstention`；
- `actionSensitive`及可选expected/forbidden parameter facts；
- baseline failure是否可计入EM1 entry gate。

`manifestSha256`覆盖除自身外全部canonical fields，并绑定`cases.json`的exact SHA-256。Goldens先于candidate冻结；改一个case必须生成新manifest identity。

## 6. Embedding exact contract

### 6.1 Text projection

只对`lexical` query启用candidate。`exact_id`、`quoted_phrase`和`no_searchable_terms`继续走baseline且embedding calls为0。

输入固定为：

```text
query input:
  "query: " + normalizedQuery

record input:
  "passage: " + normalizedTitle + "\n" + normalizedText
```

其中：

- normalization复用ML2的NFC、CRLF→LF、whitespace collapse和trim语义；
- episode title使用`taskPreview`；其他record使用现有kind/title projection，不发明LLM title；
- tokenizer truncation固定为512 model tokens；
- 不做semantic chunking、sliding window或摘要；
- pooling固定mean pooling；
- output固定L2 normalized Float32、384维；
- NaN、Infinity、维度错误或norm不在`1 ± 1e-3`内即`candidate_invalid`；
- record vector identity绑定完整record/revision identity、full source reference hash、model artifact hash和projection schema；即使512-token projection相同，不同canonical revision也不复用identity。

long-tail fact若因512-token truncation未进入vector，由lexical union保底；本card不以隐式chunking扩大scope。若blind corpus证明这是主要缺口，结果记为`inconclusive/rejected`并另写chunking experiment。

### 6.2 Vector projection

Vector projection是独立、可删除的lab derived store：

```text
.bornagent/labs/frontier-adapters/fal-em0/v1/
  models/<model-manifest-sha256>/
  scopes/<scope-sha256>/vectors.sqlite
```

SQLite最小逻辑字段为：

```ts
interface FalEm0VectorRowV1 {
  readonly recordId: string;
  readonly revisionId: string;
  readonly occurredAt: string;
  readonly projectionInputSha256: string;
  readonly modelManifestSha256: string;
  readonly dimensions: 384;
  readonly vectorFloat32Le: Uint8Array;
}
```

Projection metadata至少绑定：

- exact principal/repository scope hash；
- canonical logical dump hash；
- active revision set hash；
- model artifact manifest hash；
- tokenizer/config/prefix/pooling/truncation schema hash；
- row count与database logical hash。

写入使用temporary file + atomic replace；partial/corrupt/wrong-scope/wrong-model database不得复用。显式lab build可重建；normal compare query遇到invalid projection必须回到lexical baseline，不能悄悄联网或读其他scope。

### 6.3 Bounded vector retrieval

Vector branch只扫描已经通过exact principal/repository scope的active records：

1. input active records上限沿用Memory v1的10,000量级hard bound；
2. exact cosine scan读取384维Float32 vectors；
3. cosine结果量化为`similarityMicros = round(cosine * 1_000_000)`；
4. 先过滤低于frozen global threshold的rows；
5. 排序为`similarityMicros DESC, occurredAt DESC, recordId ASC, revisionId ASC`；
6. vector branch最多保留100 candidates；
7. FTS branch仍最多100 candidates；
8. union去重后最多200 candidates；
9. 每个union candidate都重新读取canonical record、核对revision/time并检查source availability；
10. invalid/stale/superseded/retracted candidate在fusion前删除。

Scope过滤必须发生在embedding adapter和scan之前，而不只是最终结果之后。Wrong-scope record进入vector provider input或vector DB row count都算hard leak，即使最终没返回。

### 6.4 Deterministic rank fusion

只允许unweighted Reciprocal Rank Fusion：

```text
rrfScore(record) =
  (present in lexical branch ? 1 / (60 + lexicalRank) : 0)
  +
  (present in vector branch  ? 1 / (60 + vectorRank)  : 0)
```

Rank从1开始，`k=60`固定。不允许learned weight、per-language weight、per-case rule或recency bonus。最终排序：

1. RRF score descending；
2. lexical branch present优先；
3. vector `similarityMicros` descending；
4. `occurredAt` descending；
5. `recordId`、`revisionId` ascending。

结果仍使用现有default/max result、16 KiB text和4,096-token budgets。Candidate不得因为找到更多记录而扩大provider context；ML3若未来promotion仍必须保持最多3条和现有injected-token limit。

### 6.5 v1 Threshold selection（历史）

候选threshold只从固定grid选择：

```text
700000, 740000, 780000, 820000, 860000, 900000 similarityMicros
```

对每个threshold只运行8个calibration cases。Eligible threshold必须：

- calibration exact/phrase/lexical controls不低于baseline；
- calibration negative/collision新增forbidden hit为0；
- source/scope invariant全部通过。

在eligible thresholds中选择semantic MRR@5最高者；并列时选择更高threshold。没有eligible threshold则candidate直接`rejected`。选定后把threshold、calibration result hash和candidate implementation hash写入frozen receipt，再运行28个evaluation cases；不得重调。

## 7. Failure、fallback与authority contract

Candidate只产生ranked record IDs和diagnostic scores，不产生instruction、summary、fact、approval或action。

以下任一情况触发typed diagnostic并使用current lexical baseline：

- feature disabled；
- model artifact missing或SHA mismatch；
- runtime/model/tokenizer revision mismatch；
- vector projection missing、wrong scope、wrong model、partial或corrupt；
- query embedding timeout/throw；
- NaN/Infinity/wrong dimension/wrong norm；
- scan超过fixed candidate/runtime bound；
- canonical logical hash在projection后改变；
- candidate output含unknown/duplicate identity或超过candidate cap；
- fusion invariant失败。

Fallback必须满足：

```text
canonicalJson(fallbackSearchResult)
  === canonicalJson(directLexicalBaselineSearchResult)
```

允许另发typed lab diagnostic，但不得改search result、canonical store或ML3 context。Candidate fault不能使scope外/stale record可见，也不能把`no_available_match`改成semantic猜测。

Instruction-shaped memory保持`historical_only`、low-priority、unprotected content。Embedding similarity不是authority；它不能改变system/developer/user precedence、tool eligibility、approval或effect参数。Action-sensitive case只检查evidence selection，不执行动作。

## 8. Metrics、cost与hard gates

### 8.1 Per-case observation

```ts
interface FalEm0CaseResultV1 {
  readonly caseId: string;
  readonly split: "calibration" | "evaluation";
  readonly class: "representative" | "security" | "stress";
  readonly baseline: FalEm0RetrievalArmResultV1;
  readonly candidate: FalEm0RetrievalArmResultV1 | null;
  readonly correctness: {
    readonly requiredTop1: boolean;
    readonly requiredTop5: boolean;
    readonly forbiddenTop5Count: number;
    readonly abstentionCorrect: boolean;
    readonly sourceFresh: boolean;
    readonly scopeExact: boolean;
    readonly actionParameterSupported: boolean | null;
  };
  readonly cost: {
    readonly localQueryEmbeddingCalls: number;
    readonly localRecordEmbeddingCalls: number;
    readonly remoteModelCalls: number;
    readonly toolCalls: number;
    readonly networkCallsDuringSearch: number;
    readonly queryEmbeddingDurationMs: number | null;
    readonly vectorScanDurationMs: number | null;
    readonly totalSearchDurationMs: number;
  };
  readonly status: "pass" | "fail" | "not_applicable";
}
```

Retrieval arm至少记录ordered top IDs、Recall@1/5、reciprocal rank、abstention、candidate counts、text/token budget和logical result hash。Raw query、record text和vector不得进入machine receipt。

Wall time只作同机diagnostic；quality hard gate使用IDs、counts、hashes和fixed metric。Provider token/billed usage未发生时分别记录`null`与0语义，不混写。

### 8.2 EM0 baseline gate

EM0必须：

- 36/36 manifest和baseline executions有效；
- exact/quoted/scope/source行为与live implementation一致；
- entry-gate semantic cases和failure reason可独立复查；
- local model/dependency/network calls全部为0；
- baseline receipt可重复产生相同logical hash。

Entry gate不通过时，EM0以`baseline_sufficient`收口；不得为了继续实验而改golden或降低baseline。

### 8.3 v1 Candidate correctness/security gate（历史混合门）

EM1全部36 cases必须满足：

- exact ID、quoted phrase和no-searchable-terms route的candidate calls为0，result hash与baseline相同；
- wrong principal/repository进入embedding input、vector rows和hits均为0；
- stale/tampered/missing source、superseded/retracted revision进入hits均为0；
- returned IDs在use前100% canonical refetch与source revalidation；
- forbidden instruction、旧approval和高风险action parameter成功率不高于baseline；
- result/text/token budgets不变；
- remote model calls、tool calls和search-time network calls全部为0；
- disabled/missing/corrupt/timeout/invalid candidate fallback result与baseline byte-equivalent；
- 删除整个FAL-EM0 lab root后Memory v1 canonical logical dump/hash不变；
- model artifact不进入Git、npm pack、session event、receipt或provider context。

G1 safety/isolation任一项失败都必须阻止promotion，不能用平均Recall或latency覆盖；但safe current-scope distractor false accept属于G3 abstention/precision，不得再记为security leak。v1单一`rejected`字段保留为历史机器事实。

### 8.4 v1 Candidate quality gate（历史）

只有28个frozen evaluation cases用于最终quality结论。`lab_verified`必须同时满足：

1. EM0 entry gate已证明真实baseline semantic gap；
2. evaluation semantic Recall@5相对baseline提高至少20 percentage points；
3. candidate evaluation semantic Recall@5不低于80%；
4. semantic MRR@5相对baseline提高至少0.15；
5. exact/phrase/lexical control full-pass count不低于baseline；
6. temporal/update/conflict full-pass count不低于baseline；
7. negative/abstention false-positive count不高于baseline，且vector新增forbidden top-5 hit为0；
8. security leak/poison/freshness failure为0；
9. 至少4个action-sensitive cases中required parameter evidence进入top 5、forbidden parameter evidence为0；
10. threshold在evaluation前冻结，evaluation-driven tuning为0。

收益只来自stress cases、只提高Recall却显著降低rank、或需要per-case tuning时，结果为`rejected`或`inconclusive`，不能标`lab_verified`。

### 8.5 Local cost gate

首个lab reference machine必须记录CPU、RAM、OS、Node、Transformers.js、ONNX runtime和model manifest identity。工程预算固定为：

| Metric | Gate |
|---|---:|
| selected model + tokenizer/config artifacts | <=160 MiB |
| lab dependency unpacked install delta | <=350 MiB |
| production dependency set delta | 0 |
| packed `.tgz` size delta vs baseline | <=256 KiB，且model bytes为0 |
| cold model load on reference Windows CPU | p95 <=8 s |
| warm query embedding | p95 <=300 ms |
| 10,000 × 384 exact vector scan | p95 <=75 ms |
| warm hybrid search end-to-end | p95 <=450 ms |
| 10,000-row SQLite vector projection | <=32 MiB |
| remote model/tool/search-network calls | 0 |

Latency每项至少1次warm-up + 20次measured repetitions；cold load至少5个fresh processes。Windows focused evidence是lab gate；Linux和installed/packed execution若未运行必须写`not_run`，不能推断cross-platform/product readiness。

若硬件明显低于常见开发机，可在receipt中保留原始结果和`inconclusive_by_reference_hardware`，但不能事后放宽本card数字。若模型、dependency或latency超预算，优先拒绝candidate，不在同一card内换模型、quantization或ANN。

## 9. Experiment receipt

```ts
interface FalEm0ExperimentReceiptV1 {
  readonly schemaVersion: 1;
  readonly experimentId: "fal-em0-local-embedding-hybrid-v1";
  readonly sourceCommit: string | null;
  readonly manifestSha256: string;
  readonly baseline: {
    readonly retrieverId: "bornagent.lexical-memory-search";
    readonly retrieverVersion: "ml2-v2";
    readonly implementationSha256: string;
    readonly semanticRecallAt5: number;
    readonly semanticMrrAt5: number;
    readonly candidatePermitted: boolean;
    readonly entryGateReasons: readonly string[];
  };
  readonly candidate: null | {
    readonly implementationSha256: string;
    readonly modelArtifactManifestSha256: string;
    readonly vectorProjectionSchemaSha256: string;
    readonly thresholdSimilarityMicros: number;
    readonly thresholdFrozenBeforeEvaluation: boolean;
    readonly calibrationResultSha256: string;
    readonly semanticRecallAt5: number;
    readonly semanticMrrAt5: number;
  };
  readonly cases: readonly FalEm0CaseResultV1[];
  readonly aggregate: {
    readonly calibrationCases: 8;
    readonly evaluationCases: 28;
    readonly hardGateFailures: number;
    readonly securityLeaks: number;
    readonly vectorAddedForbiddenHits: number;
    readonly fallbackMismatches: number;
  };
  readonly cost: {
    readonly modelArtifactBytes: number | null;
    readonly dependencyInstallDeltaBytes: number | null;
    readonly packedArtifactDeltaBytes: number | null;
    readonly vectorStoreBytesAt10000: number | null;
    readonly coldLoadP95Ms: number | null;
    readonly warmQueryEmbeddingP95Ms: number | null;
    readonly vectorScan10000P95Ms: number | null;
    readonly hybridSearchP95Ms: number | null;
  };
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

`receiptSha256`覆盖除wall-time distribution、machine description、`sourceCommit`、`actualFocusedMinutes`和自身外的canonical logical fields。Machine facts与timing仍保存但不污染跨进程logical identity。

Receipt不得包含：

- raw memory/query/user text；
- Float32 vector或model bytes；
- absolute path、username、hostname、credential；
- provider prompt/reasoning；
-未hash的artifact location。

`sourceCommit=null`只能表示dirty/local evidence，不能冒充exact-commit或CI evidence。`not_run`不能写成`passed`或0 ms。

## 10. Mechanical acceptance cases

| ID | Case | Required result |
|---|---|---|
| `FAL-EM01` | exact record ID | embedding calls 0；exact baseline result hash |
| `FAL-EM02` | quoted phrase | exact phrase required；semantic substitute forbidden |
| `FAL-EM03` | lexical shared keywords | hybrid full-pass不低于BM25 baseline |
| `FAL-EM04` | Chinese paraphrase | expected semantic target进入top 5 |
| `FAL-EM05` | English paraphrase | expected semantic target进入top 5 |
| `FAL-EM06` | Chinese query → English memory | cross-lingual target进入top 5 |
| `FAL-EM07` | English query → Chinese memory | cross-lingual target进入top 5 |
| `FAL-EM08` | lexical collision distractor | semantic target提升且forbidden distractor不支配 |
| `FAL-EM09` | superseded revision | only active current revision eligible |
| `FAL-EM10` | retracted record | zero vector row/hit for retracted current state |
| `FAL-EM11` | wrong principal/repository | zero provider input、row和hit |
| `FAL-EM12` | stale/missing/tampered source | removed before result；use-time revalidation |
| `FAL-EM13` | instruction-shaped poisoned memory | no authority/approval/effect delta |
| `FAL-EM14` | unrelated/no-searchable query | correct abstention；no semantic guess |
| `FAL-EM15` | fixed result/text/token budgets | candidate cannot expand output budget |
| `FAL-EM16` | missing/corrupt/wrong model or DB | typed diagnostic + exact lexical fallback |
| `FAL-EM17` | embedding timeout/NaN/wrong dimension | typed diagnostic + exact lexical fallback |
| `FAL-EM18` | calibration/evaluation separation | threshold hash frozen before evaluation |
| `FAL-EM19` | repeated process run | same ranking/logical receipt hashes；timing may differ |
| `FAL-EM20` | 10,000-vector scaling fixture | cap、storage、scan p95 recorded |
| `FAL-EM21` | normal CLI/test/pack without model | zero download/network；baseline remains usable |
| `FAL-EM22` | delete lab root/candidate | canonical logical dump and baseline search unchanged |

## 11. Implementation map

EM0保留下列baseline files。标`historical EM1`的文件曾在entry gate通过后创建并用于当前working-tree receipt，最终因`rejected` cleanup删除；该receipt须先原样进入Git才成为durable evidence。

```text
fixtures/frontier-adapter-lab/fal-em0-local-embedding-v1/
  manifest.json
  cases.json

src/frontier-adapters/local-embedding/
  fal-em0-manifest.ts
  fal-em0-baseline-runner.ts
  fal-em0-receipt.ts
  fal-em0-fusion.ts                 # historical EM1; deleted after rejection
  fal-em0-vector-projection.ts      # historical EM1; deleted after rejection

labs/frontier-adapter-lab/fal-em0/
  transformers-e5-provider.ts       # historical EM1; deleted after rejection
  prepare-model.ts                  # historical EM1; deleted after rejection

scripts/run-local-embedding-lab.mjs
tests/unit/fal-em0-*.test.ts
tests/integration/fal-em0-*.test.ts
docs/agent-memory/local-embedding-hybrid-experiment-record.md
```

Cleanup后当前保留的root package script：

```text
pnpm lab:local-embedding -- --mode baseline --report <path>
```

历史EM1的`prepare-model`只在EM0 permit后存在，并在执行前明确报告联网和exact lab root；`compare`不联网。它们与exact lab-only dependency现已随rejection移除。当前working-tree receipt和学习记录保留其byte-frozen model/file identities，不保留模型bytes；receipt须先原样进入Git，才能称durably immutable。

本card不得修改：

```text
src/memory/core/**
src/memory/store/**
src/memory/recall/automatic-memory-recall-service.ts
src/memory/retrieval/ml2-search-contract.ts
src/memory/retrieval/lexical-memory-search-service.ts
src/memory/retrieval/fts5-episode-projection.ts
src/context/**
src/policy/**
```

Runner可通过现有public ports调用live baseline，不得复制一份“看起来像FTS”的假baseline。若实验必须修改上述production files、ML2 result schema或`born` CLI，本card立即停止并先写promotion amendment。

首个实现直接写concrete runner和candidate；第二个真实vector adapter证明共享接口有价值前，不抽象FAL SDK、embedding provider framework或vector repository。

## 12. v1实现顺序、预算与stop conditions

| Stage | Deliverable | Budget |
|---|---|---:|
| EM0.1 | freeze 36-case manifest/goldens and split | 2–3h |
| EM0.2 | live FTS baseline runner, metrics, faults, receipt | 2–3h |
| EM0 decision | `baseline_sufficient` or permit EM1 | 0.5h |
| EM1.1 conditional | pinned artifact prepare + local provider contract | 2–3h |
| EM1.2 conditional | vector projection, exact scan, RRF, fallback | 2–3h |
| EM1.3 conditional | calibration freeze + blind/security/cost runs | 2–3h |
| closure | machine receipt, learning record, focused checks | 1–2h |

预计EM0-only为4–6 focused hours；EM0+EM1为11–16 focused hours。

实际EM1由agent执行并记录60 focused minutes；这只描述本次具体实现，不反向修改原始人类工程预算。

以下任一情况立即停止新增功能：

- 到第6小时仍没有可重复的EM0 baseline receipt；
- baseline缺口其实是scope/source/revision bug或错误golden；
- baseline semantic Recall@5不满足candidate entry gate；
- 无法冻结full immutable model revision、license或artifact hashes；
- normal search需要自动下载或网络fallback；
- candidate要求修改canonical store、ML2/ML3 production contract或authority；
- wrong-scope record进入embedding input/vector rows；
- exact/phrase/temporal/abstention/security任一hard regression；
- evaluation结果被用于调threshold/prefix/model；
- selected model artifacts超过160 MiB、lab install delta超过350 MiB或需要不稳定native build；
- 10,000 exact scan或warm query超过cost gate，且只有引入ANN/第二模型才能补救；
- 真实收益只存在于stress/synthetic cases；
- focused time达到16小时。

硬停后可保留baseline、failed receipt和学习记录；不得用“模型已经下载/时间已经投入”作为继续扩scope的理由。

## 13. v1历史实验演示

```text
1. Validate tracked manifest/cases hashes and split.
2. Create isolated temporary Memory v1 scopes from each case.
3. Run live LexicalMemorySearchService for all 36 cases.
4. Emit EM0 receipt and apply candidate entry gate.
5. If baseline_sufficient, stop; prove no model/dependency/vector files exist.
6. If permitted, explicitly prepare and hash the one pinned local model.
7. Build scope-filtered active-record vector projections.
8. Select one global threshold using calibration cases only.
9. Freeze threshold/candidate hashes.
10. Run blind evaluation, security/fault/fallback and action-sensitive cases.
11. Run cold/warm latency, 10,000-vector storage/scan and pack-delta measurements.
12. Delete/disable candidate and prove lexical result + canonical dump hashes restore.
13. Emit one machine receipt and Chinese learning record.
```

没有第3、4步不能声称理解baseline；没有第8、9步不能声称blind comparison；没有第10步不能称semantic quality；没有第11步不能称lightweight；没有第12步不能称isolated/deletable adapter。以上是v1历史流程；EM-R1以临时lab副本和import/pack graph证明deletability，只删除weights/vector/cache，不再删除唯一candidate源码。

## 14. 研究来源与没有照搬的部分

- [multilingual-e5-small upstream model](https://huggingface.co/intfloat/multilingual-e5-small)提供多语言E5模型、license与模型配置入口；
- [Transformers.js-compatible ONNX artifacts](https://huggingface.co/Xenova/multilingual-e5-small/tree/main/onnx)提供Node可运行的quantized artifact候选；
- [Transformers.js pipelines](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/docs/source/pipelines.md)提供feature-extraction、revision、cache与dtype接口；
- [Transformers.js Node tutorial](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/docs/source/tutorials/node.md)说明Node运行和首次下载/cache行为；
- [E5原始论文](https://arxiv.org/abs/2212.03533)与[Multilingual E5 technical report](https://arxiv.org/abs/2402.05672)提供ranking/representation研究背景，但不提供open-set abstention保证；
- [multilingual-e5-small官方model card](https://huggingface.co/intfloat/multilingual-e5-small)明确说明低温度InfoNCE使cosine集中在约`0.7–1.0`，重点是相对排序而非可跨corpus解释的绝对confidence；
- [Reciprocal Rank Fusion](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)定义rank aggregation与历史`k=60`，不定义relevance admission或no-answer判断；
- [Selective Classification](https://papers.neurips.cc/paper_files/paper/2017/hash/4a8423d5e91fda00bb7e46540e2b0cf1-Abstract.html)提供selection function与risk–coverage框架，[Selective QA under Domain Shift](https://aclanthology.org/2020.acl-main.503/)说明只依赖原模型confidence的拒答在distribution shift下可能失效；将其用于memory retrieval是BornAgent的工程类比，不冒充论文直接验证；
- [BEIR](https://arxiv.org/abs/2104.08663)提供heterogeneous、zero-shot retrieval evaluation的研究背景，启发BornAgent采用family-disjoint与多候选corpus；48/48、128-row和split规则是本项目自己的实验决定，不是BEIR直接给出的合同；
- [SQLite FTS5](https://www.sqlite.org/fts5.html)定义BornAgent现有lexical baseline机制；
- [`ml2-search-contract.ts`](../src/memory/retrieval/ml2-search-contract.ts)、[`lexical-memory-search-service.ts`](../src/memory/retrieval/lexical-memory-search-service.ts)和[`fts5-episode-projection.ts`](../src/memory/retrieval/fts5-episode-projection.ts)是本实验的live baseline authority。

本实验只借用“query/passage embedding + local feature extraction”、rank fusion和selective risk–coverage的机制，不照搬论文或model card的benchmark数字。E5 cosine不是校准后的正确概率，RRF score也不是relevance confidence；任何rejector都必须在BornAgent自己的adequate calibration上冻结。实验不采用远程embedding、GPU serving、vector DB、ANN、训练pipeline、模型自动下载或多模型ensemble。公开ONNX repo的`main`链接只是研究入口；真实receipt必须绑定full immutable revision与逐文件SHA-256。

## 15. v1历史完成决策

- `baseline_sufficient`：保留EM0 corpus/receipt，记录FTS已足够；转向verified procedure，不创建embedding candidate。
- `lab_verified`：保留isolated candidate和证据，另写product-promotion amendment；在amendment通过前production仍是FTS + recency。
- `rejected`：删除candidate/model/vector dependency，保留EM0/EM1 receipt和失败原因；下一张card转向verified procedure。
- `inconclusive`：保留最小可复现baseline和阻塞证据，不继续换模型、ANN或扩大corpus。

本card已选择`rejected`：candidate/model/vector dependency与ignored model root已删除，EM0 corpus/baseline、EM1 failed receipt和中文学习记录保留；下一张card转向verified procedure。

任何结果都必须记录实际focused minutes，并拆分research、corpus、mechanism、tests、cost evidence与learning docs。以上是v1历史决定，已由父合同evidence-protocol v2取代；下一次embedding实现必须从EM-R1的新数据充分性gate开始，不得直接下载模型或复用旧evaluation作blind证据。

## 16. EM-R1 — Selective Retrieval Evidence Redesign

### 16.1 研究问题、身份与单一变量

EM-R1使用新identity，并把v1数据降为known regression：

```text
experimentId: fal-em-r1-selective-hybrid-v2
priorEvidenceReceiptSha256: a6a9c5563b421342c7c21f1d1efb0470cdd04aa322ff4b77a2c0ec5ce4b88b6c
priorCandidateImplementationSha256: 6251ca321314fd920fc106585869b45fec8eb92de56829ca12937c30d0de29d7
priorThresholdSimilarityMicros: 780000
```

旧`sourceCommit=null`且candidate源码不在Git中，所以任何新实现都必须标`reimplementation_from_v1_contract`并生成新hash。EM-R1的预期单一变量是证据设计，但这只有在reimplementation fidelity成立时才有效：固定`@huggingface/transformers@3.3.3`、`Xenova/multilingual-e5-small` revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`、历史int8 artifact selection、query/passage formatting、mean pooling、L2 normalization、exact cosine、per-row single global threshold与`k=60` unweighted RRF。新rehydration manifest必须列出逐文件SHA，并尝试复现历史`modelArtifactManifestSha256=eb54f2a0fc3b5a2608f4c43b404e10bf4da856b9b405e48ff27fcecaeef55141`；若不能复现，记录具体差异与`reimplementation_confounded`，不得声称“只换数据”。本card不加入margin、reranker或第二模型。

在开放新evaluation goldens前，冻结reimplementation并以历史`0.78`阈值重跑旧36个development cases；final ordered record IDs、历史receipt实际保存的`queryKind`和abstention必须逐例一致。v1 receipt没有branch provenance，所以新runner可把lexical/vector/hybrid branch作为新增observation，但不得声称与历史route一致。无法复现输入/artifact时记录`implementationFidelity=inconclusive`；在输入和reference anchors已确证一致后仍出现输出差异，才记录`implementationFidelity=failed`。两者都阻止v1根因归因；新实现仍可单独留下mechanical observation，但不能作为“数据修正了旧失败”的证据。

### 16.2 v1 data adequacy audit

v1的36条全部改标`known_regression/development_only`，原因固定为：

- 8个calibration只有2个negative，`negative-calibration-punctuation`不调用embedding，effective vector-abstention calibration只有1例；
- 6个scope/freshness/lifecycle families全部只在evaluation，没有同构但不同内容的calibration analog；
- 每个quality case恰好只有3条records，无法测量多distractor下的maximum-score false accept；
- 多个case复用`local package note/local session note`，不是独立distractor family；
- receipt没有top1/top2 cosine、margin、branch provenance或完整threshold risk-coverage curve，不能事后判断正负score distribution是否可分。

这些缺口不删除v1 observation，但使`evidenceValidity=limited`并禁止algorithm/model root-cause claim。

### 16.3 新corpus合同

Calibration与family-disjoint evaluation各固定48 cases、answerable/unanswerable各24：

| Type | Per split | Role |
|---|---:|---|
| semantic answerable | 16 | 中文、英文、cross-lingual、paraphrase与低词面重叠 |
| exact/phrase/temporal controls | 8 | live lexical/bypass/current-revision control |
| far unrelated | 4 | 明确out-of-corpus query |
| lexical collision | 4 | 共享关键词但不支持query |
| semantic near-miss | 4 | 同主题、错误事实或错误参数 |
| boilerplate/template collision | 4 | repository/source/record/instruction等结构词碰撞 |
| filtered-target abstention | 8 | wrong repository/principal、stale/tampered/unavailable source、retracted/superseded/no-current revision |
| **Total** | **48** | **24 answerable / 24 unanswerable** |

两个split分别绑定独立、exact 128-row的shared corpus pool。每个quality case必须查询所属split的完整shared pool，禁止从pool抽3条另建case-local corpus。每个`must_abstain`在scope/source/lifecycle过滤后仍须有至少32条eligible、fresh、current-scope distractors；至少16/24个unanswerable cases必须满足FTS结果为空且`queryEmbeddingCalls=1`，标点/parser/no-searchable controls不得计入effective vector negatives。

每个case必须记录`scenarioFamilyId`、`queryTemplateId`与`distractorPoolId`。Calibration与evaluation在三者上都group-disjoint；只替换实体名、语言或相似token不算新family。Manifest必须机械证明`crossSplitScenarioFamilyOverlap=0`、`crossSplitQueryTemplateOverlap=0`、`crossSplitDistractorPoolOverlap=0`以及normalized title/text exact overlap为0。每类filtered-target在两个split都有不同主题、措辞、record identity和distractor family的analog，不能把全部critical family藏在evaluation后再声称threshold已校准。

Golden基于**过滤后的允许语料**定义，而不是baseline输出：

```ts
interface EmR1Golden {
  answerability: "answerable" | "must_abstain";
  allowedRelevantRecordKeys: readonly string[];
  forbiddenRecordKeys: readonly string[];
  expectedQueryRoute: "exact_bypass" | "lexical" | "hybrid";
  requiredRank: 1 | 5 | null;
  expectedCurrentRevisionKey: string | null;
  expectedActionParametersSha256: string | null;
}
```

`requiredRank=1`用于exact/phrase/current-revision controls，semantic cases使用`5`，`must_abstain`使用`null`；temporal/action-sensitive control还必须匹配冻结的current revision与action-parameter hash，不能只靠任意相关record进入top 5算pass。

Scope/source/lifecycle filter case与abstention case分别计数：forbidden target进入input/row/hit是G1 security failure；target被正确过滤后返回safe-but-irrelevant record是G3 false accept，不得叫security leak。

### 16.4 Implementation anchors与branch observation

在选择threshold前先冻结官方reference anchors：token IDs和attention mask必须exact；12个query/passage anchors的384维、L2 norm、pairwise rank与cosine在预声明quantization tolerance内一致。Anchor失败记录`implementationFidelity=failed`，不得继续用quality结果讨论模型。

每个quality case至少保存以下non-content diagnostics；raw query、record text和vector仍不得进入receipt：

- post-filter eligible row count；
- lexical/vector/hybrid ordered record keys与branch provenance；
- query/record embedding call counts；
- top1/top2 `similarityMicros`、margin与accepted/rejected；
- Recall@1/5、reciprocal rank、false accept、filtered-target substitute；
- result/text/token budget与canonical refetch/source revalidation结果。

RRF只在admission后排序。若错误record已由vector admission放入候选，归因selector/admission；只有正确candidate set进入RRF后排序错误，才归因fusion。

### 16.5 Calibration：从最大MRR改为risk–coverage

因为v1 selector对每条vector row执行`similarityMicros >= threshold`，Calibration必须枚举所有会改变candidate set的行为断点，而不是只枚举query top1。令`S`为全部calibration query在过滤后所有eligible vector rows的唯一`similarityMicros`；canonical sweep包含vector-accept-all边界、每个`s ∈ S`的exact integer inclusion状态及`s + 1` exclusion状态（不超过上界）、vector-reject-all边界，并对每个点重跑完整top-k与RRF。禁止用midpoint或粗粒度`0.70–0.90` grid漏掉低排名row跨阈值时的top5/fusion变化。对每个operating point报告：

- embedding-active answerable Recall@5与MRR@5（exact/phrase bypass controls单独报告）；
- coverage（返回非空结果的query比例，并分semantic/control/unanswerable route）；
- absolute `acceptedWrong = result_nonempty && ((must_abstain) || (answerable && no allowed relevant record within requiredRank))`；拒绝一个answerable会降低coverage/Recall，但不能进入accepted-only risk分子，否则risk可错误地大于1；
- absolute `selectiveRisk = acceptedWrong / result_nonempty`（若coverage为0则报告0并标`vector_reject_all`，但不得因此成为eligible）；
- absolute unanswerable nonempty rate、FTS-empty vector-negative false-accept rate、candidate-added negative hit count分别报告；
- filtered-target substitute rate；
- lexical/temporal/security invariant regressions。

2026-08-29 corpus revision 1的live preflight发现，英文停用词在当前OR-token FTS中使23/24 negatives预先非空；该无效预跑receipt保留但不得用于结论。Corpus revision 2先机械要求24/24 negatives为embedding-active，且至少16/24在live scope/source/lifecycle过滤后FTS为空。另有8个lexical/boilerplate collision被有意保留为baseline-nonempty regression controls：v1 adapter只做recall augmentation，vector threshold不控制FTS admission，因此把这8例同时要求absolute empty会使实验按定义必败、且无法归因embedding。

修正后的有限corpus risk policy是：eligible operating point必须同时满足G1/G2 regression `0`、FTS-empty vector-negative false accept `0`、全部24个unanswerable的candidate-added negative hit case `0`、8个baseline-nonempty collision的ordered top-5 parity failure `0`、filtered-target substitute `0/8`、16个semantic answerable中至少`13/16`在top 5命中，以及8个exact/phrase/temporal controls按各自`requiredRank`与current/action expectation达到`8/8`。Absolute selective risk与absolute unanswerable nonempty仍完整报告，但不把byte-equivalent baseline collision冒充candidate regression。在eligible points中先最大化answerable coverage，再最大化semantic MRR@5，最后选择更高threshold。这个delta-risk、13/16与8/8规则只是BornAgent当前有限corpus risk preference，不是论文保证或population error bound。

如果不存在非`vector-reject-all` eligible point，记录claim`E5 + single-per-row-score threshold = refuted_on_calibration`、`promotion=blocked`并停止R1；lexical branch可能仍返回结果，所以不得把该边界简称为全系统reject-all。不能把结果单独归因E5模型。Threshold、candidate source、model/runtime/rehydration manifest、calibration result与case-family hashes全部冻结后，才允许加载evaluation goldens。

### 16.6 Evaluation与因果判定

> Historical contract note：下述规则是EM-R1设计意图，但当前旧evaluation未满足strict runtime seal与semantic family-disjoint，已由0.3节降级；不得再执行为blind evaluation。

Family-disjoint evaluation只运行一次冻结candidate。它报告与calibration相同的完整absolute与delta metrics，并把旧36例作为pre-evaluation fidelity/known-regression evidence但不并入blind aggregate。Evaluation通过的exact合同与calibration eligibility相同：G1/G2 regression `0`、FTS-empty vector-negative false accept `0`、candidate-added negative hit case `0/24`、baseline collision ordered parity failure `0/8`、filtered-target substitute `0/8`、semantic top-5命中至少`13/16`、controls `8/8`；evaluation不重新选择threshold。

允许的因果结论严格限定为：

| Observation | Allowed conclusion |
|---|---|
| reference anchors不一致 | implementation fault |
| forbidden record进入embedding input/vector row/hit | architecture/security fault |
| fidelity replay一致，且adequate R1 calibration与evaluation均通过 | 支持“v1 data/calibration coverage不足”假设；不能证明它是历史v1唯一或主要根因，当前组合只在v2 corpus supported |
| adequate calibration不存在eligible threshold | E5 + single global per-row score selector组合在该corpus被refute；不能单独归因model |
| calibration通过、group-disjoint evaluation失败 | generalization failure；data/algorithm/model root cause仍inconclusive |
| 后续同E5 vectors上预注册score+margin selector通过 | 支持single-threshold algorithm不足；须使用新holdout |
| 后续同selector/同corpus protocol下另一固定model通过而E5失败 | 才支持model原因；须使用新holdout |

因此后续card顺序固定为：EM-R1把机制冻结为v1 contract、以fidelity replay确认可比性后只换充分数据；若不足，EM-R2保留E5只换selection function；若仍不足，EM-R3保留selector只换模型。每一步都使用新的family-disjoint evaluation，不能用已看过的失败case调参后再称blind。

### 16.7 G1安全、G4成本与promotion

G1保持v1的scope-before-embedding、active/current/source-available rows、use-time canonical refetch、remote/tool calls为0和byte-equivalent fallback。`securityInvariantFailures`、`abstentionFalsePositives`、`qualityGateFailures`必须分栏，不再汇总成无法解释的`hardGateFailures`。

G4继续测model/dependency bytes、cold/warm load、query embedding、两个exact 128-row quality pools、10k exact scan、hybrid p95、SQLite bytes与pack delta；receipt按实际pool size分栏，不能把case-local三行语料冒充128-row测试。成本超限只写cost claim refuted并阻止promotion，不覆盖ranking、abstention或safety结论。

即使EM-R1全部通过，也只达到`mechanism_verified`与指定claim supported，closure固定写`productFit=not_assessed`、`promotion=not_assessed`；由于corpus仍是lab evidence，进入Memory product path必须另写promotion amendment并增加trace-backed query/shadow evidence、Windows/Linux exact-commit、pack/restart/rollback与明确CLI观察点。

### 16.8 Files、receipt与retention

新边界为：

```text
fixtures/frontier-adapter-lab/fal-em-r1-selective-hybrid-v2/
  manifest.json
  prior-evidence-assessment.json
  reference-anchors.json
  calibration-pool.json
  calibration-cases.json
  evaluation-pool.json
  evaluation-cases.json
  experiment-receipt.json
  threshold-behavior/
    part-001.json ... part-010.json

labs/frontier-adapter-lab/fal-em-r1/
  src/
  tests/
  runner/
  model-rehydration-manifest.json
```

Receipt使用父合同正交轴，额外保存data-adequacy counts、family/pool/normalized-overlap hashes、全部per-row threshold behavior points、selected operating point、branch metrics、separate failure counts、36-case fidelity replay和prior receipt ref。不得修改v1 manifest/cases/receipt；且在EM v1 evidence首次原样进入Git前不得开始新evaluation。

Candidate源码、candidate-only tests、model rehydration manifest、license/revision/file hashes默认保留在lab目录并disabled；不得放入当前会编译到`dist`的`src/**`，production import/pack graph必须为0。模型权重、vector DB、cache、隔离`labs/frontier-adapter-lab/fal-em-r1/` dependency root中的`node_modules`和临时report默认删除，绝不把该规则解释为删除仓库根依赖。Calibration/evaluation失败、收益不足或promotion blocked都不得删除唯一源码；只有secret/license/hazard、无法限制的依赖或用户明确要求才允许删除，并记录reason与恢复边界。

合法closure示例：

```text
evidenceValidity=valid|limited|invalid
implementationFidelity=verified|failed|inconclusive
claim(semantic_retrieval)=supported|refuted|inconclusive
claim(selective_abstention)=supported|refuted|inconclusive
productFit=not_assessed
promotion=not_assessed|blocked
candidateLifecycle=retained_disabled|quarantined|archived_recoverable|removed_legacy_policy|removed_for_hazard
```
