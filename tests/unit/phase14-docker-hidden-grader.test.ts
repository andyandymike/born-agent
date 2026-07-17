import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DockerHiddenGrader,
  type DockerGraderControlPort,
} from "../../src/evals/docker-hidden-grader.js";
import { loadEvalAssets } from "../../src/evals/eval-suite-loader.js";

const roots: string[] = [];

afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  ),
);

describe("Phase 14 Docker hidden grader wiring", () => {
  it("keeps candidate worker and expectation supervisor mounts disjoint", async () => {
    const calls: string[][] = [];
    let creates = 0;
    const control: DockerGraderControlPort = {
      async run(argv) {
        calls.push([...argv]);
        if (argv[0] === "version") {
          return { exitCode: 0, stderr: "", stdout: "linux\n" };
        }
        if (argv[0] === "image") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: `sha256:${"b".repeat(64)}\n`,
          };
        }
        if (argv[0] === "create") {
          creates += 1;
          return {
            exitCode: 0,
            stderr: "",
            stdout: `${String(creates).repeat(64)}\n`,
          };
        }
        if (argv[0] === "wait") {
          return { exitCode: 0, stderr: "", stdout: "0\n" };
        }
        if (argv[0] === "logs") {
          return {
            exitCode: 0,
            stderr: "",
            stdout:
              '{"case_id":"static","value":"PASS:read-paths\\n"}\n',
          };
        }
        if (argv[0] === "inspect") {
          return { exitCode: 1, stderr: "absent", stdout: "" };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    const root = await mkdtemp(path.join(tmpdir(), "bornagent-grader-test-"));
    roots.push(root);
    const workspace = path.join(root, "attempt", "workspace");
    await mkdir(workspace, { recursive: true });
    const assets = await loadEvalAssets(path.join(process.cwd(), "evals"));
    const task = assets.tasks.get("read-paths");
    if (task === undefined) throw new Error("missing read-paths eval task");
    const grader = new DockerHiddenGrader({
      control,
      image: `bornagent/grader@sha256:${"a".repeat(64)}`,
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
    });

    await grader.preflight();
    expect((await grader.grade(task, workspace)).passed).toBe(true);

    const createCalls = calls.filter((argv) => argv[0] === "create");
    expect(createCalls).toHaveLength(2);
    const worker = createCalls[0]?.join(" ") ?? "";
    const supervisor = createCalls[1]?.join(" ") ?? "";
    expect(worker).toContain("--pull never");
    expect(worker).toContain("--network none");
    expect(worker).toContain("/workspace");
    expect(worker).toContain("/runner");
    expect(worker).not.toContain(task.graderRoot);
    expect(supervisor).toContain("/grader");
    expect(supervisor).toContain("/observations");
    expect(supervisor).not.toContain(workspace);
    expect(calls.filter((argv) => argv[0] === "rm")).toHaveLength(2);
  });
});
