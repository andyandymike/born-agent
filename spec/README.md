# BornAgent Implementation Specs

这里存放 BornAgent 的可执行实现合同。`ROADMAP.md` 负责阶段顺序和学习目标，`spec/` 负责把当前阶段约束成可以实现、测试和验收的行为。

> 当前有效后续路线：[`Personal Open-Source Maintenance Roadmap`](personal-open-source-maintenance-roadmap.md)。[`Agent Memory学习与交付路线`](../docs/agent-memory/learning-and-delivery-track.md)定义切片顺序、学习目标和预算，[`Lightweight Memory Core and Frontier Adapters Spec`](agent-memory-lightweight-core-and-adapters.md)定义当前exact行为与验收；21B–21E已Deferred，当前个人开源项目范围不再追求M12或Phase22。
>
> 当前状态：Memory v1 ML5已在exact commit `e329a4b4aad968870505e36ba0bfc1b4d7e00511`通过专用Linux/Windows focused contract与packed demo，core为`preview_usable`，production默认仍为`off`且production remote provider injection为0。CF2与EM-R1都保留disabled；旧EM-R1 holdout已由append-only correction降级为known exposed。FAL Memory Shared Benchmark v1已完成public development/calibration：embedding通过retrieval-stage gate，CF在12/12 timeline都未被收益规则选中；固定Qwen 2B reader四arm must-answer success为0，而独立DeepSeek Flash synthetic diagnostic恢复到development 14/16、calibration 15/18并观察到embedding effect `+0.050000`/`+0.066666`。DeepSeek calibration仍因一个unique abstention-semantics case在两条paired comparison形成2个security regressions而按冻结协议失败；evaluation 120 probes保持salted commitment、未运行。当前`sourceCommit=null`，结果不是promotion evidence。

## 当前阅读顺序

1. [`ROADMAP.md`](../ROADMAP.md)：理解整体学习路线和 Phase gate。
2. [`00-phase-0-foundation.md`](00-m0-model-client/00-phase-0-foundation.md)：项目地基。
3. [`01-phase-1-single-model-chat.md`](00-m0-model-client/01-phase-1-single-model-chat.md)：单次模型请求。
4. [`02-phase-2-streaming-session-events.md`](00-m0-model-client/02-phase-2-streaming-session-events.md)：流式事件与 session；M0 gate。
5. [`03-phase-3-read-only-tools.md`](01-m1-read-only-agent/03-phase-3-read-only-tools.md)：安全只读工具和固定一次工具往返。
6. [`04-phase-4-agent-loop.md`](01-m1-read-only-agent/04-phase-4-agent-loop.md)：真正的多 step AgentLoop；M1 gate（已完成）。
7. [`05-phase-5-controlled-file-edits.md`](02-m2-safe-coding-agent/05-phase-5-controlled-file-edits.md)：受控 patch 与一次性批准。
8. [`06-phase-6-command-execution-and-permissions.md`](02-m2-safe-coding-agent/06-phase-6-command-execution-and-permissions.md)：argv-only 命令、权限和进程生命周期。
9. [`07-phase-7-verification-and-completion.md`](02-m2-safe-coding-agent/07-phase-7-verification-and-completion.md)：验证、完成判定与 M2 gate。
10. [`08-phase-8-multi-provider-backend.md`](03-m3-recoverable-multi-model-agent/08-phase-8-multi-provider-backend.md)：pi-ai 与多 provider contract。
11. [`09-phase-9-resumable-sessions.md`](03-m3-recoverable-multi-model-agent/09-phase-9-resumable-sessions.md)：可恢复 session 与副作用对账。
12. [`10-phase-10-context-and-repository-rules.md`](03-m3-recoverable-multi-model-agent/10-phase-10-context-and-repository-rules.md)：上下文压缩、artifact 与根 AGENTS.md；M3 gate。
13. [`11-phase-11-interactive-tui.md`](04-m4-extensible-product/11-phase-11-interactive-tui.md)：事件驱动 TUI。
14. [`12-phase-12-mcp-stdio-tools.md`](04-m4-extensible-product/12-phase-12-mcp-stdio-tools.md)：stdio MCP tools。
15. [`13-phase-13-docker-sandbox.md`](04-m4-extensible-product/13-phase-13-docker-sandbox.md)：Docker snapshot sandbox；M4 gate。
16. [`14-phase-14-evals-and-reliability.md`](05-m5-reliability-engineering/14-phase-14-evals-and-reliability.md)：版本化 eval 与 M5 gate。
17. [`15-phase-15-configurable-runtime-policy.md`](06-m6-configurable-runtime-policy/15-phase-15-configurable-runtime-policy.md)：可配置 runtime policy、默认 local-free 与 M6 gate。
18. [`Phase 16 / M7 实施包`](07-m7-collaborative-single-agent/README.md)：持久 Goal/Plan/Todo、Plan/Build、连续 session 与 M7 gate。
    - [`Phase 16 总合同`](07-m7-collaborative-single-agent/16-phase-16-goal-plan-continuous-session.md)
    - [`16A — Durable Task-State Kernel`](07-m7-collaborative-single-agent/16a-durable-task-state-kernel.md)：已实现
    - [`16B — User Goal/Plan Control Plane`](07-m7-collaborative-single-agent/16b-user-goal-plan-control-plane.md)：已实现
    - [`16C — Agent Plan Tool and Recovery`](07-m7-collaborative-single-agent/16c-agent-plan-tool-and-recovery.md)：已实现
    - [`16D — Plan/Build Runtime and Completion`](07-m7-collaborative-single-agent/16d-plan-build-runtime-and-completion.md)：已实现
    - [`16E — Model Qualification`](07-m7-collaborative-single-agent/16e-model-qualification.md)：已实现
    - [`16F — Continuous TUI and M7 Gate`](07-m7-collaborative-single-agent/16f-continuous-tui-and-m7-gate.md)：已实现；M7 gate通过
