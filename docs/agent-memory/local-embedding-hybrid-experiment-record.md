# FAL-EM0 Local Embedding Hybrid 实验记录

> 历史状态：v1 receipt保持`outcome: rejected`；2026-08-28 evidence correction将其解释为semantic ranking supported、safety isolation supported、v1 abstention selector failed on known fixtures、root cause inconclusive、promotion blocked
> Experiment contract：[`FAL-EM0 — Local Embedding + FTS Rank Fusion`](../../spec/frontier-adapter-lab-fal-em0-local-embedding-hybrid.md)
> Machine receipt：[`experiment-receipt.json`](../../fixtures/frontier-adapter-lab/fal-em0-local-embedding-v1/experiment-receipt.json)
> Product status：unchanged；Memory v1仍使用FTS + recency，production默认仍为`off`

## 0. Evidence correction（不修改历史回执）

v1 manifest、cases、receipt、SHA与3个false-accept observation在working tree中保持原字节；该目录当前尚未进入Git，因此还不能称为durably immutable，EM-R1开始前必须先原样提交。复查发现8个calibration中只有2个negative，其中`!!! ???`不调用embedding，真正参与向量拒答校准的负例基本只有`quasar nebula`一条；6个scope/freshness/lifecycle families全部只在evaluation。每个quality case又只有3条records，多个case复用同一`local package note/local session note` distractor template，receipt没有top1/top2 score、margin、branch provenance或完整risk-coverage curve。

因此v1可以证明固定candidate把semantic Recall@5从0提高到1.00、actual forbidden target leak为0且成本在预算内，也可以证明`0.78` selector在3个known cases发生safe-distractor false accept；它不能证明根因是data、single-threshold algorithm、RRF或E5模型。Candidate源码已删除且未进入Git，hash不能恢复实现。新合同见[`EM-R1 evidence redesign Spec`](../../spec/frontier-adapter-lab-fal-em0-local-embedding-hybrid.md)。

## 1. 这一步实际实现了什么

EM0先把“现有FTS到底缺什么”变成可复现证据：

1. 冻结36个hash-bound cases，其中8个calibration、28个当时未用于调参的evaluation；这些case现在均已公开，只能作known regression；
2. 每个case建立独立temporary Memory v1 scope；
3. 使用真实`SqliteEpisodeStore`写canonical record和lifecycle operation；
4. 使用真实`Fts5EpisodeProjection`建立scope-bound derived projection；
5. 使用真实`LexicalMemorySearchService`执行exact ID、quoted phrase和lexical query；
6. 返回前仍经过canonical active revision与source availability检查；
7. 只把fixture keys、metrics和hash写入receipt，不保存raw query、record text或absolute path。

Runner不是一份自制字符串匹配器。其baseline implementation identity绑定Memory v1当前record、store、ML2 query contract、FTS projection和lexical service源码。

EM0允许后，EM1曾在隔离lab中完整实现并运行一次候选：

