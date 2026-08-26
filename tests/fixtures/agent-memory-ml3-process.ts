import { runCli } from "../../src/cli/run-cli.js";
import { FakeStreamingChatClient, fixedStream } from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const [stateRoot, workspace, task, memoryMode = "local"] = process.argv.slice(2);
if (stateRoot === undefined || workspace === undefined || task === undefined) {
  throw new Error("usage: agent-memory-ml3-process <state-root> <workspace> <task> [local|off]");
}

const client = new FakeStreamingChatClient(fixedStream());
const output = createMemoryIO();
const exitCode = await runCli([
  "agent",
  task,
  "--task-profile",
  "read-only",
  "--max-steps",
  "1",
  "--memory",
  memoryMode,
], output.io, createRuntime({
  controlPlaneStateRoot: stateRoot,
  createModelBackend: () => client,
  cwd: workspace,
}));

process.stdout.write(`${JSON.stringify({
  exitCode,
  request: client.calls[0]?.request ?? null,
  stderr: output.readStderr(),
  stdout: output.readStdout(),
})}\n`);