19. [`Phase 17 / M8 实施包`](08-m8-repository-intelligence/README.md)：source snapshot、nested rules、symbol/reference index、结构化导航与M8 gate；已实现。
    - [`Phase 17 总合同`](08-m8-repository-intelligence/17-phase-17-repository-intelligence.md)：已实现；M8 gate通过
    - [`17A — Benchmark and Source Snapshot`](08-m8-repository-intelligence/17a-benchmark-and-source-snapshot.md)：已实现
    - [`17B — Nested Repository Rules`](08-m8-repository-intelligence/17b-nested-repository-rules.md)：已实现
    - [`17C — Derived Symbol/Reference Index`](08-m8-repository-intelligence/17c-derived-symbol-reference-index.md)：已实现
    - [`17D — Structured Navigation and Context`](08-m8-repository-intelligence/17d-structured-navigation-and-context.md)：已实现
    - [`17E — Freshness, Product Integration, and M8 Gate`](08-m8-repository-intelligence/17e-freshness-product-and-m8-gate.md)：已实现；M8 gate通过
20. [`Phase 18 / M9 实施包`](09-m9-capability-platform/README.md)：Skill、MCP resources/prompts、lifecycle Hooks与本地Plugin生命周期；已实现，M9 gate通过。
    - [`Phase 18 总合同`](09-m9-capability-platform/18-phase-18-capability-platform.md)：Implemented / M9 Passed
    - [`18A — Capability Manifest and Frozen Registry`](09-m9-capability-platform/18a-capability-manifest-and-frozen-registry.md)：已实现；18A gate通过
    - [`18B — Skills and Progressive Context`](09-m9-capability-platform/18b-skills-and-progressive-context.md)：已实现；18B gate通过
    - [`18C — MCP Resources and Prompts`](09-m9-capability-platform/18c-mcp-resources-and-prompts.md)：已实现；18C gate通过
    - [`18D — Lifecycle Hooks`](09-m9-capability-platform/18d-lifecycle-hooks.md)：已实现；command process/crash/PTY gate通过
    - [`18E — Plugin Lifecycle and M9 Gate`](09-m9-capability-platform/18e-plugin-lifecycle-and-m9-gate.md)：已实现；M9 gate通过
    - [`Phase 18 Implementation Evidence`](09-m9-capability-platform/phase18-implementation-evidence.md)：2026-08-08历史证据快照