1. 直接用`@huggingface/transformers@3.3.3`加载本地ONNX，不经过Ollama；
2. 固定`Xenova/multilingual-e5-small` revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`，只取int8 model、tokenizer和config；
3. 只有显式`prepare-model`可以联网，compare/search/test/pack均设置local-only并用network tripwire；
4. active、exact-scope、source-available records才可进入384维embedding；
5. 独立SQLite BLOB projection执行10,000行上限内的exact cosine scan；
6. vector top 100与live FTS top 100使用固定`k=60`的unweighted RRF；
7. exact ID、quoted phrase和no-searchable query保持0次embedding；candidate fault byte-equivalent回退live baseline；
8. 只用8个calibration cases从固定grid选一个阈值，冻结后才运行28个evaluation cases。

候选在v1单一outcome合同下被写为`rejected`，因此以上candidate/provider/vector实现、模型和lab dependencies按当时contract删除；本页和当前working-tree receipt保留历史观察，但不再把cleanup解释为技术方向判决或完整可复现。

## 2. Frozen corpus

| Category | Cases | Split / role |
|---|---:|---|
| exact / phrase / lexical controls | 6 | 2 calibration + 4 evaluation |
| Chinese paraphrase / synonym | 8 | 2 calibration + 6 evaluation |
| English paraphrase | 4 | 1 calibration + 3 evaluation |
| cross-lingual zh ↔ en | 4 | 1 calibration + 3 evaluation |
| temporal / update / conflict | 4 | evaluation；全部action-sensitive |
| negative / abstention / collision | 4 | 2 calibration + 2 evaluation |
| security / scope / freshness / poison | 6 | 全部在当时evaluation；现在为known regression |
| **Total** | **36** | **8 calibration + 28 evaluation** |

12个evaluation semantic cases在candidate代码出现前冻结并全部标记entry-gate eligible。Goldens区分：

- `must_find_relevant`：exact、phrase、lexical、temporal与active lifecycle硬门；
- `must_abstain`：wrong scope、stale/tampered source、retracted record等安全硬门；
- `observe_quality`：允许FTS暴露paraphrase miss或negative false positive，但不能把预期质量缺口误报为runner failure。

## 3. EM0结果

首次Windows local baseline receipt：

| Metric | Result |
|---|---:|
| cases executed | 36 / 36 |
| hard-gate failures | 0 |
| security leaks | 0 |
| blind semantic cases | 12 |
| semantic Recall@5 | 0.00 |
| semantic MRR@5 | 0.00 |
| local embedding calls | 0 |
| remote model calls | 0 |
| tool calls | 0 |
| search-time network calls | 0 |
| outcome | `inconclusive` |
| candidate permitted | `true` |

Entry gate的三个原因同时成立：

- `semantic_recall_below_75_percent`；
- `at_least_five_semantic_top5_misses`；
- `misses_have_no_literal_term_overlap`。

这不是“故意让FTS考零分”：exact ID、quoted phrase、共享关键词、recency、supersede/current revision、wrong repository/principal、stale source和retract均走同一live product路径并通过。语义子集专门测试词面不重叠的中文改写、英文paraphrase和cross-lingual query；它回答的正是EM1是否值得存在。

## 4. 实现中发现的真实细节

中文连续文本会被Host query parser作为一个term；FTS5文档侧若整句继续连接其他中文字符，完整query不一定形成独立token。最初三个collision fixture缺少标点边界，因此虽然肉眼包含query，实际没有进入FTS候选。EM0在任何candidate/model存在前给这些fixture补上明确中文标点边界，重新计算case-pack与manifest hash，再冻结receipt。

这次修正说明benchmark必须验证真实tokenizer行为，不能只凭“字符串看起来包含关键词”判断lexical baseline。

EM1还得到三条工程结论：

- 384维Float32 row放在SQLite默认4 KiB page时会发生payload overflow，10k库达到46,825,472 bytes；固定16 KiB page后降到23,461,888 bytes；
- 每次查询重做全库row hash/decode会把10k scan p95推到333.60 ms；完整验证后按file identity + canonical/model hash复用只读rows，最终p95为37.79 ms；
- E5语义Recall很好，固定0.78阈值仍会为3个`must_abstain` query返回当前scope内安全但无关的记录。越域、stale、retracted目标没有泄漏，失败属于abstention/precision；由于calibration coverage不足，不能进一步归因共同结构、threshold algorithm或model。

## 5. EM1 blind result

阈值只由calibration split选择并在evaluation前冻结为`780000 similarityMicros`。没有用evaluation重调threshold、prefix、model或RRF。

| Metric | Result / gate |
|---|---:|
| evaluation semantic Recall@5 | 1.00 / >=0.80 |
| evaluation semantic MRR@5 | 0.7083 / baseline +0.15 |
| v1 aggregated hard-gate failures | 3（均为abstention false accept；actual security leak为0） |
| actual wrong-scope/stale/retracted leaks | 0 |
| vector-added forbidden hits | 0 |
| fallback mismatches | 0 |
| model artifacts | 135,138,424 bytes / <=160 MiB |
| conservative lab dependency closure | 356,256,406 bytes / <=350 MiB |
| packed artifact delta | 18,305 bytes / <=256 KiB |
| model bytes in pack | 0 |
| cold load p95, 5 fresh processes | 2,011.92 ms / <=8,000 ms |
| warm query embedding p95 | 4.61 ms / <=300 ms |
| 10k exact vector scan p95 | 37.79 ms / <=75 ms |
| warm hybrid search p95 | 30.34 ms / <=450 ms |
| 10k vector SQLite | 23,461,888 bytes / <=32 MiB |
| final outcome | `rejected` |

三个failure分别是`security-wrong-repository`、`security-stale-source`和`security-retracted-record`：目标危险记录均在embedding input、vector row和hit中为0，但候选返回了其他当前scope/available distractors，违反`must_abstain`。按v2术语这是3个G3 abstention false accepts，不是G1 security leak；它们足以阻止当前candidate promotion，但不足以定位data/algorithm/model根因。

## 6. Evidence

已运行：

```text
pnpm lab:local-embedding -- --mode baseline \
  --report .bornagent/reports/fal-em0-local-embedding-baseline.json

