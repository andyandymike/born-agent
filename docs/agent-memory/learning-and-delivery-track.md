# BornAgent Agent Memory 学习与交付路线

> 状态：Active / Learning goals and slice sequencing authority（updated 2026-08-26）
> 当前基线：AM0/AM1 exact-commit CI已通过；ML1已提交为`43d80b2`且`origin/main`一致，但该提交没有CI run，production Agent默认仍为`off`
> 当前切片：ML3 local-backend bounded historical recall本地product/full/installed-pack gate已通过；等待提交后的Linux/Windows exact-commit CI；exact合同见[`Lightweight Memory Core and Frontier Adapters Spec`](../../spec/agent-memory-lightweight-core-and-adapters.md)

## 1. 为什么做这条路线

BornAgent 是个人开源、学习型编码 Agent，不是企业 memory platform。Agent Memory 路线按以下优先级推进：

1. 亲手实现、复现并比较有代表性的前沿 Agent 技术；
2. 让 BornAgent 每个切片都获得真实可运行、可观察的能力；
3. 为个人积累可复用的 AI Agent 概念、源码调用链、工程取舍、失败经验与实际耗时；
4. 只有真实使用证明需要时，才增加企业级兼容、治理或分布式复杂度。

此前的 exhaustive Agent Memory draft 保留为研究与威胁模型资料，不再作为必须一次实现完的 backlog，也不能作为“产品已完成”的状态权威。本文件与 tracked `ROADMAP.md` 决定当前切片和学习范围；active Memory Lite spec只能收窄该范围并定义exact行为，不能扩张切片。live code、tests 和 exact-commit evidence 决定事实状态。

## 2. 当前真实基线

- AM0 已交付 deterministic corpus、benchmark 和 evidence receipt；它不改变 production behavior。
- AM1 已交付 exact-prefix incremental projector、bounded working snapshot/sidecar 和 cold-equivalence evidence。
- production `AgentContextRuntime` 尚未启用 AM1；默认仍为 `off`。
- 当前session仍保存完整对话；显式`--memory local`可在成功终态后另存一条跨进程episode，并由`memory status/list/show`检查。
- `memory search <query> --explain`现可手动执行scope-bound exact/quoted/FTS5 lexical/recency retrieval；stale source不会成为hit，derived projection可删除重建。
- 显式`--memory local`现在会在每个local Ollama/in-process request前重新检索并source-revalidate，最多加入3条`historical_only` excerpt；remote provider与mode off注入均为0。
- 尚无普通chat提炼、用户`remember/retract` lifecycle、remote disclosure或frontier adapter。
- `6ce181a75249c76f39e8d23bfeb7a7d31b31b29d` 的 Windows/Linux repository gate、AM1、built paths、pack smoke 与 Pages 已通过。

这意味着 AM0/AM1 是已验证的工程组件，不是用户可用长期记忆的完成声明。

## 3. 学习型交付规则

### 3.1 一个切片同时交付四类结果

每个切片缺一不可：

1. **Product proof**：一个人可以在真实 CLI 路径观察到的新行为；
2. **Engineering proof**：自动化测试、失败路径、exact command 和可复查产物；
3. **Learning proof**：概念解释、真实源码调用链、关键 invariant、踩坑与仍未解决的问题；
4. **Time proof**：估算、实际 wall-clock 区间，以及 research / feature / tests / CI-debug / learning-docs 分类耗时。

只有 benchmark、schema、内部 class 或测试通过而没有 product proof 时，状态只能是 `component_verified`，不能写 `slice_usable` 或 `memory_complete`。

### 3.2 先最小闭环，再抽象

- 每个切片只引入一个主要学习难点；没有第二个真实消费者前，不建立通用 framework。
- local single-user、same-repository 是首个长期记忆边界。
- 默认 `off`；启用必须显式、可观察、可撤回。
- 记忆内容始终作为 historical/untrusted evidence，不能升级为当前用户指令、approval 或执行 authority。
- 最小安全集合必须保留：scope 隔离、source provenance、secret exclusion、bounded growth、retract、derived rebuild 和 mode-off fallback。
- old-binary mixed-version protocol、team sync、remote private disclosure、物理 secure erase 等只有真实需求出现后再独立研究。

### 3.3 前沿技术以实验进入，不以名词进入

每个候选先写一张 experiment card，再决定是否进入 production：

```text
Research question
Primary paper / reference implementation
Current BornAgent baseline
One isolated intervention
Correctness / quality / latency / token metrics
Failure and poisoning cases
Result: retain | revise | reject | inconclusive
What I learned
Actual engineering time
```

候选方向包括但不限于：tiered context/episodic folding、context evolution/consolidation、hybrid retrieval、graph-assisted multi-hop memory、verified procedural memory 和 self-improving agent loops。每次实验前重新核验 primary source；没有超过简单 baseline 的方案保留为学习结果，不进入主路径。

### 3.4 时间预算与停机线

- 每个切片开始前给出区间估算，不给单点承诺。
- 连续工作超过估算上限，或超过一半时间被非目标 CI/基础设施问题占用时，必须在安全点停止并报告，不能静默扩张范围。
- 与切片无关的基础设施故障单独建账；除非阻塞 product proof，不得吞掉整个切片时间。
- commit 时间只能证明时间窗口，不能冒充连续有效工程时间；学习记录必须注明这一边界。
- 每个切片结束时同时报告“实现了什么”和“用户仍然不能做什么”。