21. [`Phase 19 / M10 实施包`](10-m10-durable-task-orchestration/README.md)：durable TaskGraph、deterministic scheduler、managed Git worktree、explicit promotion与bounded background worker；已实现，M10 gate通过。
    - [`Phase 19 总合同`](10-m10-durable-task-orchestration/19-phase-19-durable-task-orchestration.md)：Implemented / M10 Passed
    - [`19A — Durable Task Graph Kernel`](10-m10-durable-task-orchestration/19a-durable-task-graph-kernel.md)：Graph schema/hash/Goal+Plan binding/control plane
    - [`19B — Deterministic Scheduler, Budgets, and Cancellation`](10-m10-durable-task-orchestration/19b-deterministic-scheduler-budget-cancellation.md)：single-active attempt、budget/cancel/retry/recovery
    - [`19C — Git Worktree Isolation and Promotion`](10-m10-durable-task-orchestration/19c-git-worktree-isolation-and-promotion.md)：managed worktree、dirty baseline、promotion与safe cleanup
    - [`19D — Bounded Background Worker and Recovery`](10-m10-durable-task-orchestration/19d-bounded-background-worker-and-recovery.md)：sealed child、handshake、heartbeat、control与takeover
    - [`19E — Product Integration and M10 Gate`](10-m10-durable-task-orchestration/19e-product-integration-and-m10-gate.md)：CLI/TUI/replay/Outcome、real PTY/crash/pack与M10 gate
    - [`Phase 19 Closure Gate`](10-m10-durable-task-orchestration/phase19-closure-gate.md)：C0–C5已通过；未新增19F
    - [`Phase 19 Closure Evidence`](10-m10-durable-task-orchestration/phase19-closure-evidence.md)：最终commit、平台、命令、计数、skip与artifact证据
22. [`Phase 20 / M11 实施包`](11-m11-controlled-subagents/README.md)：controlled delegation、authority attenuation、minimal child context、独立budget/tool/model/workspace envelope、structured receipt与bounded parallelism；20A–20E已实现，M11 Passed。
    - [`Phase 20 总合同`](11-m11-controlled-subagents/20-phase-20-controlled-subagents.md)：Implemented / M11 Passed
    - [`20A — Delegation Contract and Authority Attenuation`](11-m11-controlled-subagents/20a-delegation-contract-and-authority-attenuation.md)：identity/hash/user decision/strict authority intersection
    - [`20B — Minimal Context and Child Envelope`](11-m11-controlled-subagents/20b-minimal-context-and-child-envelope.md)：typed capsule、tool/capability/model/budget/workspace envelope
    - [`20C — Child Runtime and Structured Receipts`](11-m11-controlled-subagents/20c-child-runtime-and-structured-receipts.md)：single real child、independent approval、Host-built receipt
    - [`20D — Bounded Parallelism, Cancellation, and Recovery`](11-m11-controlled-subagents/20d-bounded-parallelism-cancellation-and-recovery.md)：max2 deterministic actors、conflict admission、cancel/takeover
    - [`20E — Product Integration and M11 Gate`](11-m11-controlled-subagents/20e-product-integration-and-m11-gate.md)：CLI/TUI/replay/Outcome、real child/PTY/pack/cross-platform gate
23. [`Phase 21 / M12 设计包`](12-m12-product-surfaces-remote/README.md)：21A authenticated local control plane已通过；21B–21E Deferred，M12 Not Pursued in Current Scope。
    - [`Phase 21 总合同`](12-m12-product-surfaces-remote/21-phase-21-product-surfaces-and-remote.md)：M12 authority、failure semantics、canonical flow与完成定义
    - [`21A — Authenticated Local Control Plane`](12-m12-product-surfaces-remote/21a-authenticated-local-control-plane.md)：surface-neutral application service、principal/request identity、idempotency、session head/projection/delivery/recovery
    - [`Phase 21A Closure Evidence`](12-m12-product-surfaces-remote/phase21a-closure-evidence.md)：本地gate计数、crash/process/PTY/pack证据、失败修复与明确未实现边界
    - [`21B — IDE and Local Web Surfaces`](12-m12-product-surfaces-remote/21b-ide-and-local-web-surfaces.md)：loopback auth、self-contained Web、reference VS Code、multi-client/unsaved buffer
    - [`21C — Bounded Browser and Computer-Use Effects`](12-m12-product-surfaces-remote/21c-bounded-browser-and-computer-use-effects.md)：isolated frame/action/permit、human takeover、dispatch unknown-effect
    - [`21D — Remote Worker, Fencing, and Artifact Transport`](12-m12-product-surfaces-remote/21d-remote-worker-fencing-and-artifact-transport.md)：outbound enrollment、lease epoch、CAS transfer、quarantine/import
    - [`21E — Team Governance and M12 Gate`](12-m12-product-surfaces-remote/21e-team-governance-and-m12-gate.md)：principal/role/policy/separation/quota/audit与real M12 gate
