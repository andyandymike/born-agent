# ML4 — Explicit lifecycle and operability

> Local status: `local_product_verified` on Windows, 2026-08-26
> Release status: covered by ML5 `preview_usable` exact commit `e329a4b4aad968870505e36ba0bfc1b4d7e00511`
> Scope: local single-user, exact repository, explicit mutation only

## 我想理解的问题

1. 长期记忆“改变”时，怎样保留历史而不原地覆盖事实？
2. retract怎样立即影响检索，又不虚假承诺secure erase？
3. canonical record已满时，怎样保证用户仍能撤回？
4. 旧episode-only SQLite怎样迁移而不改变既有ID、hash和source证据？
5. 哪些derived状态可安全删除，怎样证明重建没有改变logical truth？

## 现有源码调用链

ML4沿用真实产品路径，没有建立新的mutation framework：

```text
run-cli.ts
  -> commands/memory.ts
  -> existing Host repository registry resolves exact principal/repository/root
  -> MemoryService
  -> SqliteEpisodeStore schema-2 revision + operation transaction
  -> Fts5EpisodeProjection invalidation/rebuild

Agent local request
  -> LexicalMemorySearchService reads active logical dump
  -> FTS candidate binds record_id + revision_id
  -> canonical active head/hash/scope/source refetch
  -> AutomaticMemoryRecallService
  -> historical_only ContextItem
```

当前只有CLI这一位同步本地writer，因此没有把memory接入Phase21 ApplicationService、action registry或session journal。TUI、daemon或remote writer出现前，这些层只会增加学习负担，没有第二位真实consumer。

## 最小设计与为什么

### Formal `MemoryRecordV1`

`MemoryRecordV1`是strict union：

- 旧`Ml1EpisodeRecordV1`保持canonical bytes完全不变；
- explicit record只增加首版真实需要的`fact|preference|decision|constraint`；
- logical `memory_<sha256>` ID跨revision稳定；
- 每个revision有独立`revision_<sha256>`与record hash；
- `local_user_command` source记录Host command ID、时间和superseded revision。

没有procedure、embedding、graph、reflection或通用metadata bag。它们仍属于后续实验，不进入canonical core。

### Append-only lifecycle

schema 2持久化`memory_records`与`memory_operations`。每次显式变化都是：

- `ADD`：新logical record revision 1；
- `SUPERSEDE`：同record ID的新revision，target必须是active explicit同kind revision；
- `RETRACT`：不创建revision，只把active head变为不可检索。

store在logical dump时重放并核对整个scope的operation linkage；unreferenced revision、错误target或SQL active head漂移都fail closed。重复retract直接返回现有operation，不继续增长。

### Capacity reserve

canonical revisions最多10,000 rows / 64 MiB。每个revision恰好对应一条`ADD/SUPERSEDE`，operation上限固定为20,000 rows / 64 MiB；因此revision cap已满时，仍有足够slot让每个logical record执行一次retract。retract不检查revision cap，但仍受独立operation hard bound。

### Derived projection

FTS升级为scope-bound `fts5-v2`，candidate绑定record与revision identity。remember/supersede/retract后立即删除当前scope projection；即使cleanup尚未发生，下一次search也会因logical hash变化强制重建，旧revision不会成为product hit。`rebuild`删除derived数据后比较前后canonical logical hash；`doctor`以read-only SQLite/FTS检查报告missing、stale或corrupt，不修改canonical state。

## 实际 CLI 演示

```powershell
corepack pnpm dev memory remember preference "Use focused checks first" --json
corepack pnpm dev memory remember preference "Use focused then full checks" --supersedes <record-id> --json
corepack pnpm dev memory search "focused" --explain --json
corepack pnpm dev memory doctor --json
corepack pnpm dev memory rebuild --json
corepack pnpm dev memory retract <record-id> --json
corepack pnpm dev memory show <record-id> --json
```

