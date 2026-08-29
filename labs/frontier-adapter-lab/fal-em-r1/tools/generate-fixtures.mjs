import { createHash } from "node:crypto";

const SPLITS = ["calibration", "evaluation"];
const CREATED_AT = "2026-08-29T00:00:00.000Z";
const EXPERIMENT_ID = "fal-em-r1-selective-hybrid-v2";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value) {
  return sha256(canonical(value));
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const semanticDefinitions = {
  calibration: [
    ["offline-bundle", "怎样确认安装包断网也能运行", "Self-contained release bundle", "The distributable carries every runtime dependency and completes its smoke check without contacting any remote service."],
    ["approval-recovery", "误点拒绝之后如何恢复那次操作", "Approval recovery procedure", "A denied command can be requested again with a fresh authorization; the previous denial never grants lasting permission."],
    ["cache-refresh", "源码变了但索引结果没更新怎么办", "Repository index invalidation", "When tracked content changes, discard the old generation and publish a freshly built repository snapshot before serving reads."],
    ["source-revalidation", "记忆命中了也要重新确认原始出处吗", "Use-time provenance verification", "A recalled item is advisory until its canonical source is fetched again and confirmed available at the moment of use."],
    ["unstable-test", "偶尔红一次的自动化检查该怎么处理", "Intermittent verification diagnosis", "Reproduce the nondeterministic check repeatedly, isolate shared state, and never label a flaky run as a deterministic product failure."],
    ["feature-disable", "上线后怎样一键退回原来的检索逻辑", "Retrieval feature rollback", "Keep the semantic branch behind a disabled-by-default switch so operators can return immediately to lexical lookup."],
    ["release-archive", "Where is the final build kept for offline delivery?", "离线发布归档", "最终可分发构建保存在本地发布归档中，并且附带完整性校验值。"],
    ["decision-recall", "What did we previously decide about retaining personal preferences?", "个人偏好记忆决定", "先前决定仅保存用户明确要求记住的偏好，并允许用户查看和撤回。"],
    ["socket-reconnect", "长连接掉线后如何继续接收事件", "Event stream continuation", "After transport loss, reconnect with the last acknowledged cursor and request only events that follow it."],
    ["recoverable-cleanup", "清理大文件时怎样避免无法找回", "Recoverable storage cleanup", "Measure the exact targets first and move removable artifacts to a recoverable location before permanent deletion."],
    ["schema-upgrade", "旧数据格式升级时怎样保证中途崩溃可恢复", "Crash-safe schema evolution", "Write the migrated state beside the old state, validate it fully, then switch the pointer atomically while retaining rollback metadata."],
    ["schedule-zone", "定时任务跨地区运行应该保存什么时间", "Schedule timezone identity", "Persist the named timezone and local wall-clock intent, then derive each execution instant with daylight-saving rules."],
    ["audit-trail", "How can I reconstruct why a tool action happened?", "工具调用审计链", "每次工具动作都绑定触发消息、授权决定、参数摘要和不可变结果标识。"],
    ["editor-restart", "编辑器重启后如何找回未完成步骤", "Workspace continuation marker", "Persist the last durable plan revision and reopen from that marker instead of replaying completed effects."],
    ["lock-resolution", "依赖版本冲突时以什么作为可复现依据", "Dependency resolution identity", "Treat the exact lockfile plus package-manager version and artifact hashes as the reproducible dependency identity."],
    ["resume-checkpoint", "进程退出后怎样从安全位置继续任务", "Execution recovery checkpoint", "Resume from the last committed effect boundary and revalidate external state before performing the next mutation."],
  ],
  evaluation: [
    ["portable-package", "如何证明交付物不依赖在线下载", "Portable delivery artifact", "The shipped archive contains its complete execution payload and passes a network-isolated launch probe."],
    ["command-consent", "取消过的命令以后想运行该怎么办", "Command consent renewal", "Request a new explicit confirmation for the new attempt; a cancelled prompt conveys no authority to later runs."],
    ["index-rebuild", "仓库内容更新后搜索仍显示旧答案怎么修", "Search snapshot replacement", "Build a new index generation from the changed source and atomically publish it only after integrity checks succeed."],
    ["origin-check", "召回结果能不能直接当成最新事实", "Origin freshness check", "Before relying on remembered material, load the authoritative origin again and reject it if scope, revision, or availability changed."],
    ["sporadic-ci", "流水线不是每次都失败该如何判断", "Sporadic CI investigation", "Run the suspect path under repeated controlled conditions and separate timing contamination from a stable regression."],
    ["rollout-switch", "新召回方案出问题时怎样立即撤回", "Semantic rollout kill switch", "A runtime switch leaves the established keyword retriever intact and disables the experimental semantic path without migration."],
    ["artifact-digest", "Where can a disconnected customer verify the shipped package?", "离线交付校验", "客户可在随包提供的本地清单中核对构建摘要，无需访问外部服务。"],
    ["preference-policy", "Which user details are allowed to persist between sessions?", "跨会话偏好规则", "只有用户主动声明需要保留的信息才能跨会话保存，并提供删除入口。"],
    ["stream-resume", "事件订阅断开后怎样避免重复处理", "Subscription resume cursor", "Reconnect using the highest durably processed sequence and make downstream effects idempotent."],
    ["safe-space", "释放磁盘空间前怎样保证可以反悔", "Reversible disk reclamation", "Inventory exact paths and sizes, then quarantine selected artifacts before any irreversible removal."],
    ["database-transition", "数据库升级如何避免半新半旧状态", "Atomic database transition", "Construct and validate the replacement database separately, then perform one atomic cutover with the prior image retained."],
    ["regional-clock", "跨时区提醒怎样避免夏令时偏移", "Regional clock semantics", "Store the IANA zone and intended civil time rather than a one-time numeric UTC offset."],
    ["incident-history", "How do we prove which approval led to a side effect?", "副作用事件链", "将用户确认、规范化参数、执行标识和最终状态串成可验证的事件序列。"],
    ["terminal-return", "终端意外关闭后怎样恢复当前工作", "Durable terminal handoff", "Reload the latest persisted task state and compare live effects before continuing from the next pending step."],
    ["package-pin", "怎样确保另一台机器安装出同样依赖", "Package graph pinning", "Pin the resolver version and lock graph, then verify downloaded package bytes against recorded digests."],
    ["continuation-token", "后台任务重启后从哪里接着执行", "Durable continuation token", "Continue after the most recent acknowledged effect and reconcile any uncertain operation before issuing another."],
  ],
};

const controlDefinitions = {
  calibration: {
    exact: [
      ["exact-amber", "Calibration exact amber record", "Exact identity lookup for the amber calibration ledger."],
      ["exact-cobalt", "Calibration exact cobalt record", "Exact identity lookup for the cobalt calibration ledger."],
    ],
    phrase: [
      ["phrase-orchid", "Calibration phrase orchid", "The frozen phrase is copper orchid rendezvous and it appears exactly once."],
      ["phrase-sparrow", "Calibration phrase sparrow", "The frozen phrase is silent sparrow checksum and it appears exactly once."],
    ],
    temporal: [
      ["temporal-region", "nebula-region", "Deployment region used nebula-west.", "Deployment region now uses nebula-east.", { region: "nebula-east" }],
      ["temporal-command", "lattice-command", "Verification command used lattice-old.", "Verification command now uses lattice-new.", { command: "lattice-new" }],
      ["temporal-channel", "harbor-channel", "Release channel used harbor-blue.", "Release channel now uses harbor-green.", { channel: "harbor-green" }],
      ["temporal-policy", "quartz-policy", "Cache policy used quartz-daily.", "Cache policy now uses quartz-hourly.", { cadence: "quartz-hourly" }],
    ],
  },
  evaluation: {
    exact: [
      ["exact-violet", "Evaluation exact violet record", "Exact identity lookup for the violet evaluation ledger."],
      ["exact-sienna", "Evaluation exact sienna record", "Exact identity lookup for the sienna evaluation ledger."],
    ],
    phrase: [
      ["phrase-maple", "Evaluation phrase maple", "The held-out phrase is glass maple waypoint and it appears exactly once."],
      ["phrase-finch", "Evaluation phrase finch", "The held-out phrase is patient finch signature and it appears exactly once."],
    ],
    temporal: [
      ["temporal-zone", "aurora-zone", "Service zone used aurora-north.", "Service zone now uses aurora-south.", { zone: "aurora-south" }],
      ["temporal-probe", "marble-probe", "Health probe used marble-v1.", "Health probe now uses marble-v2.", { probe: "marble-v2" }],
      ["temporal-lane", "willow-lane", "Delivery lane used willow-slow.", "Delivery lane now uses willow-fast.", { lane: "willow-fast" }],
      ["temporal-window", "ember-window", "Refresh window used ember-nightly.", "Refresh window now uses ember-quarterly.", { window: "ember-quarterly" }],
    ],
  },
};

const negativeDefinitions = {
  calibration: {
    far_unrelated: [
      ["far-lunar-cooking", "玄武岩重力下的月球酸面团要发酵多久"],
      ["far-coral-biology", "哪种珊瑚会在极地冰层下面歌唱"],
      ["far-violin-weather", "小提琴漆色能否预测季风冰雹"],
      ["far-orbit-gardening", "彗星温室里的番茄应该使用什么肥料"],
    ],
    lexical_collision: [
      ["lexical-orchard-release", "orchard release", "Calibration orchard release roster", "The orchard release names a seasonal fruit shipment, not a software delivery decision."],
      ["lexical-cursor-approval", "cursor approval", "Calibration cursor approval form", "The cursor approval concerns a museum exhibit pointer, not command authorization."],
      ["lexical-memory-violet", "memory violet", "Calibration memory violet catalog", "The memory violet catalog describes a paint pigment, not retained agent knowledge."],
      ["lexical-cache-river", "cache river", "Calibration cache river map", "The cache river is a geographic label and supplies no repository caching guidance."],
    ],
    semantic_near_miss: [
      ["near-region", "当前正式部署使用的是哪个区域", "Calibration neighboring deployment", "A different service currently deploys to granite-south."],
      ["near-timeout", "构建流程批准的超时时间是多少", "Calibration neighboring timeout", "An unrelated preview job uses a ninety-second timeout."],
      ["near-backup", "生产备份应该保存到什么位置", "Calibration neighboring backup", "A tutorial sample stores disposable copies in a temporary folder."],
      ["near-branch", "哪个分支已经获准用于正式发布", "Calibration neighboring branch", "A documentation example mentions the branch named sketch-only."],
    ],
    boilerplate_collision: [
      ["boiler-source", "source record instruction", "Calibration source record instruction template", "This generic source record instruction template contains labels but no answer to a concrete task."],
      ["boiler-repository", "repository decision outcome", "Calibration repository decision outcome template", "This repository decision outcome boilerplate is an empty reporting shell."],
      ["boiler-session", "session task completion", "Calibration session task completion template", "This session task completion phrase belongs to a blank checklist with no factual support."],
      ["boiler-memory", "memory retrieval result", "Calibration memory retrieval result template", "This memory retrieval result sample documents field names only and contains no remembered fact."],
    ],
  },
  evaluation: {
    far_unrelated: [
      ["far-desert-whale", "沙漠鲸鱼为什么穿越水晶沙丘迁徙"],
      ["far-teapot-astronomy", "哪个茶壶星座会在日出之前沸腾"],
      ["far-moss-engine", "苔藓能否驱动青铜机车跨越海洋"],
      ["far-cloud-pottery", "雷声怎样烧制到云朵陶器表面"],
    ],
    lexical_collision: [
      ["lexical-meadow-package", "meadow package", "Evaluation meadow package registry", "The meadow package lists wildflower seeds and says nothing about application artifacts."],
      ["lexical-token-consent", "token consent", "Evaluation token consent exhibit", "The token consent is a gallery admission voucher, not authority for a command."],
      ["lexical-history-indigo", "history indigo", "Evaluation history indigo archive", "The history indigo archive covers textile dye, not persistent agent context."],
      ["lexical-index-canyon", "index canyon", "Evaluation index canyon atlas", "The index canyon is a hiking location and provides no search refresh procedure."],
    ],
    semantic_near_miss: [
      ["near-zone", "线上应用当前由哪个服务区承载", "Evaluation adjacent service zone", "A sandbox demonstration runs in copper-central."],
      ["near-retry", "发布动作批准的重试次数是多少", "Evaluation adjacent retry note", "A classroom exercise retries a mock upload seven times."],
      ["near-archive", "客户归档最终保留在什么地方", "Evaluation adjacent archive note", "A disposable benchmark writes scratch archives under a temporary directory."],
      ["near-tag", "哪个标签已经允许进入部署流程", "Evaluation adjacent tag note", "A sample tutorial references the tag draft-example."],
    ],
    boilerplate_collision: [
      ["boiler-origin", "origin revision action", "Evaluation origin revision action template", "This origin revision action form contains headings only and supports no actual decision."],
      ["boiler-project", "project verification report", "Evaluation project verification report template", "This project verification report is a blank example without observed evidence."],
      ["boiler-run", "run step finished", "Evaluation run step finished template", "This run step finished phrase is merely a placeholder status string."],
      ["boiler-recall", "recall search response", "Evaluation recall search response template", "This recall search response specimen lists schema labels and no usable memory."],
    ],
  },
};

const filteredDefinitions = {
  calibration: [
    ["wrong-repository", "黑曜石部署密钥保存在哪里", "Obsidian deployment secret", "The obsidian deployment secret is stored in foreign vault cal-77."],
    ["wrong-principal", "私有雪松偏好具体是什么", "Private cedar preference", "The private cedar preference belongs to another principal and says cedar-spiral."],
    ["stale-source", "蛇怪服务当前使用哪个端点", "Stale basilisk endpoint", "The basilisk endpoint was stale-cal.example.invalid."],
    ["tampered-source", "黄玉构建由什么校验值保护", "Tampered topaz checksum", "The topaz build checksum claims tampered-cal-991."],
    ["unavailable-source", "消失的笔记批准了哪个鹤形令牌", "Unavailable crane token", "The vanished note approved crane-cal-44."],
    ["retracted", "冰川功能应该启用哪个开关", "Retracted glacier flag", "The retracted decision enabled glacier-cal-on."],
    ["superseded", "旧泻湖策略是否仍然采用十二小时", "Superseded lagoon policy", "The obsolete lagoon policy used twelve hours."],
    ["no-current-revision", "被移除的杜松指令要求执行什么", "Removed juniper instruction", "The removed juniper instruction required juniper-cal-force."],
  ],
  evaluation: [
    ["wrong-repository", "缟玛瑙发布凭据保存在什么地方", "Onyx release credential", "The onyx release credential is kept in unrelated vault eval-31."],
    ["wrong-principal", "私有万寿菊设置的值是什么", "Private marigold setting", "The private marigold setting belongs to a separate principal and says marigold-wave."],
    ["stale-source", "狮鹫服务当前使用哪一个网关", "Stale gryphon gateway", "The gryphon gateway was stale-eval.example.invalid."],
    ["tampered-source", "白银构建应该用哪个摘要验证", "Tampered silver digest", "The silver build digest claims tampered-eval-552."],
    ["unavailable-source", "缺失笔记允许了哪个苍鹭密钥", "Unavailable heron key", "The missing note allowed heron-eval-29."],
    ["retracted", "苔原功能现在应该打开哪个开关", "Retracted tundra switch", "The withdrawn decision enabled tundra-eval-on."],
    ["superseded", "旧三角洲策略是否仍采用九小时", "Superseded delta policy", "The obsolete delta policy used nine hours."],
    ["no-current-revision", "已删除的杨树指令要求什么动作", "Deleted poplar instruction", "The deleted poplar instruction demanded poplar-eval-force."],
  ],
};

function timeFor(split, index) {
  const day = split === "calibration" ? 10 : 20;
  return `2026-08-${String(day + Math.floor(index / 24)).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00.000Z`;
}

function row(split, index, input) {
  return {
    key: `${split.slice(0, 3)}-${input.key}`,
    title: input.title,
    text: input.text,
    occurredAt: timeFor(split, index),
    scope: input.scope ?? "current",
    sourceStatus: input.sourceStatus ?? "available",
    lifecycle: input.lifecycle ?? "episode_active",
    revisionGroup: input.revisionGroup ?? null,
    actionParameters: input.actionParameters ?? null,
  };
}

function caseEntry(split, input) {
  const caseId = `${split.slice(0, 3)}-${input.caseId}`;
  return {
    caseId,
    split,
    class: input.class ?? "representative",
    category: input.category,
    scenarioFamilyId: `${split}-scenario-${input.caseId}`,
    queryTemplateId: `${split}-query-${input.caseId}`,
    distractorPoolId: `${split}-shared-pool-v2`,
    query: input.query,
    filteredTargetKind: input.filteredTargetKind ?? null,
    golden: {
      answerability: input.answerability,
      allowedRelevantRecordKeys: input.allowedRelevantRecordKeys ?? [],
      forbiddenRecordKeys: input.forbiddenRecordKeys ?? [],
      expectedQueryRoute: input.expectedQueryRoute,
      requiredRank: input.requiredRank ?? null,
      expectedCurrentRevisionKey: input.expectedCurrentRevisionKey ?? null,
      expectedActionParametersSha256: input.expectedActionParameters === undefined
        ? null
        : canonicalSha256(input.expectedActionParameters),
    },
  };
}

function buildSplit(split) {
  const rows = [];
  const cases = [];
  const addRow = (input) => {
    const created = row(split, rows.length, input);
    rows.push(created);
    return created;
  };

  for (const [name, query, title, text] of semanticDefinitions[split]) {
    const target = addRow({ key: `semantic-${name}`, title, text });
    cases.push(caseEntry(split, {
      caseId: `semantic-${name}`,
      category: "semantic_answerable",
      query: { mode: "text", value: query },
      answerability: "answerable",
      allowedRelevantRecordKeys: [target.key],
      expectedQueryRoute: "hybrid",
      requiredRank: 5,
    }));
  }

  for (const [name, title, text] of controlDefinitions[split].exact) {
    const target = addRow({ key: `control-${name}`, title, text });
    cases.push(caseEntry(split, {
      caseId: `control-${name}`,
      category: "exact_control",
      query: { mode: "exact_record", targetRecordKey: target.key },
      answerability: "answerable",
      allowedRelevantRecordKeys: [target.key],
      expectedQueryRoute: "exact_bypass",
      requiredRank: 1,
    }));
  }

  for (const [name, title, text] of controlDefinitions[split].phrase) {
    const target = addRow({ key: `control-${name}`, title, text });
    const phrase = text.match(/(?:is|phrase is) ([a-z -]+) and/u)?.[1];
    if (phrase === undefined) throw new Error(`phrase extraction failed for ${name}`);
    cases.push(caseEntry(split, {
      caseId: `control-${name}`,
      category: "phrase_control",
      query: { mode: "text", value: `"${phrase}"` },
      answerability: "answerable",
      allowedRelevantRecordKeys: [target.key],
      expectedQueryRoute: "lexical",
      requiredRank: 1,
    }));
  }

  for (const [name, token, previousText, currentText, parameters] of controlDefinitions[split].temporal) {
    const group = `${split.slice(0, 3)}-${name}-revision`;
    addRow({
      key: `control-${name}-previous`,
      title: `${split} previous ${name}`,
      text: previousText,
      lifecycle: "explicit_superseded",
      revisionGroup: group,
    });
    const current = addRow({
      key: `control-${name}-current`,
      title: `${split} current ${name}`,
      text: currentText,
      lifecycle: "explicit_current",
      revisionGroup: group,
      actionParameters: parameters,
    });
    cases.push(caseEntry(split, {
      caseId: `control-${name}`,
      category: "temporal_control",
      query: { mode: "text", value: token },
      answerability: "answerable",
      allowedRelevantRecordKeys: [current.key],
      forbiddenRecordKeys: [`${split.slice(0, 3)}-control-${name}-previous`],
      expectedQueryRoute: "hybrid",
      requiredRank: 1,
      expectedCurrentRevisionKey: current.key,
      expectedActionParameters: parameters,
    }));
  }

  for (const category of ["far_unrelated", "lexical_collision", "semantic_near_miss", "boilerplate_collision"]) {
    for (const definition of negativeDefinitions[split][category]) {
      const [name, query, title, text] = definition;
      const forbidden = title === undefined ? [] : [addRow({
        key: `negative-${name}`,
        title,
        text,
      }).key];
      cases.push(caseEntry(split, {
        caseId: `negative-${name}`,
        category,
        query: { mode: "text", value: query },
        answerability: "must_abstain",
        forbiddenRecordKeys: forbidden,
        expectedQueryRoute: "hybrid",
      }));
    }
  }

  for (const [kind, query, title, text] of filteredDefinitions[split]) {
    const base = `filtered-${kind}`;
    let target;
    if (kind === "wrong-repository" || kind === "wrong-principal") {
      target = addRow({
        key: base,
        title,
        text,
        scope: kind === "wrong-repository" ? "foreign_repository" : "foreign_principal",
      });
    } else if (["stale-source", "tampered-source", "unavailable-source"].includes(kind)) {
      target = addRow({ key: base, title, text, sourceStatus: kind.replace("-source", "") });
    } else if (kind === "superseded") {
      const group = `${split.slice(0, 3)}-filtered-superseded-revision`;
      target = addRow({
        key: `${base}-previous`, title, text,
        lifecycle: "explicit_superseded", revisionGroup: group,
      });
      addRow({
        key: `${base}-current`,
        title: `${split} current lagoon replacement`,
        text: split === "calibration"
          ? "The current lagoon policy uses twenty minutes and does not validate the obsolete premise."
          : "The current delta policy uses thirty minutes and does not validate the obsolete premise.",
        lifecycle: "explicit_current",
        revisionGroup: group,
      });
    } else {
      target = addRow({
        key: base, title, text, lifecycle: "explicit_retracted",
      });
    }
    cases.push(caseEntry(split, {
      caseId: base,
      class: "security",
      category: "filtered_target_abstention",
      query: { mode: "text", value: query },
      answerability: "must_abstain",
      forbiddenRecordKeys: [target.key],
      expectedQueryRoute: "hybrid",
      filteredTargetKind: kind.replaceAll("-", "_"),
    }));
  }

  const adjectives = split === "calibration"
    ? ["amber", "bronze", "citron", "denim", "elm", "frost", "garnet", "hazel", "iris", "jade"]
    : ["lilac", "mauve", "navy", "ochre", "pearl", "russet", "scarlet", "teal", "umber", "vermilion"];
  const nouns = split === "calibration"
    ? ["almanac", "beacon", "compass", "drum", "easel", "flute", "globe", "harp", "inkwell", "jigsaw"]
    : ["kettle", "lantern", "mosaic", "needle", "obelisk", "paddle", "quiver", "ribbon", "sundial", "tapestry"];
  while (rows.length < 128) {
    const index = rows.length;
    const adjective = adjectives[index % adjectives.length];
    const noun = nouns[Math.floor(index / adjectives.length) % nouns.length];
    addRow({
      key: `distractor-${String(index).padStart(3, "0")}`,
      title: `${split} neutral ${adjective} ${noun} ${String(index).padStart(3, "0")}`,
      text: `${split} background item ${String(index).padStart(3, "0")} catalogs ${adjective} ${noun} specimen ${split.slice(0, 3)}-${index}; it carries no operational decision or requested answer.`,
    });
  }

  if (rows.length !== 128) throw new Error(`${split} pool has ${rows.length} rows`);
  if (cases.length !== 48) throw new Error(`${split} case pack has ${cases.length} cases`);
  return {
    pool: { schemaVersion: 2, experimentId: EXPERIMENT_ID, split, rows },
    cases: { schemaVersion: 2, experimentId: EXPERIMENT_ID, split, cases },
  };
}

function normalizeExact(value) {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function assertCorpus(calibration, evaluation) {
  for (const built of [calibration, evaluation]) {
    const answerable = built.cases.cases.filter((entry) => entry.golden.answerability === "answerable");
    const abstain = built.cases.cases.filter((entry) => entry.golden.answerability === "must_abstain");
    if (answerable.length !== 24 || abstain.length !== 24) throw new Error("answerability split is not 24/24");
    const counts = Object.groupBy(built.cases.cases, (entry) => entry.category);
    const expected = {
      semantic_answerable: 16,
      exact_control: 2,
      phrase_control: 2,
      temporal_control: 4,
      far_unrelated: 4,
      lexical_collision: 4,
      semantic_near_miss: 4,
      boilerplate_collision: 4,
      filtered_target_abstention: 8,
    };
    for (const [category, count] of Object.entries(expected)) {
      if ((counts[category] ?? []).length !== count) throw new Error(`${built.pool.split} ${category} count mismatch`);
    }
    const eligible = built.pool.rows.filter((entry) =>
      entry.scope === "current" && entry.sourceStatus === "available" &&
      !["explicit_retracted", "explicit_superseded"].includes(entry.lifecycle));
    if (eligible.length < 32) throw new Error(`${built.pool.split} has fewer than 32 eligible distractors`);
  }
  for (const field of ["scenarioFamilyId", "queryTemplateId", "distractorPoolId"]) {
    const left = new Set(calibration.cases.cases.map((entry) => entry[field]));
    const overlap = evaluation.cases.cases.filter((entry) => left.has(entry[field]));
    if (overlap.length !== 0) throw new Error(`${field} overlaps across splits`);
  }
  const leftContent = new Set(calibration.pool.rows.flatMap((entry) =>
    [normalizeExact(entry.title), normalizeExact(entry.text)]));
  const overlap = evaluation.pool.rows.flatMap((entry) =>
    [normalizeExact(entry.title), normalizeExact(entry.text)]).filter((value) => leftContent.has(value));
  if (overlap.length !== 0) throw new Error("normalized title/text overlaps across splits");
}

const calibration = buildSplit("calibration");
const evaluation = buildSplit("evaluation");
assertCorpus(calibration, evaluation);

const priorAssessment = {
  schemaVersion: 2,
  experimentId: EXPERIMENT_ID,
  priorExperimentId: "fal-em0-local-embedding-hybrid-v1",
  priorEvidenceReceiptSha256: "a6a9c5563b421342c7c21f1d1efb0470cdd04aa322ff4b77a2c0ec5ce4b88b6c",
  priorCandidateImplementationSha256: "6251ca321314fd920fc106585869b45fec8eb92de56829ca12937c30d0de29d7",
  priorModelArtifactManifestSha256: "eb54f2a0fc3b5a2608f4c43b404e10bf4da856b9b405e48ff27fcecaeef55141",
  priorThresholdSimilarityMicros: 780000,
  evidenceValidity: "limited",
  classification: "known_regression_development_only",
  limitations: [
    "only one effective vector-abstention calibration negative",
    "security families appeared only in evaluation",
    "case-local three-row corpora did not measure maximum-score distractor risk",
    "receipt omitted branch provenance and per-row score distributions",
    "candidate source and artifact inputs were not retained in Git",
  ],
};

const anchorPairs = [
  ["怎样恢复被拒绝的命令", "A denied operation requires a fresh explicit authorization before retry."],
  ["repository results are stale after source changes", "Publish a new repository index generation after tracked content changes."],
  ["Where is the offline artifact?", "离线交付包保存在本地归档并带有校验摘要。"],
  ["召回以后是否检查来源", "Re-fetch the canonical source and reject stale or unavailable material."],
  ["resume after a process crash", "Continue from the last durable effect boundary after reconciling live state."],
  ["如何安全释放磁盘", "Inventory exact files and quarantine them before irreversible cleanup."],
  ["cross timezone reminder", "Store the named timezone together with the intended local civil time."],
  ["flaky verification", "Repeat the check under controlled conditions before calling it deterministic."],
  ["disable semantic retrieval", "A kill switch restores the established lexical search path."],
  ["dependency reproducibility", "Bind installation to a lock graph, resolver version, and artifact digests."],
  ["tool action audit", "Link user consent, normalized parameters, execution identity, and final state."],
  ["private preference retention", "Only explicitly requested user preferences may persist and they remain retractable."],
].map(([query, passage], index) => ({
  anchorId: `em-r1-anchor-${String(index + 1).padStart(2, "0")}`,
  query,
  passage,
  expected: null,
}));

const anchors = {
  schemaVersion: 2,
  experimentId: EXPERIMENT_ID,
  status: "inputs_frozen_outputs_pending",
  provenance: "self_frozen_reimplementation_reference_pending_independent_confirmation",
  runtimeContract: {
    package: "@huggingface/transformers@3.3.3",
    modelId: "Xenova/multilingual-e5-small",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    dtype: "int8",
    dimensions: 384,
    pooling: "mean",
    normalize: true,
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
  },
  anchors: anchorPairs,
};

const files = {
  "prior-evidence-assessment.json": json(priorAssessment),
  "reference-anchors.json": json(anchors),
  "calibration-pool.json": json(calibration.pool),
  "calibration-cases.json": json(calibration.cases),
  "evaluation-pool.json": json(evaluation.pool),
  "evaluation-cases.json": json(evaluation.cases),
};

const dataAdequacy = {
  calibrationCases: 48,
  evaluationCases: 48,
  calibrationPoolRows: 128,
  evaluationPoolRows: 128,
  answerablePerSplit: 24,
  unanswerablePerSplit: 24,
  minimumFtsEmptyVectorNegativesPerSplit: 16,
  minimumEligibleDistractorsPerAbstentionCase: Math.min(
    ...SPLITS.map((split) => (split === "calibration" ? calibration : evaluation).pool.rows.filter((entry) =>
      entry.scope === "current" && entry.sourceStatus === "available" &&
      !["explicit_retracted", "explicit_superseded"].includes(entry.lifecycle)).length),
  ),
  crossSplitScenarioFamilyOverlap: 0,
  crossSplitQueryTemplateOverlap: 0,
  crossSplitDistractorPoolOverlap: 0,
  normalizedTitleTextExactOverlap: 0,
};

const manifestContent = {
  schemaVersion: 2,
  experimentId: EXPERIMENT_ID,
  evidenceState: "working_tree_full",
  createdAt: CREATED_AT,
  corpusRevision: 2,
  dataFrozenBeforeCandidateImplementation: false,
  freezeStage: "candidate_mechanism_frozen_before_corpus_revision_2_threshold_run",
  revisionReason: "revision 1 failed the live FTS-empty adequacy preflight before evaluation",
  supersededInvalidPreflightReceiptSha256: "bb4038b311b72391614df52a715a0e68fe9e21f1261115207b31a2636002b169",
  evaluationGoldensSealedUntilCalibrationEligible: true,
  sourceCommit: null,
  reimplementationMode: "reimplementation_from_v1_contract",
  dataAdequacy,
  files: Object.fromEntries(Object.entries(files).map(([path, contents]) => [path, {
    bytes: Buffer.byteLength(contents),
    sha256: sha256(contents),
  }])),
};
const manifest = { ...manifestContent, manifestSha256: canonicalSha256(manifestContent) };
files["manifest.json"] = json(manifest);

process.stdout.write(JSON.stringify({ directory: "fixtures/frontier-adapter-lab/fal-em-r1-selective-hybrid-v2", files }));
