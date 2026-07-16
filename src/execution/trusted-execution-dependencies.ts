const TRUSTED_TRANSITIVE_DEPENDENCIES: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  "fixtures/phase-06-command-execution/long-parent.mjs": Object.freeze([
    "fixtures/phase-06-command-execution/grandchild.mjs",
  ]),
  "fixtures/phase-07-fix-and-verify/verify.mjs": Object.freeze([
    "fixtures/phase-07-fix-and-verify/src/clamp.mjs",
  ]),
  "fixtures/phase-07-verification-fails/verify.mjs": Object.freeze([
    "fixtures/phase-07-verification-fails/src/answer.mjs",
  ]),
});

export function trustedExecutionDependencies(
  workspaceRelativeEntry: string,
): readonly string[] {
  // PHASE6: a reviewed launcher can execute bytes that are not statically imported.
  // This source-owned map makes those transitive fixture bytes part of the same
  // action digest; repository/model text cannot add an unreviewed dependency.
  return TRUSTED_TRANSITIVE_DEPENDENCIES[workspaceRelativeEntry] ?? [];
}