tracked fixture `fixtures/agent-memory/ml4/lifecycle.json`通过真实CLI证明：

- ADD后revision 1可搜；
- SUPERSEDE后旧unique term为0，新revision唯一可见；
- RETRACT后相同query为0，`show`仍明确标记`retracted`；
- secret command退出2，只返回typed code，canonical/FTS secret row均为0；
- 删除整个`memory/v1/retrieval`后，rebuild前后logical hash相同且新revision search恢复。

## 测试与证据

- `tests/evidence/agent-memory-ml4-v1.json`冻结7项blocking cases；
- 全部`agent-memory`：16 files / 54 tests通过；
- lint与typecheck通过；
- full repository gate通过：non-PTY 288 files / 1,323 tests通过，6 files / 12 tests按平台预期跳过；PTY 5 suites通过、2 suites按平台预期跳过；clean build通过；
- final extracted tarball smoke通过，真实执行ML1 close/reopen、ML2 search、ML3 bounded context，以及ML4 remember/supersede/secret/doctor/rebuild/retract；
- `311c3cc`的GitHub `quality`与`windows-phase20` jobs已通过，但它只包含ML1–ML3，不能冒充当前ML4 exact-commit证据。

## 失败、修复与未解决问题

1. 首次focused命令把`--`作为Vitest字面参数，意外启动了更宽测试集合；终止后改为准确文件过滤。它不是产品失败，也没有修改测试结论。
2. 初版read-only doctor复用了FTS5 `INSERT ... integrity-check`控制命令，在read-only connection上被正确拒绝；修复为`PRAGMA quick_check + strict schema/metadata/logical hash`只读验证，写式FTS integrity-check只留在search/rebuild路径。
3. schema版本从1升2后，旧测试仍把metadata值2当“future”；测试改为3，并保留数据库不被覆盖的原断言。
4. `retract`不是secure erase：旧revision、source session和artifact继续存在，只从active recall移除。
5. explicit mutation的response-loss跨进程幂等协议、old/new mixed writer、加密、sync和global memory仍明确不做；真实第二writer出现后再研究。

## 我现在如何解释这个概念

长期记忆不是一个不断覆盖的字符串仓库。canonical memory保存“发生过哪些不可变revision和operation”；active state是对operation ledger的确定性解释；FTS只是随时可扔的索引。这样“更新”保留过去，“撤回”停止未来使用，“重建”不改事实，“容量满”也不夺走用户撤回权。

## 工程时间账

原spec的人类预算为8–16h；根据ML2/ML3实测，本阶段开始前校准Agent预算为2–5h。实际wall-clock为2026-08-26 12:39–14:12 JST，约1小时33分，低于校准区间下界。差异来自schema迁移、retrieval/recall identity和CLI边界能直接复用ML1–ML3骨架；约半小时还用于第一轮完整门禁输出丢失后的可审计重跑。wall-clock包含命令等待，不等于连续人工编码时间；分类时间是近似值。

| Category | Estimated | Actual window | Notes |
|---|---:|---:|---|
| contract/live audit | 0.3–0.7h | ~0.1h | 冻结schema、operation reserve与direct-service边界 |
| feature implementation | 0.8–2.0h | ~0.45h | record/operation/store/service/CLI/retrieval/recall |
| tests/evidence | 0.5–1.2h | ~0.25h | migration/lifecycle/cap/secret/rebuild/recall/CLI |
| CI/debug | 0.2–0.7h | ~0.5h | read-only FTS doctor修复、两次full gate、final pack smoke |
| learning/docs | 0.2–0.5h | ~0.2h | spec、README、track、record |

## 下一步

ML5已完成cross-platform product closure；专用Linux/Windows jobs在同一exact commit执行focused contract、pack smoke和完整新进程唯一发布演示。后续frontier adapter仍以单张isolated experiment card推进，不把embedding、graph、automatic chat extraction或企业治理倒灌进Memory v1 core。
