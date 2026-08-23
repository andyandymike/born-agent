# BornAgent 学习型开发路线图

> 状态：Phase 0–20 Implemented；M11 Passed；21A local gate Passed；21B–21E Deferred；M12 Not Pursued in Current Scope（2026-08-14）
> 当前路线：Personal Open-Source Maintenance；[`Architecture Simplification Maintenance`](spec/architecture-simplification-maintenance.md)已连续实施并本地收口到AS5.2，等待exact-commit Linux/Windows CI；AS6保持not_started
> 目标：一边构建一个类似 Claude Code / OpenCode 的本地编码 Agent，一边系统理解模型调用、工具执行、权限、上下文、会话与评测。

> 历史状态说明：Phase 0–15章节中保留的未勾选checkbox是早期archival planning原貌，不是当前未完成gate；当前状态以本页顶部、对应milestone spec/learning evidence和后续已通过gate记录为准。没有可复核证据时不得据此补勾或重写历史。

Phase 0–21 的详细实现合同与当前实施状态见 [`spec/README.md`](spec/README.md)；当前有效后续路线见[`Personal Open-Source Maintenance Roadmap`](spec/personal-open-source-maintenance-roadmap.md)。Phase17 / M8、Phase18 / M9、Phase19 / M10与Phase20 / M11均已收口，21A的surface-neutral本地控制平面已通过本地gate。21B–21E保留为设计参考但已Deferred，不提前宣称Web/IDE/browser/remote/team能力。

## 1. 我们要做什么

BornAgent 最终应该能在本地代码仓库中完成这样的闭环：

```text
用户任务
  -> 理解仓库和约束
  -> 调用模型
  -> 读取与搜索代码
  -> 提出并执行修改
  -> 运行验证
  -> 根据真实结果继续修复或结束
  -> 保存过程并汇报证据
```

这个项目不以“最快拼出最多功能”为目标。每个阶段只增加一个主要难点，并要求我们先理解问题、做出最小实现、验证行为，再接入更成熟的开源组件。

## 2. 学习与开发原则

1. **一次只推进一个 Phase。** 当前 Phase 未满足退出条件时，不提前实现后面的功能。
2. **先做最小闭环，再增加抽象。** 没有第二个需要支持的实现之前，不为想象中的扩展设计复杂框架。
3. **先理解一次，再复用成熟实现。** 例如先通过官方 SDK 类型、文档与 fake transport 理解流式事件和工具调用，再用 `pi-ai` 接入多模型。
4. **危险能力逐级开放。** 顺序固定为：聊天 -> 只读工具 -> 文件修改 -> 受控命令执行 -> 网络与外部系统。
5. **所有外部能力都经过边界。** 模型、工具、执行器、存储和 UI 都通过 BornAgent 自己的接口连接，避免被某个框架锁死。
6. **测试只能证明测试覆盖的行为。** 完成一个 Phase 需要可执行 fixture、CLI 证据和可检查产物；没有 live provider 证据时必须诚实标记为 contract evidence。
7. **记录为什么。** 每个 Phase 完成后写一页简短学习笔记：设计、踩坑、取舍、仍不理解的问题。
8. **关键边界写学习注释。** Phase 4–21 使用 `// PHASEx:` 解释 why/invariant/trust boundary；不写逐行翻译、
   commented-out code、secret、fixture 答案或无 owner TODO。
9. **本地默认永远零付费。** Phase 15 把 access rule 迁移为 runtime policy，但唯一隐式默认仍是 `local-free-v1`；远程 profile
   只能由受信用户配置定义并逐 run 显式选择。本路线的实现、测试和验收继续只用 fake/mock 或 loopback Ollama，不读取真实 key、
   不发真实远程请求，也不执行 checked-in full eval。配置化不允许 prompt/repository/environment 静默扩大权限。

## 3. 每个 Phase 的固定完成流程

每个阶段按以下顺序推进：

1. 阅读该阶段涉及的最少资料。
2. 用自己的话解释关键概念。
3. 实现最小版本。
4. 添加自动化测试。
5. 在 fixture 仓库中完成一次零费用 CLI 演示：优先 fake/mock；需要 live model 时只能使用 loopback Ollama。
6. 检查实际输出、文件变化和退出状态。
7. 用 `rg` 人工核对本阶段关键 `// PHASEx:` 注释，并在学习笔记中复述其保护的 invariant。
8. 写 `docs/learning/phase-XX-*.md` 学习记录。
9. 满足退出条件后再进入下一阶段。

建议每个 Phase 使用独立提交，提交信息包含阶段号，例如：

```text
phase-03: add read-only tools
```

## 4. 路线总览

| 里程碑 | 阶段 | 得到的产品 | 主要学习目标 |
|---|---|---|---|
| M0：模型客户端 | Phase 0–2 | 可流式对话并保存事件的 CLI | TypeScript CLI、模型 API、流式事件 |
| M1：只读 Agent | Phase 3–4 | 能自主读取和搜索仓库 | Tool calling、Agent Loop、停止条件 |
| M2：安全编码 Agent | Phase 5–7 | 能批准修改、运行命令并验证任务 | Patch、权限、进程、完成判定 |
| M3：可恢复的多模型 Agent | Phase 8–10 | 可切换供应商、恢复会话、管理上下文 | Provider 抽象、事件溯源、Compaction |
| M4：可扩展产品 | Phase 11–13 | 有 TUI、MCP 和隔离执行 | 交互设计、扩展协议、Sandbox |
| M5：可靠性工程 | Phase 14 | 有可重复的 Agent 评测体系 | Evals、回归、成本与质量权衡 |
| M6：策略驱动运行时 | Phase 15 | 默认零付费、可审计且可显式选择 profile | Policy schema、authority、配置合并与运行时守卫 |
| M7：协作型单 Agent | Phase 16 | 有持久目标、可审计划、连续会话和统一结果 | Goal/Plan 状态机、模式隔离、模型资格、durable UI |
| M8：仓库智能 | Phase 17 | 有source snapshot、nested rules和可验证结构化导航 | 事实层级、派生索引、freshness、检索benchmark |
| M9：能力平台 | Phase 18 | 有run-frozen Skills、MCP resources/prompts、Hooks与本地Plugin | 能力身份、来源/版本、authority、生命周期与分发 |

---

## Phase 0 — 项目地基

**预计：1 个专注开发时段**

### 要理解

