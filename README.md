# BornAgent

BornAgent is a learning-first local coding agent. The current production policy is
`local_free_only`: model execution is limited to an in-process fake/mock runtime or
a literal-loopback Ollama server. Remote OpenAI and Anthropic adapters are wired and
contract-tested through the production mapper, but the CLI blocks their network
requests before a runtime or socket is created.

## Requirements

- Node.js 22.19 or newer
- pnpm 11.13.1
- Optional: Ollama on `http://localhost:11434` with an already-installed,
  explicitly selected model. BornAgent never pulls a model automatically.

## Commands

```text
born models [--provider openai|anthropic|ollama] [--json] [--refresh-local]
born chat --provider ollama --model qwen3:1.7b "your prompt"
born agent --provider ollama --model qwen3:1.7b "your task"
```

Configuration precedence is CLI flags, then `BORN_PROVIDER` / `BORN_MODEL`, then
the built-in default (`openai` with `gpt-5.6-terra`). Under `local_free_only`, that
remote default fails locally with exit code 2; there is no fallback or retry on a
different provider. Ollama accepts only the root URL forms
`http://127.0.0.1:11434`, `http://[::1]:11434`, or
`http://localhost:11434`.

Prompts, tool observations, and run events are stored locally under
`.bornagent/sessions`. Do not put secrets in prompts.

`--refresh-local` is opt-in metadata discovery: it calls only the validated
loopback Ollama `/api/tags` endpoint, never follows redirects, and never upgrades
a discovered tag into capability or live-verification evidence.
