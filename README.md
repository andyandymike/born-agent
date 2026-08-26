# BornAgent

[Project site](https://andyandymike.github.io/born-agent/) ·
[Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md)

BornAgent is a learning-first local coding agent. The project has two primary
goals: reproduce and compare frontier agent techniques through inspectable
experiments, and turn each implementation into reusable personal knowledge
about AI-agent concepts, source call chains, engineering tradeoffs, failures,
and actual development time. A feature therefore enters through a runnable
vertical slice with an experiment baseline and learning record, not through a
large speculative framework. See the [learning roadmap](ROADMAP.md), the
[Agent Memory track](docs/agent-memory/learning-and-delivery-track.md), and the
active [Lightweight Memory Core and Frontier Adapters spec](spec/agent-memory-lightweight-core-and-adapters.md).

Runtime authority comes from a versioned policy profile rather than scattered
provider/Docker flags. With no policy option, every command uses the packaged
`local-free-v1` profile:

- provider/model: literal-loopback Ollama with `qwen3:1.7b`;
- remote providers and credential reads: denied;
- provider fallback, retry, proxy, redirect, and automatic model pull: denied;
- eval suites: targeted and smoke only;
- Docker acquisition: one package-locked artifact through an anonymous
  exact-digest pull or a trusted local `--network=none` build.

OpenAI and Anthropic adapters exist and are contract-tested with injected fake
transport. They can only be selected through an explicit trusted user profile;
the built-in profile, repository files, prompts, and ambient API keys cannot
activate them.

## Requirements

- Node.js 22.19 or newer
- pnpm 11.13.1
- Optional: Ollama on `http://127.0.0.1:11434` with `qwen3:1.7b` already
  installed. BornAgent reports a missing model and never pulls one automatically.
- Optional: a running local Docker daemon for the Docker executor or
  `born docker` commands. BornAgent does not start Docker Desktop, log in, push,
  or use a remote builder.

## Start locally

```powershell
corepack pnpm install
corepack pnpm dev policy show
corepack pnpm dev doctor
corepack pnpm dev chat "Explain this repository"
```

Useful policy and Docker diagnostics:

```powershell
corepack pnpm dev policy validate
corepack pnpm dev policy explain --profile local-free-v1 --provider ollama --model qwen3:1.7b
corepack pnpm dev models --json
corepack pnpm dev docker status --json
corepack pnpm dev docker prepare --source build --json
```

`policy show`, `policy validate`, and `policy explain` are local, read-only
operations. Merely enabling Docker acquisition in a profile does not call Docker;
`docker prepare` or selecting the Docker executor is the explicit trigger.

Configuration precedence for a run request is CLI flags, then
`BORN_PROVIDER`/`BORN_MODEL`, then the selected profile's default. These request
values can narrow a profile but cannot expand it or choose a paid-capable
profile. A remote profile must be defined in trusted user configuration and
selected by its complete ID on every run.

Prompts, tool observations, policy hashes, and run events are stored locally
under `.bornagent/sessions`. Credential values and policy file paths are not
written to session evidence. Do not put secrets in prompts.

`models --refresh-local` performs opt-in metadata discovery only against the
validated literal-loopback Ollama `/api/tags` endpoint. It never follows
redirects, downloads a model, or turns discovery into live-verification evidence.

## Experimental local episodic memory

ML1 adds an opt-in, repository-scoped episode after an Agent run reaches a
durable successful terminal. ML2 adds manual exact, quoted-phrase, and lexical
search with deterministic recency tie-breaking. ML3 lets an explicitly local
Agent request use bounded historical excerpts. Memory remains `off` by default;
the Agent off path does not load SQLite, open a memory database, retrieve
history, or alter model context.

```powershell
corepack pnpm dev agent "Inspect and verify this repository" --memory local
corepack pnpm dev memory status --json
corepack pnpm dev memory list --json
corepack pnpm dev memory search "cache invalidation" --explain
corepack pnpm dev memory show <episode-id> --json
```

Each episode is deterministically rebuilt from exact session JSONL hashes,
bound to the local owner plus one active repository/canonical-root identity,
screened before persistence, and capped by record and logical-byte limits.
`list` exposes only source-available records; `show` marks missing or changed
source evidence as stale. `search` uses one deletable FTS5 projection per exact
principal/repository/root scope, considers at most 100 candidates, and returns
only source-revalidated records within result, text-byte, and conservative-token
bounds. Inspection commands never auto-register a repository.

With `--memory local`, every local-Ollama or in-process model request reruns the
same scoped search, refetches canonical rows, and revalidates exact source bytes
before adding at most three low-priority `historical_only` items. Their combined
planner estimate cannot exceed 1,024 tokens or 8% of the compaction target.
Historical bytes are explicitly delimited as past evidence, never current
instructions, approvals, permissions, policy, or verified current state.

Provider-network requests receive zero memory records and do not open the FTS
projection. ML3 still does not extract facts from ordinary chat or implement
`remember`/`retract`; those user lifecycle operations remain ML4.

## Local capability platform

Phase 18 now has local Skills, stdio MCP resources/user prompts, declarative
and foreground command lifecycle Hooks, and an immutable local Plugin store.
Useful read and lifecycle surfaces include:

```powershell
corepack pnpm dev capabilities doctor --json
corepack pnpm dev plugins inspect fixtures/capability-platform/m9-review-pack --json
corepack pnpm dev plugins install fixtures/capability-platform/m9-review-pack --expect-sha256 <full-digest> --json
corepack pnpm dev skills list --json
corepack pnpm dev mcp prompts list --json
corepack pnpm dev hooks list --json
```

Install never executes package code and leaves the Plugin disabled. Enablement
only makes exact frozen components eligible for future runs; MCP starts/calls,
resource reads, prompts, Hooks, commands, and workspace effects remain separately
gated. The TUI exposes `/plugins`, `/skill`, and `/mcp-prompt` for current-state
inspection and explicit next-run selection.

The M9 capability-platform gate is complete. Command Hooks use a separately
approved, argv-only child with a minimal environment, strict bounded output,
durable operation records, process-tree cleanup, crash reconciliation, and
original-action revalidation. Plugin operations and active content leases are
reconciled from exact state, audit, run-terminal, and recovered session-lock
facts. A Hook can only deny or report no objection; it never approves the
original action.

There is still no marketplace, network install, dependency resolver, signature
trust claim, background Hook, or third-party in-process runtime.

## Durable task orchestration

Phase 19 / M10 adds an exact durable Task Graph over an approved Goal and Plan,
a deterministic single-active scheduler, managed Git worktrees, explicit
content-addressed promotion into the origin, and a bounded local background
worker with verified handoff, cancellation, recovery, and narrow takeover.

Useful diagnostics and control surfaces include:

```powershell
corepack pnpm dev graph validate --file <graph.json> --json
corepack pnpm dev graph doctor --json
corepack pnpm dev graph show <session-id> --json
corepack pnpm dev graph status <session-id> --live --json
corepack pnpm dev graph worker doctor --json
```

Graph approval authorizes scheduling intent only. Node commands, patches, MCP
calls, Hooks, worktree allocation, promotion, verification, and cleanup retain
their independent policy and approval boundaries. Phase 19 remains a single
Agent: it does not add subagents, parallel model loops, a daemon, remote workers,
automatic commits/pushes/PRs, or unsafe worktree deletion.

## Controlled subagents

Phase 20 implements explicit, authority-attenuated
delegation. A user reviews one exact delegation revision; the Host then freezes
a minimal typed context capsule and independent model, tool, capability, budget,
workspace, environment, and approval envelope. A sealed local Node child cannot
inherit the parent transcript, secrets, approvals, leases, or delegation tools.

The M11 baseline can run up to two conflict-free children while
the parent is suspended behind a durable barrier. Each child writes an isolated
session shard, and the Host imports durable events and accepts only a canonical,
verified structured receipt. Useful surfaces include:

```powershell
corepack pnpm dev delegations list --session <id> --json
corepack pnpm dev delegations prepare --session <id> --delegation <id> --json
corepack pnpm dev delegations start --session <id> --delegation <id> --json
corepack pnpm dev delegations receipt --session <id> --delegation <id> --json
corepack pnpm dev delegations doctor --session <id> --json
```

M11 passed on 2026-08-11. Proven pre-effect failures settle durably and
may create one fresh attempt-two envelope, including after exact resume recovery.
Linux PTY and Windows read-only/coding ConPTY flows, actor-bound child effect approvals,
active-child modal cancellation with separate TUI exit, managed-worktree change
receipts, an explicit default-cancel exit decision, two-child coordinator
kill/takeover, and the Phase 19 foreground-approval handoff are covered. A
canonical coding receipt now also completes the existing M10
promotion and origin-verification flow. The packed tarball proves a short-lived
CLI can hand off to a Phase 19 worker which owns and closes two read-only
children; the foreground and worker-owned paths accept four verified receipts
in total. On exact candidate `6e1fe9481434c68fcb5611c33d19323df81ac3a8`,
[Linux and Windows CI](https://github.com/andyandymike/born-agent/actions/runs/31499670681)
passed the full suite, required process-tree/child/PTY paths, and packed-artifact
smoke; the matching [Pages deployment](https://github.com/andyandymike/born-agent/actions/runs/31499669597)
also passed. Nested agents, daemon/remote workers, automatic routing or promotion,
commit, push, and PR remain unsupported.