- Node.js ESM 与 TypeScript 编译/直接运行的区别。
- CLI 的参数、标准输入、标准输出和退出码。
- 单元测试、类型检查、格式检查分别解决什么问题。

### 要实现

- 初始化 TypeScript + Node.js 项目。
- 建立 `src/`、`tests/`、`fixtures/`、`docs/learning/`。
- 提供 `born --help`、`born --version`、`born doctor`。
- `doctor` 检查 Node、Git、`rg` 和必要环境变量，但不读取或输出密钥内容。
- 建立 `typecheck`、`test`、`lint`、`build` 命令。

### 暂时不做

- 不调用模型。
- 不做 TUI。
- 不做 monorepo。
- 不设计插件系统。

### 退出条件

- [ ] 全新终端中可以运行 `born --help`。
- [ ] `born doctor` 在缺少依赖时给出可操作的诊断。
- [ ] 自动化测试和类型检查通过。
- [ ] 已完成 Phase 0 学习记录。

## Phase 1 — 单模型、非 Agent 对话

**预计：1–2 个专注开发时段**

### 要理解

- System、user、assistant 消息分别是什么。
- 请求、响应、token usage、finish reason。
- API key、模型 ID、base URL 和超时。
- 普通聊天为什么还不是 Agent。

### 要实现

- 只选择一个供应商，使用其官方 SDK。
- 提供 `born chat "你好"`。
- 支持超时、取消、常见 API 错误和清晰退出码。
- 密钥只从环境变量读取，不写入仓库和 session。
- 建立假的 Model Client，用于无网络测试。

### 暂时不做

- 不做工具调用。
- 不做多模型抽象。
- 不做自动重试风暴。

### 退出条件

- [ ] production adapter 经 fake/mock transport 完成一次完整请求合同，远程请求数为 0。
- [ ] 无 API key 时有明确诊断，且缺少远程凭据不阻塞本路线继续实施。
- [ ] Fake Model Client 能稳定覆盖成功、超时和错误路径。
- [ ] 能解释一次调用的完整输入与输出。

## Phase 2 — 流式事件与最小会话记录

**预计：1–2 个专注开发时段**

### 要理解

- HTTP 流式响应与完整响应的差异。
- Provider 原始事件和 BornAgent 内部事件为什么要分开。
- Event log、最终状态和日志文本的区别。
- AbortSignal 如何贯穿一次调用。

### 要实现

- 定义最小内部事件：`run.started`、`text.delta`、`usage`、`run.completed`、`run.failed`、`run.cancelled`。
- 将供应商事件转换成 BornAgent 事件。
- 文本实时输出到终端。
- 每次运行写入 `.bornagent/sessions/<id>.jsonl`。
- 对事件结构做 schema 校验和版本标记。

### 退出条件

- [ ] 用户能看到逐步产生的文本，而不是等待完整响应。
- [ ] Ctrl+C 可以结束请求且不会留下损坏的 JSONL。
- [ ] session 文件可以逐行解析并重建最终输出。
- [ ] 日志中不包含 API key。

## Phase 3 — 只读工具

**预计：2–3 个专注开发时段**

### 要理解

- Tool schema、tool call、tool result 的协议。
- 为什么工具参数必须经过运行时校验。
- 模型“要求执行工具”和程序“允许执行工具”的区别。
- 工作区路径规范化和目录穿越问题。

### 要实现

- `read_file`：读取工作区内文本文件，限制大小。
- `search`：调用 `ripgrep`，限制结果数量和输出大小。
- `list_files`：列出受控数量的文件。
- `ToolRegistry`：注册、校验、执行和记录工具。
- 所有文件路径解析到真实绝对路径后检查是否仍在工作区内。
- 使用固定状态机完成最多一次工具调用和一次结果回传；通用循环留到 Phase 4。

### 暂时不做

- 不修改文件。
- 不执行任意 Shell。
- 不访问工作区外目录。

### 退出条件

- [ ] Agent 能回答一个必须读取 fixture 文件才能回答的问题。
- [ ] `../`、符号链接和绝对路径不能逃出工作区。
- [ ] 大文件和大量搜索结果会被明确截断。
- [ ] 每次工具调用及结果都进入 session event log。

## Phase 4 — 真正的 Agent Loop

**预计：2–3 个专注开发时段**

### 要理解

- Agent 的 observe -> decide -> act -> observe 循环。
- 一个用户回合为什么可能包含多次模型调用。
- stop reason、step limit、重复工具调用和死循环。
- 工具失败为什么应反馈给模型，而不是总让程序崩溃。

### 要实现

- 自研 `AgentLoop`，串联模型、工具调用和工具结果。
- 最大 step、最大运行时间、最大 token 和工具输出预算；本阶段不伪造 monetary hard limit。费用字段的计算合同留到 Phase 14 用 synthetic catalog/usage 验证，不产生真实账单。
- 连续相同工具调用检测。
- 工具错误分类：可反馈错误、权限错误、系统错误。
- 清晰区分 `completed`、`failed`、`cancelled`、`budget_exceeded`。

### 退出条件

- [ ] Agent 能通过多次读取与搜索完成一个仓库问答任务。
- [ ] 模型反复调用同一工具时能够安全终止。
- [ ] 工具失败后 Agent 至少能看到结构化错误并决定下一步。
- [ ] 最终状态与 session 中的真实事件一致。

## Phase 5 — 受控文件修改

**预计：2–3 个专注开发时段**

### 要理解

- 完整覆盖、字符串替换、diff/patch 三种修改方式的权衡。
- Patch 校验、应用和冲突。
- 修改前后快照与用户可审查 diff。
- 为什么模型输出的 patch 不能直接信任。

### 要实现

- `apply_patch` 工具，只允许修改工作区内文件。
- 应用前执行语法和目标校验。
- 使用 Git 生成用户可读 diff。
- 默认在修改前请求一次性批准。
- 拒绝修改时将结果反馈给 Agent。

### 退出条件

- [ ] Agent 能在 fixture 仓库修改一个小函数。
- [ ] 用户批准前磁盘内容不变化。
- [ ] 非法、过期或越界 patch 不会产生半完成修改。
- [ ] 最终汇报列出的文件与 run-local ChangeJournal diff 一致，并能在包含用户既有改动的整体 `git diff` 中定位对应 hunks。

## Phase 6 — 受控命令执行与权限系统

