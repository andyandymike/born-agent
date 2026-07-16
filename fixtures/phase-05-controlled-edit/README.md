# Phase 5 controlled edit fixture

`src/math.ts` contains a deliberately incorrect `clamp` implementation. Tests copy this
fixture to a temporary workspace before exercising approval, denial, and patch application.
`notes/user-draft.txt` represents unrelated user work and must remain byte-for-byte unchanged.
