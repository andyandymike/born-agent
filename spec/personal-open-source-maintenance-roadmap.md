# BornAgent Personal Open-Source Maintenance Roadmap

> 状态：Active（2026-08-24）
> 当前工作：[`Agent Memory Learning Track`](../docs/agent-memory/learning-and-delivery-track.md) ML1；exact合同见[`Lightweight Memory Core and Frontier Adapters Spec`](agent-memory-lightweight-core-and-adapters.md)
> 下一候选：ML1真实跨进程proof后按证据进入ML2；AS6保持Not Started
> 基线：Phase 0–20 Implemented、M11 Passed、21A exact-commit CI Passed；AS5.2与AM0/AM1组件exact-commit CI Passed
> 路线变化：21B–21E Deferred；当前个人开源项目范围不再追求M12

## 1. 目标

把BornAgent长期维护成可靠、可理解、可复现的本地个人编码Agent。项目首先用于亲手实现、复现和比较有代表性的前沿Agent技术，其次把每次实现沉淀为个人可复用的概念理解、源码调用链、工程取舍、失败经验与真实时间账。后续工作由真实使用证据和明确学习问题共同驱动，不再按产品功能数量或连续Phase编号推进。

## 2. 持续工作轨道

1. **Frontier experiments**：从primary paper或reference implementation提出可复现实验，与当前简单baseline比较后决定retain/revise/reject。
2. **Learning and engineering record**：为每个切片记录真实源码路径、关键invariant、实验结果、踩坑和research/feature/tests/CI/docs时间分布。
3. **Runnable vertical slices**：优先交付用户可观察的最小闭环，不以内部schema、benchmark或framework存在代替产品行为。
4. **Release closure**：完成当前候选的提交、exact-commit CI与可复现安装证据。
5. **Real-use reliability**：从真实编码任务中记录并修复反复出现的失败。
6. **Architecture simplification**：按[`Architecture Simplification Maintenance Spec`](architecture-simplification-maintenance.md)删除重复、过渡和低价值复杂度，保持authority单一。
7. **Open-source maintenance**：维护安装、升级、排障、贡献与兼容性边界。

## 3. 工作进入路线的条件

正式工作项应来自真实需求或明确的前沿学习问题，能够给出可观察改进，保持local-first/offline-safe，复用现有authority，并具有与个人项目相称的维护成本。每项工作进入实现前必须写明product proof、learning question、baseline、时间区间和stop condition。尚未超过简单baseline的候选可以完成isolated experiment并形成学习成果，但不进入production主路径。

## 4. Deferred范围

21B local Web/IDE、21C browser/computer-use、21D remote worker、21E team governance，以及hosted service、dynamic Agent tree、marketplace和automatic Git publish，均不在当前实施范围。没有真实需求前，memory的team sync、remote private disclosure、old/new binary mixed-writer protocol、物理secure erase与企业级完整crash matrix也保持Deferred。原spec作为设计资料保留，不表示排期、兼容承诺或M12目标仍然有效。

## 5. 状态规则

当前路线不创建Phase22。一次只推进一个有明确证据边界的维护切片；`component_verified`只表示内部组件与gate通过，`slice_usable`要求真实CLI纵向行为，`release_verified`还要求exact-commit跨平台与安装证据。完成以真实行为、回归和可复现结果为准，不以文档、benchmark或内部class存在为准。工作超过预算上限或一半时间被非目标基础设施占用时，必须先报告再扩张范围。

## 6. 当前与下一工作项

- AS0.1–AS5.2与Agent Memory AM0/AM1组件已在exact commit `6ce181a75249c76f39e8d23bfeb7a7d31b31b29d`完成Linux/Windows CI；architecture characterization v3 canonical SHA-256仍为`7e362f1a05856f504947e8e678bd202aa6578dc77550db7025061ad53e80db91`。
- AM0/AM1当前状态是`component_verified`：production memory仍为`off`，没有跨session ledger、retrieval或automatic recall，不能写成长期记忆完成。
- 当前ML1按[`Agent Memory学习与交付路线`](../docs/agent-memory/learning-and-delivery-track.md)排序，并由[`Lightweight Memory Core and Frontier Adapters Spec`](agent-memory-lightweight-core-and-adapters.md)约束exact行为：completed Session A产生source-bound episode，进程重启后由`born memory list/show`解释读取，并留下源码学习记录与实际时间账。
- AS6保持`not_started`。后续继续一次只做一个可观察maintenance slice；exhaustive设计保留为研究资产，不作为一次性大重写排期。