**预计：3–4 个专注开发时段**

### 要理解

- 子进程、工作目录、环境变量、stdout/stderr 和退出码。
- Shell 字符串和 argv 执行的安全差异。
- PowerShell、cmd、bash 在管道、重定向和命令组合上的差异。
- `allow / ask / deny` 权限模型。

### 要实现

- `Executor` 接口和 `LocalExecutor`。
- 使用 `execa` 管理进程、流式输出、超时和取消。
- `PermissionEngine`，默认策略为只读允许、修改询问、危险操作拒绝。
- 输出上限、环境变量白名单和命令记录。
- 第一版明确拒绝删除、提权、push 和工作区外写入。
- `shell:false` 只保证模型 argv 不由宿主 shell 二次解析；获批的 repository/package script 仍是通用宿主代码执行边界，
  必须在批准预览和学习记录中明确。

### 退出条件

- [ ] Agent 能在批准后运行 fixture 测试。
- [ ] 超时或 Ctrl+C 后子进程不会继续在后台运行。
- [ ] 命令退出码和 stderr 会如实反馈给 Agent。
- [ ] 被拒绝的命令没有产生副作用。

## Phase 7 — 验证与完成判定

**预计：2–3 个专注开发时段**

### 要理解

- “模型说完成了”和“任务实际完成了”的差异。
- 单元测试、静态检查、diff 检查和用户可见验收各自证明什么。
- Completion policy 为什么属于 Agent 产品核心。

### 要实现

- `CompletionPolicy`：有代码修改时必须检查 diff，并运行相关验证。
- 记录验证命令、退出码、关键输出和修改文件。
- 最终回答由结构化事实生成摘要，不能只转发模型自述。
- 建立第一批端到端 fixture：修复测试、错误路径、无法完成路径。

### 退出条件：M2 / v0.1

- [ ] Agent 能定位并修复一个故意制造的失败测试。
- [ ] Agent 真实运行测试且测试通过。
- [ ] 验证失败时不会报告完成。
- [ ] 最终报告与实际 diff、命令和退出码一致。
- [ ] 中断后仓库仍处于可理解、可恢复状态。

## Phase 8 — 多模型 Provider 层

**预计：2–3 个专注开发时段**

### 要理解

- OpenAI、Anthropic、Gemini 的消息和工具协议有哪些差异。
- 哪些能力可以统一，哪些 provider-specific 能力必须保留。
- 模型切换时，reasoning、tool call 和历史消息如何转换。
- 为什么“OpenAI compatible”不等于行为完全一致。

### 要实现

- 固化 BornAgent 自己的 `ModelBackend` 和 `ModelEvent` contract。
- 在 adapter 后接入 `@earendil-works/pi-ai`；以上游 `v0.80.7` 为当前 repo baseline，实施时重新核对 npm 并固定精确版本。
- 首批功能支持：OpenAI、Anthropic、Ollama；OpenAI/Anthropic 只做 production-adapter contract verification，唯一允许的 live backend 是 loopback Ollama。
- `born models` 与显式 `--provider`、`--model`。
- Provider contract tests：流式文本、工具调用、取消、错误、usage。
- model capability 在首个推理请求前 fail-fast；同一 run 冻结 provider/model，不做 silent fallback。

### 暂时不做

- 不承诺所有 provider 功能完全等价。
- 不接入订阅账户的非官方认证流程。
- 不引入 LiteLLM 服务。

### 退出条件

- [ ] 同一个只读 Agent fixture 通过三个 production adapter 的 fake-runtime contract；可选的 live 证据只来自 loopback Ollama。
- [ ] 切换 provider 不需要修改 AgentLoop 和工具代码。
- [ ] 不支持的模型能力会明确报错，而不是静默降级。
- [ ] provider 原始事件不会泄漏到核心领域模型中。

## Phase 9 — 可恢复会话

**预计：2–3 个专注开发时段**

### 要理解

- Event sourcing 与只保存最终 messages 的差异。
- 幂等、崩溃恢复、事件 schema 演进。
- session、run、turn、message、tool call 的关系。

### 要实现

- `born sessions list/show/resume`。
- 从 JSONL 重放会话；resume 在同一 session 创建新 run，不伪装继续崩溃的旧 run。
- 原子写入与损坏尾行恢复。
- old approval 不恢复 authority；command effect 不明时不自动重跑。
- 数据量需要查询后，再评估迁移 SQLite + Drizzle；不提前迁移。

### 退出条件

- [ ] 进程在工具调用后被结束，重新启动仍能解释最后状态。
- [ ] 已完成会话可重放出相同的用户可见记录。
- [ ] schema 版本不兼容时有明确迁移或拒绝信息。

## Phase 10 — 上下文管理与仓库规则

**预计：3–4 个专注开发时段**

### 要理解

- Context window、输入 token、输出 token 和缓存。
- 截断、裁剪、摘要压缩和重新检索的差异。
- 长 session 中哪些事实必须保真。
- 仓库规则、用户指令和工具结果的优先级。

### 要实现

- token budget 和上下文使用可视化。
- 大工具结果把 bounded physical capture 写入本地 artifact；`tool.call.completed.output` 仍精确保存当时真正交给模型的
  有界 observation，artifact ref 只是附加证据。
- 可测试的 compaction 策略。
- 第一版只加载 workspace root `AGENTS.md`，run 内按 hash 冻结；不做 nested/include/rules directory。
- 摘要中保留未完成任务、用户约束、文件修改和验证状态。
- 第一版 compaction 完全确定性，不发隐藏 summarizer 模型请求。

### 退出条件

- [ ] 人工制造的超长 session 可以继续运行。
- [ ] 压缩后不会丢失尚未完成的用户要求。
- [ ] 压缩前后的关键状态可通过测试比较。

## Phase 11 — 交互式 TUI

**预计：3–5 个专注开发时段**

### 要理解

- 终端 raw mode、ANSI 控制序列、差分渲染和键盘事件。
- 流式输出、工具状态和用户输入如何并发更新。
- UI state 为什么不能直接充当 Agent state。

### 要实现

- 接入 `@earendil-works/pi-tui`，但只消费已持久化 BornAgent 事件，不侵入 AgentLoop。
- 对话、工具调用折叠、diff 预览、批准弹窗。
- Ctrl+C 取消、继续输入和 session 切换。
- 非交互模式继续可用，方便脚本和测试。

### 退出条件

