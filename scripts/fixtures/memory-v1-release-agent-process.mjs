import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, stateRoot, workspace, task, memoryMode] = process.argv.slice(2);
if (
  packageRoot === undefined || stateRoot === undefined || workspace === undefined ||
  task === undefined || (memoryMode !== "local" && memoryMode !== "off")
) {
  throw new TypeError(
    "usage: memory-v1-release-agent-process <package-root> <state-root> <workspace> <task> <local|off>",
  );
}

// MEMORY-ML5: The release driver must prove the packed local path without ever
// inheriting a provider credential or a user BORN_* override from its launcher.
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("BORN_") ||
    /(?:API_KEY|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)/iu.test(key)
  ) {
    delete process.env[key];
  }
}
process.env.BORN_CONTROL_STATE_ROOT = stateRoot;
process.env.BORN_HOOK_SUPPRESSED = "1";

const [
  { createNodeRuntime },
  { runCli },
  { disposeApplicationHostForStateRoot },
  { BackendContinuation },
] = await Promise.all([
  import(pathToFileURL(join(packageRoot, "dist", "cli", "node-runtime.js")).href),
  import(pathToFileURL(join(packageRoot, "dist", "cli", "run-cli.js")).href),
  import(pathToFileURL(join(
    packageRoot,
    "dist",
    "control-plane",
    "adapters",
    "agent-cli-adapter.js",
  )).href),
  import(pathToFileURL(join(packageRoot, "dist", "model", "model-backend.js")).href),
]);

class ReleaseContinuation extends BackendContinuation {}

class ReleaseModelBackend {
  calls = [];
  capabilities = Object.freeze({
    cancellation: "abort_signal",
    reasoning: "opaque_passthrough",
    streaming: true,
    tools: "strict",
    usage: "complete",
  });
  contextCapacity = Object.freeze({
    contextWindowTokens: 32_768,
    maximumOutputTokens: 8_192,
    source: "pinned_catalog",
  });
  resume = Object.freeze({
    capability: "canonical_only",
    supportsCanonicalDegradedResume: true,
  });

  constructor(selection) {
    this.identity = Object.freeze({
      adapter: "memory-v1-release-fake",
      adapterVersion: "ml5-v1",
      configFingerprint: "0".repeat(64),
      model: selection.model,
      provider: selection.provider,
    });
  }

  async *runTurn(request, signal) {
    this.calls.push(Object.freeze({ request, signal }));
    yield { text: "verified local memory release response", type: "text_delta" };
    yield {
      type: "usage",
      usage: Object.freeze({
        cacheReadTokens: null,
        cacheWriteTokens: null,
        completeness: "complete",
        inputTokens: 12,
        outputTokens: 6,
        totalTokens: 18,
      }),
    };
    yield {
      continuation: new ReleaseContinuation(),
      outcome: "text",
      providerRequestId: "memory-v1-release-local-fake",
      type: "turn_completed",
    };
  }
}

function memoryIo() {
  let stderr = "";
  let stdout = "";
  return Object.freeze({
    io: Object.freeze({
      stderr: Object.freeze({ write: (value) => void (stderr += value) }),
      stdout: Object.freeze({ write: (value) => void (stdout += value) }),
    }),
    readStderr: () => stderr,
    readStdout: () => stdout,
  });
}

function requestEvidence(request) {
  if (request === undefined) return null;
  return Object.freeze({
    canonicalContext: request.canonicalContext ?? null,
    contextPlan: request.contextPlan ?? null,
    input: request.input,
    instructions: request.instructions,
    toolNames: request.tools.map((tool) => tool.name),
  });
}

const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const backends = [];
const baseRuntime = createNodeRuntime({
  approvalInput: Object.freeze({
    interactive: false,
    readLine: async () => null,
  }),
  cliEntryPath: join(packageRoot, "dist", "cli.js"),
  cwd: workspace,
  env: Object.freeze({ ...process.env }),
  evalAssetsRoot: join(packageRoot, "evals"),
  execPath: process.execPath,
  killProcess: (identity, signal) => process.kill(identity, signal),
  nodeVersion: process.versions.node,
  onCancel: () => () => undefined,
  platform: process.platform,
  tuiHost: Object.freeze({
    createRenderer: () => {
      throw new Error("release agent process does not create a TUI renderer");
    },
    stdinIsTTY: false,
    stdoutIsTTY: false,
  }),
  version: manifest.version,
});
const runtime = Object.freeze({
  ...baseRuntime,
  agentModelEvidence: () => Object.freeze({
    backend: "fake",
    endpointScope: "in_process",
    kind: "contract_verified",
    remoteBillableRequests: 0,
  }),
  createModelBackend: (selection) => {
    const backend = new ReleaseModelBackend(selection);
    backends.push(backend);
    return backend;
  },
  modelQualificationGate: undefined,
});
const output = memoryIo();

try {
  const exitCode = await runCli([
    "agent",
    task,
    "--task-profile",
    "read-only",
    "--max-steps",
    "1",
    "--memory",
    memoryMode,
  ], output.io, runtime);
  const requests = backends.flatMap((backend) => backend.calls.map(({ request }) => request));
  const evidence = Object.freeze({
    canonicalRequestSha256: requests[0] === undefined
      ? null
      : createHash("sha256").update(JSON.stringify(requestEvidence(requests[0]))).digest("hex"),
    exitCode,
    fakeModelRequestCount: requests.length,
    memoryMode,
    remoteBillableRequests: 0,
    request: requestEvidence(requests[0]),
    schemaVersion: 1,
    stderr: output.readStderr(),
    stdout: output.readStdout(),
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  await disposeApplicationHostForStateRoot(stateRoot);
}