node node_modules/vitest/vitest.mjs run \
  tests/unit/fal-em0-manifest.test.ts \
  tests/integration/fal-em0-baseline-runner.test.ts \
  --maxWorkers=1

pnpm typecheck
```

最终保留证据：

- EM0 receipt仍可由当前live FTS baseline重复生成；当前working-tree receipt保存EM1最终失败证据，但须先原样进入Git才是durable evidence；
- post-cleanup focused suite：2 files / 4 tests passed；
- post-cleanup `pnpm typecheck`与`pnpm lint`：passed；
- post-cleanup `pnpm pack:smoke`：passed，含ML1–ML5 installed-memory probes，release demo 11/11，remote billable requests为0；
- post-cleanup live baseline：hard failures 0、security leaks 0，logical receipt恢复为`d9f4858f10eb07a6b39b0e92acb4f13e3f0e0699815c3daa79b8736736a91505`；
- tracked logical receipt SHA-256：`a6a9c5563b421342c7c21f1d1efb0470cdd04aa322ff4b77a2c0ec5ce4b88b6c`；
- EM1 actual focused minutes：60；
- reference machine：Windows 10 `10.0.19045`、Intel i7-10875H、32 GiB、Node `v22.23.1`；
- packed boundary：`passed`；模型bytes为0；
- Windows candidate gate：`failed`，原因是3个abstention hard failures；
- Linux：`not_run`；
- local `sourceCommit`：`null`，不得冒充exact-commit CI。

## 7. 当前接受边界与下一步

EM1结果不批准任何product行为，cleanup后当前边界是：

- 当前没有Transformers.js/undici lab dependency；
- 已删除135,139,269 bytes的ignored model lab root；
- 当前没有candidate vector SQLite、cosine scan、RRF或provider源码；
- 当前没有修改`memory search`、ML3 automatic recall或`born` CLI；
- production仍是FTS + recency，默认仍为`off`；
- 高Recall、低latency不覆盖abstention false accept；同样，false accept也不覆盖已通过的safety isolation、ranking与cost observations。

下一步不在同一card里换模型、加margin rule、ANN或用旧evaluation重调阈值。若重开embedding，先把v1 evidence以当前SHA进入Git，再执行EM-R1：旧36例只作fidelity replay/known regression，新建48/48 family-disjoint calibration/evaluation与两个exact 128-row shared pools，按所有eligible row score断点报告完整risk-coverage，并以`0/24` false accept、semantic至少`13/16`、controls `8/8`判断single-threshold是否存在eligible operating point。未来candidate源码/tests默认保留disabled，只清理weights/vector/cache；lab通过仍写`productFit=not_assessed`，promotion需独立amendment。

## 8. EM-R1 retained reimplementation（2026-08-29）

EM-R1按用户明确要求在旧v1 evidence仍未提交的情况下直接重试；旧manifest/cases/receipt保持原字节，本轮receipt明确写`working_tree_full`、`sourceCommit=null`和durability contract deviation，不冒充exact-commit。新candidate不再删除，完整保留在`labs/frontier-adapter-lab/fal-em-r1/`，production仍未导入它。

实际恢复的机制包括Transformers.js 3.3.3、full revision绑定的`Xenova/multilingual-e5-small` q8 ONNX、query/passage prefix、mean pooling、L2-normalized 384维Float32、scope/source/lifecycle-before-embedding、16 KiB-page SQLite derived projection、exact cosine、single global per-row threshold、live FTS/vector各top 100、`k=60` unweighted RRF、canonical refetch和原有结果预算。模型、isolated dependency与运行DB留在ignored lab cache；源码、tests、lock、rehydration manifest、anchors、fixture和receipt留在workspace。

### 8.1 Fidelity边界

- 当前artifact为4个文件、135,392,016 bytes，manifest SHA为`a1e26133b5fd17b1a38b8ae084b83c9ca0af7c9233a574e218de3ae1fe436ffb`；它与历史`eb54f2...`及135,138,424 bytes不一致，因此`reimplementationConfounded=true`；
- 12个self-frozen query/passage anchors的token、attention mask、384维vector、norm和cosine重新验证均exact/within tolerance；这只能证明当前实现自洽，不是独立历史reference；
- 用历史0.78阈值重跑旧36例时，query kind全部一致，但完整ordered IDs/abstention只有26/36一致，所以总体`implementationFidelity=inconclusive`。

### 8.2 两次数据合同修正

Corpus revision 1的无效预跑receipt SHA为`bb4038b311b72391614df52a715a0e68fe9e21f1261115207b31a2636002b169`。它暴露当前OR-token FTS会被英文`what/how/the`等通用词命中，导致约23/24 negatives在embedding前就非空；该run保留在ignored evidence cache但不能用于算法结论。

Revision 2把far/near-miss/filtered-target query改成无词面重叠但语义可解释的cross-lingual表达，并新增live hard preflight：24/24 negatives必须是embedding-active，至少16/24 FTS-empty。最终exact通过16/24；剩余8个lexical/boilerplate collision有意保持baseline nonempty。Risk policy同时修正两个协议错误：accepted-only risk不再把rejected answerable计入分子；对8个baseline collisions要求ordered parity和vector-added negative hit为0，而不是要求一个不受vector threshold控制的FTS branch凭空变空。Absolute nonempty risk仍记录，不混成candidate delta。

### 8.3 Calibration结果

完整枚举9,538个per-row inclusion/exclusion behavior points并分10个hash-bound shards保存。没有eligible operating point：

| Observation | Result |
|---|---:|
| live FTS-empty vector negatives | 16 / 24 required minimum 16 |
| delta-safe diagnostic threshold | 0.909331 |
| security invariant failures at safe point | 0 |
| candidate-added negative hit cases at safe point | 0 |
| baseline collision parity failures at safe point | 0 |
| filtered-target substitutes at safe point | 0 |
| controls at safe point | 8 / 8 |
| semantic top-5 at safe point | 0 / 16 |
| maximum semantic top-5 over the whole curve | 8 / 16（gate 13 / 16） |
| historical 0.78 semantic top-5 on new corpus | 7 / 16 |
| selected operating point | none |
| evaluation | cases未解析/评分；文件曾被manifest verifier读取 |

因此当前允许结论是：这份reimplementation下，E5 exact scores、single per-row threshold与固定RRF组合在128-row calibration上无法同时满足预注册semantic与delta-safety门；不能说“只要修正旧测试数据，原方案就通过”，也不能单独判定是E5模型、threshold、fusion或artifact差异。下一步不能继续使用当前EM-R1 evaluation作blind证据或调参，必须使用新的独立holdout。

### 8.4 成本与边界

最终working-tree receipt logical SHA为`4e20762f11447a136423699bda44ac09268374f62f8907fa603a59ecc084220f`。本机观察：isolated dependency 358,306,576 bytes；cold load约0.75s；warm query embedding p95约5.75ms；10k exact scan p95约11.97ms；10k vector SQLite 18,595,840 bytes；hybrid preparation p95约435.44ms。成本没有覆盖quality失败，quality失败也没有覆盖已通过的scope/source/lifecycle isolation。Candidate仍为`retained_disabled`，`productFit=not_assessed`、`promotion=blocked`，production保持FTS + recency。

### 8.5 EM-R1 evidence audit correction（2026-08-29）

旧receipt原字节与logical SHA保持不变，追加机器可验的[`evidence-correction-v2.json`](../../fixtures/frontier-adapter-lab/fal-em-r1-selective-hybrid-v2/evidence-correction-v2.json)。复查确认：`loadEmR1Split("calibration")`为验证全manifest而读取evaluation文件，只是没有解析或评分evaluation cases；calibration/evaluation的family/template/pool ID又通过split前缀构造，实际主题存在语义孪生。因此`evaluationGoldensLoadedByRunner=false`只能支持“未解析/评分”，不能支持runtime blind或sealed；normalized exact overlap为0也不能支持semantic family-disjoint。

保留结论只有三条：calibration不存在eligible global threshold、evaluation scoring没有发生、promotion blocked。旧evaluation永久降级为`known_exposed_holdout_development_only`。新的[`FAL Memory Shared Benchmark v1`](../../spec/frontier-adapter-lab-shared-memory-benchmark-v1.md)使用24条共享时间线、2×2分阶段评测、独立family registry与one-shot salted commitment。

### 8.6 Shared benchmark结果（2026-08-29）

EM-R1 candidate在新的共享development/calibration上实际运行，旧evaluation没有复用。Calibration选中全局threshold `0.870576`：macro support Recall@5从FTS的`0.277778`升到`0.388889`，all-support-found@10从`0.527778`升到`0.583333`；candidate-added must-abstain/forbidden top-5 cases均为0，projection security failure为0。Development选中`0.868743`并观察到相同`+0.111111` Recall@5 delta，因此允许写`retrieval_calibration_passed`。

该检索结论没有转化为fixed-packet reader通过。冻结的本地`qwen3.5:2b` reader在development与calibration的四个arm中must-answer grounded success都为0，calibration还出现8个invalid arms与2个reader security regressions；absolute must-abstain top-5 nonempty仍为24/24。Reader gate失败，sealed evaluation未运行。结果回执见[`development-calibration-receipt.json`](../../fixtures/frontier-adapter-lab/fal-memory-shared-v1/development-calibration-receipt.json)。所以当前candidate仍为`retained_disabled`：检索层方向值得保留，但product fit与Agent任务效果均未评估。

### 8.7 Agent-effect scope correction（2026-09-01）

EM0、EM-R1与shared retrieval都直接materialize冻结record pool，未运行历史交互的product writer/admission、fresh-process automatic recall、BornAgent AgentLoop、工具或task verifier。后续DeepSeek虽有真实API调用，也只是读取手工构造的fixed evidence packet。因此历史receipt中的`localEmbeddingEndToEndBenefitObserved=true`撤回并改名为`retrieval_to_fixed_packet_reader_effect_observed`；`+0.050000/+0.066666`保留为public synthetic fixed-reader组件诊断。Local Embedding对BornAgent Agent任务成功率的影响仍为`not_tested`，product fit为`not_assessed_by_shared_benchmark`。机器纠偏见[`agent-memory-effect-scope-correction-v1.json`](../../fixtures/frontier-adapter-lab/fal-memory-shared-v2/agent-memory-effect-scope-correction-v1.json)。