- [ ] 同一任务在 TUI 和非交互模式产生等价核心事件。
- [ ] 权限弹窗不会阻塞事件持久化或破坏终端状态。
- [ ] Windows Terminal 中完成一次真实编码任务。

## Phase 12 — MCP 扩展

**预计：3–5 个专注开发时段**

### 要理解

- MCP 的 tools、resources、prompts 和 transport。
- stdio server 的生命周期和不可信输出。
- 工具发现与工具授权为什么必须分开。

### 要实现

- 固定官方 `@modelcontextprotocol/sdk@1.29.0` v1；v2 仍是 pre-alpha 时不静默迁移。
- 支持 stdio MCP server 的启动、发现、调用和关闭。
- MCP 工具映射到统一 `ToolRegistry`。
- MCP 工具仍必须经过 `PermissionEngine`、超时和输出限制。

### 退出条件

- [ ] 能接入一个本地测试 MCP server。
- [ ] MCP server 崩溃不会带崩主 Agent。
- [ ] 未批准的 MCP 工具无法执行。
- [ ] session 能区分内置工具与 MCP 工具来源。

## Phase 13 — 隔离执行与 Sandbox

**预计：4–6 个专注开发时段**

### 要理解

- 应用层批准和操作系统隔离解决的是不同问题。
- 文件系统、进程、网络、凭据四种边界。
- 宿主执行、Docker、WSL/VM 和远程 sandbox 的权衡。

### 要实现

- 保持 `Executor` 接口不变，规范性增加 DockerExecutor；普通 WSL distro 不称为 sandbox。
- 对 disposable workspace snapshot 执行命令，不 RW mount 真实宿主 workspace，也不自动回写产物。
- 明确挂载目录、网络策略、环境变量和资源限制。
- provider 密钥尽可能留在宿主，不直接暴露给 sandbox。
- 记录命令实际在哪个执行环境运行。

### 退出条件

- [ ] 同一 fixture 能分别通过 LocalExecutor 和 DockerExecutor 完成。
- [ ] Sandbox 无法读取未挂载的宿主文件。
- [ ] 网络关闭时任务行为可预测且错误清晰。

## Phase 14 — 评测与可靠性工程

**预计：持续进行；首次建设 3–5 个专注开发时段**

### 要理解

- 确定性软件测试和概率性 Agent eval 的区别。
- pass rate、成本、延迟、工具次数和人工批准数之间的权衡。
- 为什么更强模型不一定让整个系统更可靠。

### 要实现

- 至少 20 个版本化 fixture 任务。
- 每个任务包含初始仓库、验收命令和允许的修改范围。
- 记录成功率、token、nullable 估算/账单费用、耗时、步骤数和失败类型；费用管线只用 synthetic fixtures 验证。
- 支持比较模型、provider、prompt、工具实现和版本。
- 运行固定的 zero-cost smoke eval；实现 full suite 能力，但当前策略明确不执行任何 full eval。

### 退出条件：M5

- [ ] 同一版本评测可以重复执行并生成结构化报告。
- [ ] targeted tests 与本地 smoke 能生成质量、synthetic cost 和延迟差异；full quality baseline 标记 `not_run_by_policy`。
- [ ] valid attempt 的失败被分类为模型、provider、工具、权限、环境、上下文或完成判定问题；harness-invalid 独立统计且不进入 valid denominator。

---

## Phase 15 — 可配置 Runtime Policy

**预计：2–4 个专注开发时段**

### 要理解

- policy-as-data 与 invariants-as-code 的区别。
- 为什么默认配置、用户 profile、运行请求和模型输入具有不同 authority。
- 为什么“允许远程 provider”必须在 credential/request/socket 之前判定。
- 为什么 request/token ceiling 不是美元账单 hard cap。
- 为什么 `docker build` 的命令名不能证明 builder 在本机，以及 Docker context/daemon endpoint 如何改变成本和信任边界。
- 为什么 pulled image 用 registry digest，而 locally-built image 要绑定 image ID + Dockerfile/context/base-image hashes。

### 要实现

- 随 package 发布并严格校验的 `local-free-v1` policy asset；无 flag 时默认 Ollama/literal-loopback。
- 用户级 local/remote profile registry；远程 profile 不能成为默认，必须每次显式选择。
- chat/agent/tui/resume/models/eval 共用的 effective policy resolver、provider guard 与 evidence。
- policy 在 credential resolver 前执行；local-free 下 credential 读取数为 0。
- eval suite access 配置化：built-in 只允许 targeted/smoke，显式 local profile 可表达 full，remote+full 非法。
- `born policy show/validate/explain`、profile hash、session/resume/report/TUI evidence。
- built-in Docker artifact lock 与 `born docker status/prepare`；默认允许公共匿名 exact-digest pull 和 trusted local-context build。
- local-daemon/builder guard、空 Docker credential config、no push/remote builder，以及 pulled/local-build identity union。

### 暂时不做

- 真实远程 provider/full eval 验收。
- proxy、redirect、fallback、自动 retry和自动 model pull。
- 任意/模型指定的 Docker image、Dockerfile/context、private/authenticated registry、push、remote/cloud builder。
- repository 扩大 policy、团队策略服务器和远程配额服务。

### 退出条件：M6

- [ ] 无 config/flag 时始终选择 built-in local-free，remote/key/socket 调用数为 0。
- [ ] remote profile 只有显式用户选择才可到 credential/transport，contract test 全程使用 fake transport。
- [ ] policy/profile/hash/decision 可重建，所有模型入口和 resume 均无绕过路径。
- [ ] locked Docker pull/build仅命中本机 daemon与built-in artifact；registry credential reads、push和remote builds均为0。
- [ ] Phase 15 gate 未调用任何付费账号/外部服务、未读取真实 key、未运行 checked-in full；Docker只使用匿名公共pull与本机build。

---

## Phase 16 — Goal / Plan / Todo 与连续单 Agent 协作

**预计：13–21 个专注开发时段（16A–16F 合计，不是日历承诺）**

规范实施链：`16A facts -> 16B user control -> 16C agent plan tool -> 16D Plan/Build runtime -> 16E qualification -> 16F continuous TUI/M7`。
导航、共同不变量与每个子gate见[`Phase 16 / M7实施包`](spec/07-m7-collaborative-single-agent/README.md)。

### 要理解

