# M10 canonical repository rules

- Keep all verification offline and deterministic.
- Core changes stay under `src/core`; UI changes stay under `src/ui`.
- Never read credential, sibling-workspace, Git common-dir, or origin canaries.
