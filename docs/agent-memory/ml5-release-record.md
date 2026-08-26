# ML5 — Cross-platform product closure

> Status: local release candidate; exact-commit Linux/Windows evidence pending
> Started: 2026-08-26 about 14:13 JST
> Scope: release evidence and open-source handoff only

## 我想理解的问题

一个“测试里能查到旧记录”的组件，什么时候才足以称为可试用的长期记忆？ML5不再增加memory算法，而是验证同一个安装包能否经过完整进程退出、跨仓库隔离、用户撤回、derived重建和mode-off回退，并让Linux/Windows在同一commit上留下可复查receipt。

## 现有源码调用链

唯一演示沿真实产品边界运行：

```text
scripts/pack-smoke.mjs
  -> pnpm pack + extract tarball
  -> scripts/fixtures/memory-v1-release-agent-process.mjs
  -> packed dist/cli/run-cli.js
  -> packed Application Host repository/session actions
  -> packed AgentExecutionService terminal write
  -> MemoryService episode ingest / retrieval / recall
  -> process exits and disposes Host
  -> next Node process opens the same Host state root
```

CLI的`list/show/search/remember/retract/rebuild`全部通过解压后`dist/cli.js`执行。release child只注入一个credential-free deterministic fake backend，并保存真正送给model backend的ContextPlan/ModelRequest；它不使用测试源码中的fake，也不发起live provider请求。

## 最小设计与为什么

没有新增release framework或产品schema。ML5只增加：

- 一个只服务pack/release evidence的Node子进程驱动器；
- 一个冻结11步输入和期望的fixture；
- 一个4-case blocking evidence manifest；
- pack日志中的`memory_v1_release_demo_passed:` JSON receipt。

CI已有Linux `quality`和Windows `windows-phase20` jobs，两者都执行`pnpm check`与`pnpm pack:smoke`，所以不新增workflow。CI中receipt读取`GITHUB_SHA`，使演示结果自然绑定当前exact commit；本地运行时该字段为`null`，不能冒充远端exact-commit证明。

## 实际唯一发布演示

本地final tarball已通过11步：

1. mode-off baseline产生0条historical memory；
2. local Session A成功完成受控read-only任务；
3. terminal后发布一条exact-source episode并完整退出；
4. packed `memory list/show`验证scope、source与record hash；
5. 新Node进程Session B在同仓query命中Session A；
6. ContextItem保持`historical_only`，`search --explain`显示why/source；
7. 用户显式remember preference，新Node session召回exact revision；
8. retract后Session C不再使用该record ID；
9. 第二个真实Host repository相同query得到0条历史记忆；
10. 删除整个derived retrieval目录后，rebuild保持logical hash与hit order；
11. 最终mode-off恢复与baseline相同的稳定non-memory request shape。

本地receipt为11/11，7个独立Agent子进程，`wrongRepositoryRecords=0`、`retractedRecordUses=0`、`remoteBillableRequests=0`。它是local deterministic contract，不是remote/live model quality evidence。

## 失败、修复与未解决问题

1. 初版harness按不存在的`record.task`找episode；真实字段是`taskPreview`。诊断证明episode已正确持久化，只修验收字段。
2. 第二仓库首次注册真实失败：`repository.register` action把非零catalog head的`lastRecordId/lastRecordSha256`错误重建为`null`，导致dispatch后的CAS失败并进入`control_operation_busy`。产品修复改为读取完整head，并核对其revision/hash仍等于prepared target后再执行registry CAS；新增顺序注册两个repository的回归测试。
3. Windows回归测试最初比较临时目录的8.3短路径与canonical长路径；把期望路径也`realpath`后通过。
4. ML5不运行remote provider、真实Ollama质量评估、secure erase、sync、automatic chat extraction或frontier adapter。它们不能从release receipt推断出来。

## 我现在如何解释这个概念

长期记忆的“可用”不是SQLite文件存在，而是一个时间与隔离合同：A结束后事实仍在；B是全新进程仍能找到它；当前指令永远高于历史；撤回后未来请求不再用它；另一个仓库看不到它；索引丢失可以从canonical state恢复；关闭功能时模型请求回到没有memory的路径。ML5验证的是这组合同在发布产物中同时成立。

## 测试与证据

- Phase21A second-repository focused regression：7/7 tests通过；
- ML5 evidence + second-repository focused：2 files / 9 tests通过；
- 全部`agent-memory`：17 files / 56 tests通过；
- full repository gate：non-PTY 289 files / 1,326 tests通过，6 files / 12 tests按平台预期跳过；PTY 5 suites通过、2 suites按平台预期跳过；clean build通过；
- ML5 11-step extracted-tarball demo：本地通过；
- ML5 evidence contract：`tests/evidence/agent-memory-ml5-v1.json`；
- Linux/Windows same-exact-commit repository与pack jobs：等待candidate push后执行；
- 只有两个required jobs与exact `GITHUB_SHA` receipt都通过后，才把Memory Lite core标记为`preview_usable`。

## 工程时间账

原spec预算为4–8 focused hours；开始前按ML2–ML4实测校准为约1–3 Agent wall-clock hours。最终结束时间在exact-commit CI和public handoff完成后填写；wall-clock包含CI等待，不等于连续人工编码时间。

| Category | Estimated | Actual window | Notes |
|---|---:|---:|---|
| contract/live audit | 0.2–0.4h | ~0.1h | 冻结existing-CI + packed child边界 |
| release demo/evidence | 0.3–0.8h | ~0.35h | 11-step fixture、child、receipt、manifest |
| product regression | 0.2–0.6h | ~0.2h so far | second-repository complete-head fix |
| local/full validation | 0.3–0.8h | ~0.45h | focused、289/1,326 repository gate、final pack |
| exact-commit CI/handoff | 0.3–1.0h | pending | push、Linux/Windows、public status |

## 下一步

完成本地full gate后提交candidate并推送。等待同一SHA的Linux/Windows jobs与两份`memory_v1_release_demo_passed` receipt；通过后只更新公开maturity与exact evidence，不继续增加memory功能。