- 对话 transcript、用户目标、Agent 建议计划、执行进度和真实完成证据为什么不是一回事。
- Plan 模式为什么必须在工具装配层只读，而不能只靠 prompt 说“不要修改”。
- 用户批准 plan 和用户批准 patch/command 为什么是两个独立 authority。
- 常驻 TUI 为什么仍应把每次 follow-up 建模为新 run，并重新经过 resume/policy/effect gate。
- 模型 adapter 声明、协议资格探测和实际任务质量分别能证明什么。

### 要实现

- 一个 session 内可持久、可 revision、可 replay 的 Goal；最多一个 active goal。
- Plan revision 与 Todo 状态机；Todo就是 PlanItem，不建立第二套 store。
- Agent 可提出/更新计划，用户可查看、替换、批准或拒绝 exact revision/hash。
- `plan | build` run mode：Plan 机械只读，Build 复用现有 coding AgentLoop 与全部安全边界。
- TUI idle 消息自然创建同 session 新 run；one active run、无隐藏消息队列，`/resume` 保留为恢复入口。
- current goal/active plan 进入 protected context、resume fingerprint、TUI/replay与统一 OutcomeReport。
- Build跨run变化通过artifact-backed GoalChangeLedger归因并继续走existing CompletionPolicy，不退化为last-run-only完成。
- 显式、有界、可失效的 `born models qualify`；不自动 probe、route、fallback或pull model。

### 暂时不做

- LSP、Tree-sitter、符号索引、代码图谱、向量数据库和语义记忆。
- 完整 Skills/Hooks/Plugin 平台或 marketplace。
- 通用 task DAG、worktree、后台队列、远程 worker。
- subagent/multi-agent、parallel model run、自动模型路由。
- IDE/Web/Browser/computer-use 产品 surface。

### 退出条件：M7

- [x] Goal、Plan revision、Todo与批准全部来自同一个 durable JSONL事实源，live/replay一致。
- [x] Plan mode没有工作区副作用入口；Build mode不绕过policy/permission/sandbox/completion。
- [x] plan-first与direct-build都有明确合同；plan completed不等于goal completed。
- [x] TUI可以在同一session自然完成plan -> approve -> build -> follow-up，多run序列正确且无并发active run。
- [x] 模型qualification显式、可重建、identity变化即失效；正式gate只有fake/mock或可选loopback Ollama证据。
- [x] CLI/TUI/report显示同一个current step、blocker、changes、verification与outcome。
- [x] run A修改、run B验证/finish仍能重建aggregate Goal changes；artifact/chain/current-disk mismatch fail closed。
- [x] crash/concurrency/compatibility测试证明stale批准、重复plan mutation和虚假完成均被拒绝。

跨阶段authority与M7总验收见[`Phase 16总合同`](spec/07-m7-collaborative-single-agent/16-phase-16-goal-plan-continuous-session.md)；
字段、文件、失败窗口和测试命令见[`16A–16F子spec`](spec/07-m7-collaborative-single-agent/README.md)。

---

## Phase 17 — Repository Intelligence

**预计：14–21 个专注开发时段（17A–17E 合计，不是日历承诺）**

规范实施链：`17A snapshot/baseline -> 17B nested rules -> 17C measured index -> 17D navigation/context -> 17E freshness/M8`。
导航、共同不变量和每个子gate见[`Phase 17 / M8实施包`](spec/08-m8-repository-intelligence/README.md)。

### 要理解

- current workspace bytes、Git facts、历史snapshot、derived index和模型叙述为什么不是同一层事实。
- definition/reference的semantic、syntactic和textual证据分别能证明什么。
- nested repository rules为什么最深scope优先但仍不能覆盖用户或Host policy。
- incremental index为什么必须与clean full build得到等价canonical result。
- benchmark retrieval correctness、fake Agent integration与真实模型任务质量为什么必须分开。

### 要实现

- Git/non-Git canonical source snapshot、stable read、dirty/untracked/partial coverage。
- model-free hidden-gold benchmark与当前`list_files/search/read_file` baseline。
- run-scoped nested `AGENTS.md` manifest、path scope、frozen rule artifacts和stale action binding。
- 由benchmark选择并精确pin的TS/JS symbol/reference engine；immutable generation与增量cache。
- `repository_outline`、`find_symbol`、`find_references`三个bounded readonly tools。
- current-source freshness guard、generation-bound ID/cursor、honest unsupported/partial semantics。
- ContextPlanner、Plan/Build registry、qualification identity、CLI/TUI/replay/OutcomeReport接入。
- cross-process、crash、cancel、real PTY与M8 zero-cost acceptance。

### 暂时不做

- embedding、向量数据库、RAG服务、长期semantic memory或“全仓代码图谱”。
- repository动态指定parser、language server、plugin、command或download。
- 常驻index daemon、后台queue、remote/shared index或telemetry upload。
- Skills/Hooks/Plugin平台、worktree、task graph、subagent/multi-agent。
- IDE/Web/Browser/computer-use/remote worker产品surface。

### 退出条件：M8 / v0.8

- [x] source/rules/session/index的事实层级明确；index可删除重建且旧session replay不依赖cache。
- [x] nested rules按path/frozen run工作，deepest scope不扩大permission/approval/completion authority。
- [x] engine由可重建benchmark decision选择并精确pin，没有先加依赖再倒推理由。
- [x] TS/JS definition/reference达到gold gate，partial/unsupported/textual语义诚实。
- [x] incremental与clean full build canonical等价；external edit后不返回旧range/ID/cursor。
- [x] Plan/Build获得三个readonly navigation tools，Plan机械只读与existing side-effect gates不变。
- [x] model-free retrieval context bytes达到baseline的70%以内且correctness不回退。
- [x] cross-process/cache crash/parser cancel/TUI PTY/Phase0–16回归通过。
- [x] fake integration没有被写成model quality pass，remote/full未运行项保持`not_run_by_policy`。

跨阶段authority与M8总验收见[`Phase 17总合同`](spec/08-m8-repository-intelligence/17-phase-17-repository-intelligence.md)；字段、文件、失败窗口和测试命令见[`17A–17E子spec`](spec/08-m8-repository-intelligence/README.md)。

---

## Phase 18 — Capability Platform

**预计：18–26 个专注开发时段（18A–18E合计，不是日历承诺）**

> 当前状态：18A–18E已实现并按顺序通过；M9 / v0.9 Passed（2026-08-10）。

