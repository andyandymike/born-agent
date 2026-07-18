# BornAgent

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
