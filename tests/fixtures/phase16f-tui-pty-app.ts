import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { runCli } from "../../src/cli/run-cli.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { BundledFakeModelQualificationGate } from "../../src/model/model-qualification-gate.js";
import { createPiTuiRenderer } from "../../src/tui/pi-tui-renderer.js";
import {
  FakeStreamingChatClient,
  fixedStream,
  waitForAbort,
} from "../fakes/fake-chat-client.js";

const workspace = process.argv[2];
if (workspace === undefined) {
  throw new Error("PTY fixture requires a workspace path");
}

const waiting = waitForAbort();
const firstBackend = new FakeStreamingChatClient(
  async function* (request, signal) {
    yield { delta: "PTY_ACTIVE", type: "text_delta" };
    yield* waiting(request, signal);
  },
  { model: "qwen3:1.7b", provider: "ollama" },
);
let backendIndex = 0;

const node = createNodeRuntime({
  approvalInput: { interactive: false, readLine: async () => null },
  cwd: workspace,
  env: process.env,
  execPath: process.execPath,
  killProcess: (identity, signal) => process.kill(identity, signal),
  nodeVersion: process.versions.node,
  onCancel: (listener) => {
    process.once("SIGINT", listener);
    return () => process.off("SIGINT", listener);
  },
  platform: process.platform,
  tuiHost: {
    createRenderer: createPiTuiRenderer,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
  },
  version: "0.0.0-phase16f-pty",
});
const runtime: CliRuntime = {
  ...node,
  agentModelEvidence: () => ({
    backend: "fake",
    endpointScope: "in_process",
    kind: "contract_verified",
    remoteBillableRequests: 0,
  }),
  createModelBackend: () => {
    const backend =
      backendIndex === 0
        ? firstBackend
        : new FakeStreamingChatClient(fixedStream(["PTY_SECOND"]), {
            model: "qwen3:1.7b",
            provider: "ollama",
          });
    backendIndex += 1;
    return backend;
  },
  modelQualificationGate: new BundledFakeModelQualificationGate(true),
};

const exitCode = await runCli(
  [
    "tui",
    "First PTY run",
    "--allow-degraded-resume",
    "--provider",
    "ollama",
    "--model",
    "qwen3:1.7b",
    "--max-steps",
    "4",
  ],
  { stderr: process.stderr, stdout: process.stdout },
  runtime,
);
process.stdout.write(`\nPTY_APP_EXIT=${String(exitCode)}\n`);
process.exitCode = exitCode;