24. Agent Memory learning-delivery lane：
    - [`Agent Memory学习与交付路线`](../docs/agent-memory/learning-and-delivery-track.md)：切片顺序、学习问题、预算与时间账
    - [`Lightweight Memory Core and Frontier Adapters Spec`](agent-memory-lightweight-core-and-adapters.md)：当前数据、端口、行为、实验晋级与机械验收合同
    - [`FAL-CF0 / CF2 — Context Folding Lite`](frontier-adapter-lab-fal0-context-folding-lite.md)：v1证据更正、CF2 retained lab implementation、trace-backed corpus合同与正交gates
    - [`Context Folding Lite 实验记录`](../docs/agent-memory/context-folding-lite-experiment-record.md)：v1历史删除边界与CF2 20-case mechanics结果、0-trace产品边界
    - [`FAL-EM0 / EM-R1 — Local Embedding + Selective Retrieval`](frontier-adapter-lab-fal-em0-local-embedding-hybrid.md)：v1 observation、data-adequacy audit、48/48 family-disjoint redesign与risk–coverage合同
    - [`Local Embedding Hybrid 实验记录`](../docs/agent-memory/local-embedding-hybrid-experiment-record.md)：FTS/E5历史结果、EM-R1 retained实现、data-contract修正、calibration曲线与根因边界
    - [`FAL Memory Shared Benchmark v1`](frontier-adapter-lab-shared-memory-benchmark-v1.md)：24×10共享时间线、2×2 retrieval/projection实验、分阶段指标与one-shot commit/reveal协议
    - `agent-memory-and-context-maintenance.md`：本地exhaustive research/threat-model参考；不作为当前排期或完成权威

Phase 0–20均已实现并有分阶段本地/跨平台证据，21A已通过本地gate。21B–21E已Deferred且M12不再是当前个人项目目标，因此Web、IDE、browser/computer-use、remote worker与team mode仍不可用。当前开发转为真实使用驱动的release、可靠性、简化、质量效率与开源维护。Phase18的Skills、MCP primitives、declarative/command Hooks和local Plugin lifecycle/reconciliation已通过M9；
Phase19的Graph/scheduler/worktree/promotion/background/product integration已通过M10；Phase20的authority-attenuated controlled delegation、sealed child、max2 scheduler、receipt、ConPTY/PTY、process-tree、pack与Pages gate已通过M11。没有加入marketplace、network install、nested Agent tree、daemon或remote worker。
Phase20 final candidate与精确GitHub run、平台计数、skip解除和失败修复历史见[`Phase 20 Implementation Evidence`](11-m11-controlled-subagents/phase20-implementation-evidence.md)。
历史未运行的真实Docker、Ollama、remote provider或full model eval证据仍为
`not_run_by_policy`，不得回写或夸大。

## 文档权威顺序

发生冲突时，按以下顺序处理：

1. 用户在当前任务中的明确要求。
2. `ROADMAP.md` 与当前 active learning/maintenance track 的路线、切片边界与退出方向。
3. 在该边界内，已批准且更新时间更晚的 Phase 或 active maintenance/slice implementation spec所定义的exact行为。
4. live code、tests、CLI evidence与exact-commit receipts所证明的当前事实状态。
5. 学习笔记和历史实现说明。