规范实施链：`18A manifest/registry -> 18B skills -> 18C MCP resources/prompts -> 18D hooks -> 18E plugin lifecycle/M9`。
导航、共同不变量和每个子gate见[`Phase 18 / M9实施包`](spec/09-m9-capability-platform/README.md)。

### 要理解

- Skill知识/流程、MCP可调用primitive、Hook强制生命周期机制、Plugin分发包为什么不是同一种扩展点。
- installed、enabled、selected、frozen和permission granted为什么是五个不同状态。
- builtin/user/workspace来源、publisher自述和内容authority为什么不能互相替代。
- external content的role/位置为什么不能把它提升为system/user authority。
- Hook为什么只能deny/no-objection，且command Hook和original action必须分别审批。
- active run冻结、live catalog stale、disable/remove和historical replay如何同时成立。
- local install的stable read、content-addressed publish、lock/lease/crash recovery为什么是安全边界。

### 要实现

- strict JSON `bornagent.plugin.json`、component schemas、stable package reader和canonical package/component digest。
- `builtin | user_install | workspace`来源、exact qualified identity、显式enablement与run-frozen `CapabilitySnapshot`。
- `capabilities list/show/doctor`、session/artifact/replay/Outcome和model qualification identity接入。
- user-only/model-allowed Skills、bounded catalog、`list_skills/use_skill/read_skill_resource`与渐进context。
- 现有stdio MCP lifecycle/capability negotiation上的fixed resources与user-controlled prompts；opaque catalog ID、exact action、stale/content projection。
- 固定lifecycle events、declarative gate、受控foreground command Hook、stable ordering、revalidation、effect reconciliation。
- local-directory Plugin inspect/install/enable/disable/remove、immutable content store、atomic state、audit、active lease。
- 完整M9 fixture、cross-process/crash/cancel/security spies、真实PTY、pack与Phase0–17回归。

### 固定authority与生命周期

```text
Host policy + exact user intent/approval
  > trusted selection/enablement facts
  > model proposals
  > Skill/MCP/Hook output/Plugin descriptions

install exact bytes (disabled)
  -> explicit enable (eligible only)
  -> freeze exact run snapshot
  -> select/call under existing policy
  -> durable artifacts/events
  -> replay without live store/server
```

- manifest permission只是request/diagnostic，不是grant。
- 用户选择Skill/Prompt只批准把内容作为参考加入context，不批准正文提出的effect。
- MCP server start、tool call、resource read、prompt get是不同exact actions；一个approval不覆盖另一个。
- Hook `no_objection`不是allow；所有gate之后在original effect前必须重新验证action/source/rules/policy/plan。
- 活动run不hot reload。disable/remove只影响新run；历史replay不访问current package/server。
- 模型不能安装/启用/删除Plugin，不能选择user-only Skill或MCP Prompt，不能注册Hook。

### 暂时不做

- marketplace、registry、URL/Git/archive/network install、自动update。
- Plugin dependencies、semver resolver、install/build script、signature或publisher verified trust。
- HTTP MCP/OAuth、resource templates、subscriptions auto-read、sampling、elicitation、tasks、completion。
- Skill auto semantic matcher、allowed-tools、script execution、dynamic template/interpolation。
- prompt/model/agent/HTTP/background Hook或third-party in-process runtime。
- task graph、worktree、background queue、subagent、多Agent、vector/RAG、IDE/Web/remote worker。

### 退出条件：M9 / v0.9

- [x] 18A–18E依次通过，没有后阶段能力提前进入前一gate。
- [x] exact source/version/digest/enablement/snapshot贯穿run、action、event、artifact、replay和Outcome。
- [x] Skill/MCP/Plugin内容不能升级authority或扩大policy/approval/provider/completion权限。
- [x] Skills渐进披露与user/model invocation、compaction/resume/replay通过。
- [x] MCP negotiation、fixed resources、explicit user prompts、catalog stale和role injection防护通过。
- [x] Hooks only-deny/no-objection、独立approval、revalidation、cancel/crash/effect reconciliation通过。
- [x] local Plugin lifecycle零安装时执行，store/index/enablement/audit/lock/lease/tamper/recovery通过。
- [x] canonical/adversarial fixture、real PTY、cross-process、pack和Phase0–17回归通过。
- [x] 未运行的remote/Ollama/Docker/full eval保持`not_run_by_policy`，fake integration不写成model quality pass。

跨阶段authority与M9总验收见[`Phase 18总合同`](spec/09-m9-capability-platform/18-phase-18-capability-platform.md)；字段、文件、失败窗口和测试命令见[`18A–18E子spec`](spec/09-m9-capability-platform/README.md)。

---

## Phase 19 — Durable Task Graph / Worktree / Background

**预计：24–34 个专注开发时段（19A–19E合计，不是日历承诺）**

> 当前状态：19A–19E已实现并按顺序通过；M10 / v1.0 orchestration baseline Passed（2026-08-10）。

规范实施链：`19A graph kernel -> 19B deterministic scheduler -> 19C worktree/promotion -> 19D bounded background -> 19E product/M10`。
导航、共同不变量和每个子gate见[`Phase 19 / M10实施包`](spec/10-m10-durable-task-orchestration/README.md)。

### 要理解

- Goal/Plan表达“要做什么”，TaskGraph表达“按什么依赖和预算尝试执行”，为什么不能合并成一个mutable task state。
- Graph approval为什么只授权调度意图，不能预批准patch、command、MCP、Hook、worktree或promotion。
- ready queue如何仅由immutable Graph和durable terminal facts确定，为什么v1仍保持single-active model attempt。
- lease、heartbeat、PID/process-start identity、operation journal和session event分别证明什么，为什么time/PID/exit单独都不够。
- Git worktree为什么是文件隔离而不是sandbox，为什么origin dirty bytes必须进入explicit baseline。
- node在worktree完成和结果进入origin是两个authority阶段，为什么promotion后仍需要origin最新验证。
- background为什么是bounded ownership transfer而不是detach即成功，approval为什么必须让worker安全等待/退出。
- crash窗口中`not_applied/applied_exact/divergent/unknown`如何决定retry、takeover或block。

### 要实现