## 4. Memory v1 纵向切片

以下估算是初始工程预算，完成一个切片后按真实数据校准下一项。

| Slice | 产品结果 | 主要学习目标 | 初始预算 | 完成状态 |
|---|---|---|---:|---|
| ML0 | AM0/AM1 baseline 与 working-state component | event sourcing、cold replay、suffix projection、cache invalidation | 已发生 | `component_verified` |
| ML1 | Session A 产生一条 source-bound episode；进程重启后 `born memory list/show` 可读 | episodic memory、durable record、provenance、schema evolution | 8–16h | `local_product_verified`; exact-commit CI pending |
| ML2 | Session B 可按同仓 current query 做 bounded exact/lexical/temporal recall | retrieval baseline、scope filter、ranking、abstention | 8–16h initial human budget; ~0.7h observed Agent wall-clock | `local_product_verified`; exact-commit CI pending |
| ML3 | Agent 获得最多3条有界Host-rendered historical excerpts | prompt injection boundary、authority attenuation、context budgeting | 8–16h initial human budget; 1–3h calibrated; ~1.3h observed Agent wall-clock | `local_product_verified`; exact-commit CI pending |
| ML4 | `remember/retract/rebuild/doctor`、hard bounds、source missing 与 mode-off fallback | lifecycle、derived index、privacy、failure recovery | 8–16h | `not_started` |
| ML5 | Windows/Linux exact-commit、pack smoke、真实新进程演示与文档 | release evidence、operability、open-source handoff | 4–8h | `not_started` |

Memory v1 的总预算目标为约 36–72 小时，而不是把 exhaustive research draft 的所有扩展一次实现，也不是一次连续工作承诺。预算不是完成证据；只有下述真实行为成立才能发布。

## 5. Memory v1 唯一发布演示

```text
mode=off baseline
  -> user explicitly enables local memory
  -> Session A completes a task and publishes one source-bound episode
  -> process exits completely
  -> Session B starts in the same repository
  -> current query recalls the relevant episode
  -> UI/CLI shows record, source session and why it matched
  -> user retracts the record
  -> the same query no longer recalls it
  -> another repository never sees it
  -> rebuild produces the same active records and retrieval order
  -> mode=off restores the no-memory path
```

缺少“完全退出后的 Session B recall”时，不得称为长期记忆。缺少来源、scope 或 retract 时，不得称为可用 v1。

## 6. 每个切片的学习记录模板

每个切片在公开、tracked `docs/agent-memory/` 留下一份短文，至少包含：

```markdown
# MLx — title

## 我想理解的问题
## 读过的 primary sources
## 现有源码调用链
## 最小设计与为什么
## 实验 baseline / intervention / metrics
## 实际 CLI 演示
## 失败、修复与未解决问题
## 我现在如何解释这个概念
## 工程时间账

| Category | Estimated | Actual window | Notes |
|---|---:|---:|---|
| research | | | |
| feature implementation | | | |
| tests/evidence | | | |
| CI/debug | | | |
| learning/docs | | | |
```

学习记录必须链接真实源码路径；关键边界使用可搜索的 `// MEMORY-MLx:` why/invariant 注释，不逐行翻译语法。

## 7. Frontier experiment lane

Memory v1 建立可测 baseline 后，先锋方向按“一项技术、一张 experiment card、一个隔离提交”推进：

1. progressive full/detailed/brief/placeholder context；
2. deterministic consolidation 对比 model-assisted consolidation；
3. lexical/temporal baseline 对比 embedding、graph 或 hybrid retrieval；
4. verified trajectory 到 procedure candidate；
5. memory-guided planning、reflection 或 self-improvement loop。

实验完成并不自动意味着产品启用。实验即使失败，只要具有可复现 baseline、原因分析和学习记录，也属于本项目的有效成果。

## 8. 明确延期

Memory v1 不承诺：

- team/multi-user memory、cloud sync 或 daemon；
- remote private-memory automatic disclosure；
- model 自动写入用户偏好；
- physical source deletion、backup/export 或 secure erase；
- old/new binary mixed writer compatibility；
- procedure 自动安装/启用 Skill 或 Plugin；
- embedding、graph 或 LLM reflection 默认进入 production。

这些能力只有同时满足“真实需求、明确学习问题、可重复实验、可承担维护成本”时才进入新的切片。

## 9. 下一步

ML1 按[`Lightweight Memory Core and Frontier Adapters Spec`](../../spec/agent-memory-lightweight-core-and-adapters.md)先交付一条最窄但真实的跨 session vertical slice：

1. 冻结本地、单用户、同仓库 scope；
2. 从一个 completed session 构建 deterministic EpisodeV1；
3. 保存 exact session/event provenance；
4. 进程重启后通过 `born memory list/show` 读取；
5. 加入 corruption、wrong-repository、mode-off 和 restart tests；
6. 输出 ML1 学习记录与真实时间账。

ML1 不实现自动 recall；它证明长期记忆最基础的“跨进程保存且可解释读取”。ML2、ML3 再分别学习 retrieval 与 safe context use，避免把三个难点重新塞进一个不可观察的大包。