Phase或active slice spec可以细化roadmap，但不能把后续能力提前带入当前切片。若确实需要改变边界，应先同时更新roadmap、learning track和对应spec，再改代码。旧exhaustive research draft排在这些active文档之后。

## M0 的产品边界

Phase 0–2 合起来只交付一个“可流式调用单个模型并保存事件”的命令行客户端：

```text
CLI -> OpenAI Responses API -> text output
                         \-> BornAgent events -> JSONL
```

M0 明确不是 Agent，因为它没有工具、循环、仓库读取、文件修改或 Shell 执行能力。

## M1 的产品边界

Phase 3–4 合起来交付一个安全、只读、可停止的仓库问答 Agent：

```text
CLI -> AgentLoop -> Model turn -> read-only tool call
                  ^                    |
                  |---- observation ---|
                  \-> BornAgent events -> JSONL -> renderer
```

Phase 3 先实现工具协议和最多一次工具往返；Phase 4 再实现通用循环、step/budget 和重复调用保护。M1 仍不能修改文件、执行任意 Shell、访问工作区外目录、恢复 session 或切换到通用多 provider 层。

## M2 的产品边界

Phase 5–7 交付一个能修改、受控执行并根据证据完成的小型编码 Agent：

```text
patch proposal -> plan -> user approval -> host change journal
command argv -> permission/approval -> bounded local execution
latest verification + run-local diff + workspace digest -> CompletionPolicy
```

M2 的权限层不是 OS sandbox。`shell:false` 只阻止模型 argv 被宿主 shell 二次解析；获批 repository script 仍是通用代码执行边界。

## M3 的产品边界

Phase 8–10 固化 provider-neutral ModelBackend，用 pi-ai 接三个 provider；JSONL v2 允许同 session 的新 run 安全 resume；ContextPlanner
用本地事件、artifact 与根 `AGENTS.md` 做确定性压缩。旧批准永远不是新 run 的 authority，provider reasoning/checkpoint 保持 opaque。

## M4 的产品边界

Phase 11–13 增加只消费 durable events 的 TUI、stdio MCP tools 和 DockerExecutor。MCP discovery 不等于授权；Docker 命令只挂 disposable
workspace snapshot，默认 network none，且不把 provider/MCP secret 注入 container。

## M5 的产品边界

Phase 14 建立至少 20 个版本化 task、hidden grader、fresh attempt 和结构化报告。它区分 Agent completion 与 grader solution pass，
并把 reported usage、estimated cost、billed cost 与 null/zero 分开。

## M6 的产品边界

Phase 15 把 provider/cost/eval access 从散落的 hard-coded 业务分支迁移为版本化 runtime policy。产品唯一隐式默认仍是
`local-free-v1`；远程 profile 只能由受信用户配置定义并在每次 run 显式选择。安全不变量、secret 边界、sandbox mandatory
flags 与 no fallback/retry 不会被降级成普通布尔开关。Docker pull/build 默认只在 local-daemon + built-in locked artifact envelope
内开启；这不是任意 image/Dockerfile、registry credential、push 或 remote/cloud builder 权限。

## M7 的产品边界

Phase 16 把 Goal、带 revision 的 Plan/Todo 和每次 run 的 Plan/Build mode 变成可重建 session facts。Plan 模式在工具装配层机械只读；
用户批准绑定 exact goal revision + plan revision/hash，但不替代任何 patch/command/MCP approval。TUI 在 idle 收到消息时仍创建一个经过完整
resume/policy/effect gate 的新 run，因此用户可以自然连续协作而不需要普通流程手动 `/resume`，同时保持 one active run、无隐藏队列。
跨run Build change由event + artifact-backed GoalChangeLedger重建并seed existing CompletionPolicy，不能把前序run修改丢失或归入用户dirty baseline。
Model qualification 是显式、有界、可失效的协议证据，不是权限、质量保证或自动路由。M7 仍只有一个自有 AgentLoop，不包含 worktree 或 subagent。
具体实施必须依次通过16A事实内核、16B用户控制面、16C Agent计划工具、16D运行时/完成、16E模型资格和16F连续TUI/最终gate；
任一子阶段完成都不能单独把M7标为Implemented。

## M8 的产品边界

