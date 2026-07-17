# BornAgent eval assets

This directory contains the versioned Phase 14 reliability suite. `suite-v1.json`
pins exactly 20 tasks and a fixed five-task smoke subset. Each task keeps its
Agent-visible starting bytes under `workspace/` and its host-only expectations
under `grader/`.

The suite is intentionally local-only. `born eval run` can execute in-process
`fake`/`mock` fixtures or an already-installed model through a literal-loopback
Ollama endpoint. Full-suite execution and remote providers are hard-disabled;
loading and planning the full task set does not authorize attempts or network
requests.

Regenerate these mechanical fixtures with:

```powershell
node scripts/generate-eval-assets.mjs
```

Review all resulting task, workspace, grader, and suite hash changes together.
