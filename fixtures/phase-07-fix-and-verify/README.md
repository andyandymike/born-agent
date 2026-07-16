# Phase 7 fix and verify fixture

`src/clamp.mjs` starts with a one-line bounds bug. `node verify.mjs` is an
offline, deterministic check used to prove that completion evidence belongs to
the post-patch source state.