Phase17先用model-free hidden-gold benchmark量出现有`list_files/search/read_file`基线，再扩展nested `AGENTS.md`和由benchmark选择的
symbol/reference engine。workspace bytes、Git facts、run-frozen rule artifacts与durable JSONL observations仍是事实；index只是immutable、
incremental、可删除重建的本地派生cache。Plan/Build只增加`repository_outline`、`find_symbol`、`find_references`三个strict readonly工具，
所有path/range/snippet在返回前重新验证current source。semantic/syntactic/textual、complete/partial/unsupported与confirmed absence必须诚实区分。
Phase17不包含embedding/vector、后台daemon、Skills/Hooks、worktree或subagent；fake Agent integration只证明协议接入，不证明真实模型质量。

## M9 的产品边界

Phase18把Skill、MCP primitive、Hook与Plugin分成四层：Skill是渐进加载的知识/流程；MCP tools/resources是外部可调用能力或内容，Prompt只由用户显式选择；
Hook是Host固定生命周期中的deny/no-objection gate或observer；Plugin只是带来源、版本和digest的本地分发包。三种capability来源固定为`builtin`、
`user_install`、`workspace`，enabled只表示eligible，不授予任何effect权限。每个run在模型/能力使用前冻结exact`CapabilitySnapshot`，活动run不hot reload，
历史replay只依赖events/artifacts。Skill/MCP/Plugin内容永远不是system authority；Hook不能替policy或用户批准原动作。实施顺序固定为18A registry、18B Skills、
18C MCP resources/prompts、18D Hooks、18E local Plugin lifecycle/M9 gate。Phase18不包含marketplace/网络安装、advanced MCP transport/primitives、后台task graph、
worktree、subagent、vector/RAG或remote surface。

## M10 的产品边界

Phase19在Phase16 Goal/Plan之上增加一个独立但精确绑定的TaskGraph执行层。Graph revision/hash只能描述节点、依赖、workspace请求与预算；用户批准Graph只允许Host调度，
不批准任何patch、command、MCP、Hook、worktree allocation、promotion或cleanup effect。ready queue由session events确定性投影，同一repository v1仍最多一个model-driven
attempt；background只表示把一个exact Graph的ownership交给sealed、有界本地child，不表示并行Agent或常驻daemon。

write nodes必须在受管Git worktree执行。Host用`--no-checkout`创建detached worktree并从exact approved baseline materialize，避免repository filter/checkout code；origin dirty
bytes必须先形成用户批准的overlay。worktree结果只有经过content-addressed promotion bundle、fresh target preimage approval、existing GoalChangeLedger和origin最新验证后才能进入Goal completion。
worker的spawn/PID/heartbeat/exit都不是terminal事实；handshake、lease、operation journal、process-start identity和effect reconciliation共同决定resume/takeover。M10仍没有subagent、parallel
model loop、自动commit/push/PR、remote worker、IDE/Web/team面或network control；这些最早从Phase20/21另写spec。

## M11 的产品边界

Phase20把exact approved parent task变成authority-attenuated Delegation、Host-built minimal ContextCapsule/ChildEnvelope、独立child AgentLoop和Host-verified structured receipt。
Delegation approval只允许启动exact child envelope，不能继承parent approval、secret、credential、lease或workspace authority；child每个patch/command/MCP等effect仍独立批准。v1 depth固定1，
全组同时active model actors最多2，一个workspace lineage最多一个writer，mutation child只写managed worktree，promotion仍由M10串行拥有。child/parent crash、cancel和IPC loss沿用operation journal、
effect reconciliation与unknown-effect fail-closed；receipt narrative不替代artifact/verification。M11没有remote worker、IDE/Web、browser/computer-use、team principal、长期自治daemon或自动Git publish。

## M12 的产品边界（21A Passed / 21B–21E Deferred / M12 Not Pursued）

