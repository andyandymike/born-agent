# BornAgent Personal Open-Source Maintenance Roadmap

> 状态：Active（2026-08-14）
> 当前工作：AS0.1–AS5.1 exact-commit release closure
> 下一候选：[`Architecture Simplification Maintenance Spec`](architecture-simplification-maintenance.md)中的AS5.2 Projection Ownership（Ready / Implementation Not Started）
> 基线：Phase 0–20 Implemented、M11 Passed、21A local gate Passed
> 路线变化：21B–21E Deferred；当前个人开源项目范围不再追求M12

## 1. 目标

把BornAgent长期维护成可靠、可理解、可复现的本地个人编码Agent。后续工作由真实使用证据驱动，不再按产品功能数量或连续Phase编号推进。

## 2. 持续工作轨道

1. **Release closure**：完成当前候选的提交、exact-commit CI与可复现安装证据。
2. **Real-use reliability**：从真实编码任务中记录并修复反复出现的失败。
3. **Architecture simplification**：按[`Architecture Simplification Maintenance Spec`](architecture-simplification-maintenance.md)删除重复、过渡和低价值复杂度，保持authority单一。
4. **Quality and efficiency**：改善上下文、工具选择、修改精度、验证闭环和性能。
5. **Open-source maintenance**：维护安装、升级、排障、贡献与兼容性边界。

## 3. 工作进入路线的条件

正式工作项应来自真实需求，能够给出可观察改进，保持local-first/offline-safe，复用现有21A authority，并具有与个人项目相称的维护成本。未满足这些条件的想法只进入实验或issue，不进入主路线。

## 4. Deferred范围

21B local Web/IDE、21C browser/computer-use、21D remote worker、21E team governance，以及hosted service、dynamic Agent tree、marketplace和automatic Git publish，均不在当前实施范围。原spec作为设计资料保留，不表示排期、兼容承诺或M12目标仍然有效。

## 5. 状态规则

当前路线不创建Phase22。一次只推进一个有明确证据边界的维护工作项；完成以真实行为、回归和可复现结果为准，不以文档、演示或功能存在为准。

## 6. 当前与下一工作项

- 21A与AS0.1–AS5.1仍等待对应exact commit的Linux/Windows CI证据；本地通过不冒充release完成。
- AS0.1–AS5.1已逐包完成本地实现与gate：evidence/characterization、handoff/scanner、single Host/runtime attenuation、shared session evidence/cancellation/read ports、product/TUI boundary以及terminal/resource ownership均已落地。当前tracked manifest为102项，default/metric/built-path/pack四个本地profile分别为54/35/12/1并全部通过receipt回读验证；characterization v3 canonical SHA-256为`7e362f1a05856f504947e8e678bd202aa6578dc77550db7025061ad53e80db91`。
- 下一候选是AS5.2 projection ownership，状态`ready`但尚未实施；AS6仍未解锁。后续继续一次只做一个maintenance item，不做一次性大重写。