- strict TaskGraph revision/schema/hash、Goal/approved Plan绑定、DAG/bounds、user approval与Plan-only proposal tool。
- deterministic ready queue、single-active scheduler、node attempt/run binding、hierarchical budget、cancel/retry/reconcile。
- narrow Git worktree port、managed path、`--no-checkout`物化、clean/dirty baseline、workspace lease/lineage/freshness。
- build/verification nodes在managed worktree运行；Phase17 rules/index和Phase18 capability/policy按workspace/attempt重新冻结。
- text-only content-addressed promotion bundle、fresh target approval、preimage revalidation、GoalChangeLedger与origin verification。
- sealed built executable、parent/child handshake、handoff lease、heartbeat、cancel control、waiting-for-user、resume/takeover。
- `born graph` CLI、continuous TUI Graph panel、session/replay/canonical transcript/Outcome。
- canonical/adversarial Git fixture、real process/crash/two-owner/security、Windows PTY与pack smoke。

### 固定authority与生命周期

```text
approved Goal + approved Plan
  -> approved immutable TaskGraph
  -> explicit enqueue + workspace allocation confirmation
  -> deterministic one-active node attempt
  -> managed worktree result
  -> exact promotion approval into origin
  -> latest origin verification
  -> Graph terminal + existing Goal completion
```

- 普通Phase16任务仍无hidden queue；只有用户explicit approved/enqueued Graph进入可见ready queue。
- node是同一个BornAgent AgentLoop/Host verifier的一次attempt，不是subagent；每次attempt重新冻结policy/model/capability/workspace facts。
- Graph/node/path declarations只能收窄，不能授予effect。所有existing approval、sandbox、Hook和completion边界继续运行。
- 同一repository v1最多一个model-driven attempt。DAG先证明durability/isolation；parallel delegation留给Phase20。
- background child只执行一个exact Graph，达到terminal/waiting/budget/stale/cancel即退出，不扫描新任务、不自动重启。
- worktree在promotion前不能改变origin；worktree verification不能冒充origin completion。

### 暂时不做

- subagent、multi-agent、parallel model loop、parent/child authority inheritance。
- automatic Git commit/branch merge/rebase/cherry-pick/push/PR或conflict resolution。
- daemon、service、scheduled task、开机启动、remote worker、network control plane。
- IDE/Web/Browser/computer-use/team queue、notification、组织级审计/配额。
- binary/symlink/submodule promotion、任意force cleanup或自动GC。
- marketplace/vector/RAG/自动模型路由或remote/full eval。

### 退出条件：M10 / v1.0 orchestration baseline

- [x] Phase18 / M9正式Passed，19A–19E按顺序通过。
- [x] Graph schema/hash/Goal+Plan binding/approval/replay只有一个事实投影。
- [x] ready queue、single-active attempt、budget/cancel/retry/recovery确定且cross-process安全。
- [x] managed worktree、dirty baseline、workspace isolation、promotion与cleanup无origin/sibling越权。
- [x] background executable/handshake/lease/heartbeat/control/takeover不从spawn/PID/exit推断成功。
- [x] Graph/Plan/Goal/GoalChange/origin verification/Outcome完成链一致。
- [x] canonical/adversarial fixture、real crash/process/PTY/pack与Phase0–18回归通过。
- [x] ordinary direct Agent兼容且无hidden queue；没有subagent/parallel model/daemon/remote/auto Git publish。
- [x] skip/not-run/unsupported逐项报告，learning与`// PHASE19:`核对完成。

跨阶段authority与M10总验收见[`Phase 19总合同`](spec/10-m10-durable-task-orchestration/19-phase-19-durable-task-orchestration.md)；字段、文件、失败窗口和测试命令见[`19A–19E子spec`](spec/10-m10-durable-task-orchestration/README.md)。

---

## 5. M9 之后的能力路线

Phase18与Phase19完成后，规范顺序进入受控委派spec，再考虑产品面复杂度：

| 阶段 | 主题 | 核心产物 | 为什么排在这里 |
|---|---|---|---|
| Phase 19 / M10 | Durable Task Graph / Worktree / Background | exact DAG、single-active scheduler、隔离worktree、explicit promotion、bounded background recovery | 先证明单Agent子任务可以安全调度、隔离和接管，再允许并发委派 |
| Phase 20 / M11 | Controlled Subagents | 有界委派、子任务contract、最小上下文、独立预算/工具、结构化回传 | 把已成熟的task节点交给子Agent，不共享模糊状态或authority |
| Phase 21 / M12 | Product Surfaces / Remote | 21A application control plane已通过；21B–21E保留为设计参考 | 当前个人开源项目不继续产品化路线，M12不再作为当前目标 |

后续阶段边界：

- Phase 19 的 worktree是执行隔离，不是Agent。每个任务节点仍走同一policy、approval、sandbox、completion和event contract。
- Phase 20 的subagent没有父Agent权限继承特权；父Agent只能委派Host已允许的能力，并必须合并结构化事实而不是聊天摘要。
- Phase 21只允许显式启动的controller/worker service；它们可以常驻等待exact request/job，但不能自行发现仓库、生成Goal、扩Graph、选worker或重试unknown effect。后台/远程任务必须先有durable state、取消、预算、心跳、lease epoch、幂等与人工接管；lease/heartbeat不能证明远程旧worker已停止。

每增加一项，都应先回答：它解决了哪个已被真实观测的问题，成功指标是什么，它新增了哪条authority或failure boundary？

## 6. 开源组件引入时机

| 组件 | 最早阶段 | 引入目的 |
|---|---:|---|
| 供应商官方 SDK | Phase 1 | 通过官方类型与 mock transport 学习模型协议 |
| `zod` | Phase 2–3 | 校验事件、配置和工具参数 |
| `ripgrep` | Phase 3 | 成熟、快速的跨平台代码搜索 |
| Git CLI | Phase 5 | Patch 校验与真实 diff |
| `execa@9.6.1` | Phase 6 | 可取消、可流式的进程执行 |
| `@earendil-works/pi-ai`（repo `v0.80.7` baseline，实施时核对 npm 并精确 pin） | Phase 8 | 多 provider、reasoning、usage 归一化 |
| SQLite / Drizzle | Phase 9 后按需 | 会话查询和结构化持久化 |
| `@earendil-works/pi-tui`（同 repo baseline，实施时精确 pin） | Phase 11 | Coding-agent 专用终端交互 |
| `@modelcontextprotocol/sdk@1.29.0` v1 | Phase 12 | 标准化外部工具扩展 |
| Docker | Phase 13 | 基于 disposable snapshot 的操作系统级隔离 |
| `node-pty@1.1.0`（test-only） | Phase 16 | 在真实 PTY/Windows ConPTY 中验收 resize、Ctrl+C、二次 run 与终端恢复 |
| `typescript@6.0.3` Compiler API / Language Service | Phase 17，由model-free benchmark选择并精确pin | TS/JS增量符号、引用与结构化导航；不执行workspace plugin/command |
| Git worktree CLI | Phase 19 | task节点的文件隔离；仍由BornAgent记录lease、baseline和explicit promotion证据 |
| LiteLLM | Deferred；仅在未来出现真实团队网关需求时重新评估 | 不作为当前个人项目、单机Agent或maintenance路线的默认依赖 |