Phase21先抽surface-neutral Application Control Plane并让CLI/TUI成为同一typed service的adapter；随后才开放loopback-only local Web和reference VS Code。Product Web与Agent控制的browser是
不同安全域：external page/frame永远是不受信content，每个browser/computer-use input绑定fresh frame、one-use permit与dispatch journal，失联后不blind retry。Remote执行单元只是一条sealed Phase20
child attempt；controller保留session writer、Graph scheduler、approval与parent merge，worker无origin/secret/browser/nested/publish authority。lease/heartbeat不是远程fence，无法由controller证明已停止的effect在partition后只能进入
`blocked_unknown_effect`。Team role/policy/quota只可收窄eligibility，不能替exact effect approval；unknown quota保持held，audit integrity失败使team/remote mutation fail closed。21A已通过local control plane gate；21B–21E只保留为设计参考，未实施也不构成当前排期。除非未来重新立项并重新验证全部real Web/editor/browser/desktop/two-host remote/cross-platform/pack gates，否则M12不得标Implemented。

## 默认零费用与显式远程 policy

Phase 0–14 的实现与证据继续按当时不可覆盖的 `local_free_only` 合同解释，不回写历史。Phase 15 开始：

- 无 config/profile flag 时固定使用随 package 发布的 `local-free-v1`：fake/mock 或 literal-loopback Ollama，credential access、proxy、
  redirect、fallback 和自动 model pull 均关闭；Docker 只允许对随 package 发布的 exact artifact 做公共匿名 digest pull 或受信本地 build。
- Docker capability enabled 不代表启动即下载：只有 DockerExecutor需要缺失 built-in artifact，或用户运行 `born docker prepare`，才可执行
  lock 中的 preferred source；普通启动、LocalExecutor 和 policy commands均无 acquisition side effect。
- user config 可以定义 `remote_explicit` profile，但不能把它设为默认，也不能由 environment、repository、prompt、模型或 MCP 隐式选择；
  每次 run 必须显式给完整 profile ID + exact provider/model。
- policy 必须在 credential resolver、backend/request 和 socket 前完成；local-free 下真实/哨兵 API key 都不得读取。
- Phase 15 的实现、自动化和手工验收仍不得调用真实远程 provider、读取真实 key 或执行 checked-in full eval；远程 adapter 只做
  production mapper + fake transport contract evidence。
- OpenAI/Anthropic 可以达到 `contract_verified`，但没有 live 请求就不得写 `live_verified`；本地 Ollama 可写
  `local_live_verified`。未执行的证据写 `not_run_by_policy`，不能伪装成通过。
- full suite access 迁入 policy data，但 schema v1 只允许显式 local-free profile 授权 full；remote + full 非法。Phase 15 gate 只用
  synthetic miniature suite 测 branch，不运行 checked-in 20-task full。

详细 authority、schema、迁移和验收见 Phase 15 spec。配置化表示“policy-as-data”，不表示所有安全 invariant 都可关闭。

## 跨 Phase 不变量

- 包名暂定 `bornagent`，用户命令固定为 `born`。
- 运行时为 Node.js 22 或更高版本，代码使用 TypeScript ESM。
- application/domain业务代码不得直接接触`process`；只有CLI bootstrap、`src/cli/node-runtime.ts`与显式process/OS adapters可读取Host facts，并通过narrow typed ports注入。业务代码返回退出码，不调用`process.exit()`。
- stdout 只承载成功结果；诊断、usage、错误、approval prompt、diff preview 和 debug 信息写入 stderr。TUI 使用自己的受控 surface，
  但不能改变核心 stdout/stderr contract。
- 产品代码中的 API key 只从进程环境读取，不写入配置、日志、事件、错误文本或测试快照；当前测试/验收不得读取真实 key。
- 默认不把 Responses 对象保存在供应商侧，OpenAI 请求显式使用 `store: false`。
- 所有时间、环境、模型客户端、命令执行和输出流都应可注入，以支持无网络测试。
- 依赖使用精确版本并提交 lockfile；不使用 `latest` 范围。
- 不以单元测试替代 CLI/fixture 演示。每个 Phase 的学习记录必须包含实际零费用命令、退出码、关键输出和 evidence status；
  fake/mock 证据不得写成 remote live 证据。
- session schema 的兼容目标是新 reader 能读取旧 session；新增 event/provider ID 不承诺旧 reader forward-compatible。正式 decoder/upcast
  framework 在 Phase 9 引入，旧 bytes 除合法尾行恢复外不重写。

