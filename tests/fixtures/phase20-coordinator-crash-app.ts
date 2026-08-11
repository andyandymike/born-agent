import { writeFile } from "node:fs/promises";

import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { runCli } from "../../src/cli/run-cli.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";

const [workspace, stateRoot, cliEntryPath, sessionId, delegationId, readyPath] = process.argv.slice(2);
if ([workspace, stateRoot, cliEntryPath, sessionId, delegationId, readyPath].some((value) => value === undefined)) {
  throw new Error("coordinator crash fixture requires workspace, state, CLI, session, delegation, and ready paths");
}

const base = createNodeRuntime({
  approvalInput: { interactive: false, readLine: async () => null },
  cliEntryPath: cliEntryPath!,
  cwd: workspace!,
  delegationUserStateRoot: stateRoot!,
  env: { ...process.env, LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot },
  execPath: process.execPath,
  killProcess: (identity, signal) => process.kill(identity, signal),
  nodeVersion: process.versions.node,
  onCancel: (listener) => {
    process.once("SIGINT", listener);
    return () => process.off("SIGINT", listener);
  },
  platform: process.platform,
  version: "0.0.0-phase20-coordinator-crash",
  workerUserStateRoot: stateRoot!,
  worktreeUserStateRoot: `${stateRoot!}-worktrees`,
});
const originalWriterFactory = base.delegationWriterFactory;
if (originalWriterFactory === undefined) throw new Error("coordinator fixture has no delegation writer factory");
let paused = false;
const runtime: CliRuntime = {
  ...base,
  delegationWriterFactory: async (context) => {
    const writer = await originalWriterFactory(context);
    const session = reconstructMultiRunSession(writer.events);
    const accepted = session.delegations.revisions.filter((revision) =>
      revision.status === "accepted" && revision.receipt?.status === "succeeded");
    if (!paused && accepted.length === 2 && session.delegations.activeActorSlots.length === 2) {
      paused = true;
      const evidence = {
        accepted: accepted.map((revision) => revision.delegationId).sort(),
        activeActorSlots: session.delegations.activeActorSlots.length,
        activeConflictClaims: session.delegations.activeConflictClaims.length,
        childStartCount: session.events.filter((event) =>
          event.scope === "session" && event.type === "delegation.child.started").length,
      };
      // Release the session writer before the crash marker. The killed
      // coordinator leaves only group resources, not an unrelated stale lock.
      await writer.close();
      await writeFile(readyPath!, `${JSON.stringify(evidence)}\n`, "utf8");
      await new Promise<never>(() => {
        setInterval(() => undefined, 1_000);
      });
    }
    return writer;
  },
};

const exitCode = await runCli([
  "delegations",
  "start",
  "--session",
  sessionId!,
  "--delegation",
  delegationId!,
  "--json",
], { stderr: process.stderr, stdout: process.stdout }, runtime);
process.exitCode = exitCode;