## 7. 当前状态与维护路线

Phase 0–15 已形成模型、AgentLoop、工具、权限、恢复、上下文、TUI、MCP、Docker、eval和runtime policy实现链；历史 evidence仍按各 Phase当时实际执行情况解释。

Phase 16 / M7 已于 2026-08-05 收口：durable Goal/Plan/Todo、trusted control plane、`update_plan`、Plan/Build runtime、跨 run completion、显式
model qualification、one-active-run coordinator、同 session 连续多 run/多 Goal、Plan 决策 UI、idle external refresh 和统一 OutcomeReport
均有本地零费用证据。最终 gate 包含完整 Plan -> approve -> Build A/B/C -> next Goal 流、真实 PTY resize/Ctrl+C/二次 run/父 shell 恢复、关键
durable crash prefix、真实 CLI/TUI writer 竞争，以及 Phase 0–15 全仓兼容回归。

Phase 17 / M8 已于2026-08-08收口：source snapshot、20-case legacy/candidate benchmark、nested rules、benchmark-selected
`typescript@6.0.3` semantic index、三个bounded navigation tools、freshness/refresh、CLI/TUI/replay/Outcome接入和完整M8 fixture均有本地证据。
semantic median observation bytes为legacy的`0.549618`，Phase17专项32文件/67测试与全仓173文件/899测试通过；其中4个既有skip不解释为pass。

Phase 18A已于2026-08-08收口：strict manifest/kind codecs、stable package inventory、builtin/user/workspace explicit source、exact enablement、
deterministic registry/qualified ID、run-frozen snapshot artifact、CLI diagnostics、resume/replay/Outcome与qualification identity均有本地证据。
18A专项7文件/25测试与全仓180文件/920测试通过；4个既有skip不解释为pass。tarball中的built-in index和`capabilities doctor --json`已验证。

Phase18 / M9与Phase19 / M10已于2026-08-10通过C0–C5 closure：command Hook durable supervisor/crash recovery、Plugin exact operation/lease
reconciliation、Graph/scheduler/worktree/promotion、bounded worker takeover、CLI/TUI/replay/Outcome均完成。Windows full gate为203文件/979测试通过、
5项已分类skip；Linux exact-commit CI为203文件/983测试通过、1项worker opt-in skip，随后built-worker 1/1与pack smoke单独实际执行通过。
仍不加入marketplace/network install、subagent、vector/RAG或remote worker；Phase19 background仅是exact Graph的有界本地ownership transfer。
Phase20 / M11已于2026-08-11收口：20A–20E的exact delegation/decision/authority attenuation、typed ContextCapsule、独立model/tool/capability/budget/workspace envelope、sealed Node child与start barrier、isolated session shard、Host-built receipt、max2 deterministic admission、CLI/TUI/replay/Outcome和packed foreground/background flow均已接通。proven pre-effect failure可在exact cleanup、zero-effect terminal和budget settlement后生成fresh attempt 2；start barrier后的IPC loss继续unknown-effect fail closed。exact candidate `6e1fe9481434c68fcb5611c33d19323df81ac3a8`的Linux与GitHub Windows full均为211文件/1008测试通过，default 11个built-path skip由Linux 9文件/14测试和Windows 8文件/13测试的required opt-in步骤实际解除；两平台pack smoke、ignored-cancel child+grandchild process-tree、two-child coordinator kill/takeover、active-child exit与Pages build/deploy/report均通过。packed flow由前台和独立Phase19 worker各启动两个offline child，共接纳四个verified receipts并证明barrier/claims与worker OS进程收口；精确run与失败修复历史记录在Phase20 implementation evidence。
真实远程provider、credential、Ollama、Docker和full model eval仍为`not_run_by_policy`，不能解释为remote/live quality pass。

Phase21 / M12 spec已于2026-08-12完成，21A于2026-08-13通过本地gate：Host-local principal/control identity、strict action/query registry、repository/session catalog、prepared-action/idempotency/operation journal、opaque session head/projection/delivery、seq0 materialization，以及Goal/Plan/Graph/Delegation/run/session/worktree/promotion的typed CLI/TUI路径均已接通；multi-process CAS、cross-store crash、legacy、zero-network、real PTY与installed tarball gate通过。精确计数和失败修复见[`Phase 21A Closure Evidence`](spec/12-m12-product-surfaces-remote/phase21a-closure-evidence.md)。当前候选仍需形成exact commit并通过对应CI；21B–21E已Deferred，M12不再是当前个人开源项目目标。后续不创建Phase22，转入[`Personal Open-Source Maintenance Roadmap`](spec/personal-open-source-maintenance-roadmap.md)定义的usage-driven维护路线。

2026-08-23 Architecture Simplification已本地实施到AS5.2：在AS0–AS5.1既有evidence、recovery、Host、session、product/TUI和terminal ownership基础上，TaskExecution现在复用已投影TaskGraph，V2 writer保留append-owned post-commit projection，scheduler每个mutation只做一次初始session reconstruction；Delegation child启动前与active阶段共享strict append-only tail cursor，idle轮询不再拿独占全量snapshot，一次cursor歧义可exact-prefix恢复，typed durable cancellation authority不变。当前manifest为105项（default 54、metric 38、built paths 12、pack 1）；AS5.2 metric 38/38及receipt回读通过，`pnpm check`为279文件/1277测试通过（8文件/16测试为既有opt-in skip），characterization v3 canonical SHA-256仍为`7e362f1a05856f504947e8e678bd202aa6578dc77550db7025061ad53e80db91`。AS0.1–AS5.2均为`local_gate_passed`，仍等待同一exact commit的Linux/Windows CI receipts；AS6保持`not_started`。