## 代码注释与学习政策

Phase 4–21 每个新核心边界都必须有少量、可维护的 `// PHASEx:` 注释。注释解释 **why / invariant / trust boundary / fail-closed
reason**，不逐行翻译语法。每个 Phase spec 列出必写位置；完成前用 `rg -n "PHASEx:" ...` 人工核对，并在学习笔记中用自己的话
复述关键注释。

禁止把以下内容当“注释”：commented-out code、fixture 答案、secret、raw reasoning、临时调试输出、易过期价格/命令结果，或没有 owner/
删除条件的 TODO。自动化测试验证行为，不以注释数量作为 gate。

## 统一退出码

| 退出码 | 含义 |
|---:|---|
| `0` | 成功 |
| `1` | 未分类的内部错误或数据不变量被破坏 |
| `2` | CLI 参数或用户配置无效 |
| `3` | `doctor` 检测到必需环境依赖缺失 |
| `4` | 凭据缺失或认证失败 |
| `5` | Provider、网络、限流、配额或服务端请求失败 |
| `6` | 请求超时 |
| `7` | Agent 因 step、时间、token、工具输出或重复调用预算停止 |
| `8` | 任务 incomplete/blocked、最新验证不足或 completion evidence 不一致 |
| `9` | eval/compare 正常完成，但存在 valid task failure、安全失败或预设 regression |
| `130` | 用户通过 Ctrl+C 取消 |

业务代码返回这些数值；最外层入口仅设置 `process.exitCode`。未捕获异常必须被最外层错误边界转换为退出码 `1`，并输出经过脱敏的单行错误。

## 学习记录最低结构

每阶段完成时创建 `docs/learning/phase-XX-*.md`，至少包含：

1. 我能用自己的话解释什么。
2. 本阶段真实实现了什么，没有实现什么。
3. 实际执行的命令、退出码和关键输出。
4. 自动化测试覆盖什么，没覆盖什么。
5. 一个真实演示及其结果。
6. 本阶段做出的设计决定。
7. 仍不理解或准备在后续验证的问题。
8. 本阶段选择的 `// PHASEx:` 注释及其保护的 invariant/失败窗口。

## 外部资料基线

以下外部资料在 2026-07-16 核对过。进入对应 Phase 时，如果时间已过去较久、npm/SDK 类型或上游状态不一致，必须重新核对并精确 pin：

- [Responses API](https://developers.openai.com/api/docs/guides/responses)
- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [Error codes](https://developers.openai.com/api/docs/guides/error-codes)
- [Models](https://developers.openai.com/api/docs/models)
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Responses API 与 Agents SDK 的选择](https://developers.openai.com/api/docs/guides/agents#compare-the-responses-api-and-agents-sdk)
- [earendil-works/pi `v0.80.7`](https://github.com/earendil-works/pi/tree/v0.80.7)：Phase 8/11 上游 repo baseline；实施时重新核对 npm 的 `@earendil-works/pi-ai` / `@earendil-works/pi-tui` 精确版本。
- [Execa `v9.6.1`](https://github.com/sindresorhus/execa/releases/tag/v9.6.1)：Phase 6 process/cancellation baseline。
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 与 [v1 API docs](https://ts.sdk.modelcontextprotocol.io/)：Phase 12 固定 `@modelcontextprotocol/sdk@1.29.0`；v2 当前为 pre-alpha。
- [Docker none network](https://docs.docker.com/engine/network/drivers/none/) 与 [container resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)：Phase 13 network/resource baseline。
- [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/)、[daemon remote access](https://docs.docker.com/engine/security/protect-access/) 与 [Docker Hub pull usage](https://docs.docker.com/docker-hub/usage/pulls/)：Phase 15 local-daemon guard、anonymous public pull 与 rate-limit boundary。

Phase 3 核对到的关键约束：function tool 使用 JSON Schema 和 `call_id`；工具结果以 `function_call_output` 返回；strict object schema关闭
额外字段；reasoning model 的工具后续请求必须保留前一响应的 reasoning output items。Phase 8 以后即使改用 pi-ai，仍以 BornAgent contract
tests 验证这些事实，不把 raw provider type 传播到 core。
