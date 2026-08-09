# BornAgent

[Project site](https://andyandymike.github.io/born-agent/) ·
[Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md)

BornAgent is a learning-first local coding agent. Runtime authority comes from a
versioned policy profile rather than scattered provider/Docker flags. With no
policy option, every command uses the packaged `local-free-v1` profile:

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
