import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  DockerAcquisitionCommandPort,
  DockerAcquisitionCommandResult,
} from "../../src/execution/docker/acquisition/docker-acquisition-port.js";
import { DockerArtifactAcquirer } from "../../src/execution/docker/acquisition/docker-artifact-acquirer.js";
import {
  BUILT_IN_DOCKER_ARTIFACT_ID,
  loadBuiltInDockerArtifact,
} from "../../src/execution/docker/acquisition/docker-artifact-registry.js";
import { loadRuntimePolicyRegistry } from "../../src/policy/policy-config-loader.js";
import { resolveEffectiveRuntimePolicy } from "../../src/policy/policy-resolver.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((value) => rm(value, { force: true, recursive: true })),
  );
});

async function policy() {
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase15-docker-"));
  roots.push(workspace);
  return resolveEffectiveRuntimePolicy(
    await loadRuntimePolicyRegistry({ env: {}, platform: "win32", workspace }),
    undefined,
  );
}

function result(
  stdout = "",
  exitCode = 0,
  stderr = "",
): DockerAcquisitionCommandResult {
  return { exitCode, stderr, stdout };
}

function inspectJson(input: {
  readonly architecture?: string;
  readonly id: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly repoDigests?: readonly string[];
  readonly user?: string;
}): string {
  return JSON.stringify({
    Architecture: input.architecture ?? "amd64",
    Config: { Labels: input.labels ?? {}, User: input.user ?? "" },
    Id: input.id,
    Os: "linux",
    RepoDigests: input.repoDigests ?? [],
  });
}

class FakeDockerPort implements DockerAcquisitionCommandPort {
  readonly calls: readonly string[][];
  readonly #mutableCalls: string[][] = [];
  built = false;
  baseTagged = false;
  buildArgv: readonly string[] | null = null;

  constructor(
    private readonly artifact: Awaited<
      ReturnType<typeof loadBuiltInDockerArtifact>
    >,
  ) {
    this.calls = this.#mutableCalls;
  }

  async run(argv: readonly string[]): Promise<DockerAcquisitionCommandResult> {
    this.#mutableCalls.push([...argv]);
    if (argv[0] === "context" && argv[1] === "show") return result("default\n");
    if (argv[0] === "context" && argv[1] === "inspect") {
      return result('"npipe:////./pipe/dockerDesktopLinuxEngine"\n');
    }
    if (argv[0] === "version") return result("linux/amd64\n");
    if (argv[0] === "info") return result("[]\n");
    if (argv[0] === "image" && argv[1] === "tag") {
      this.baseTagged = true;
      return result();
    }
    if (argv[0] === "build") {
      this.buildArgv = [...argv];
      const iidfile = argv[argv.indexOf("--iidfile") + 1];
      if (iidfile === undefined) throw new Error("test build omitted iidfile");
      await writeFile(iidfile, `sha256:${"a".repeat(64)}\n`, "utf8");
      this.built = true;
      return result();
    }
    if (argv[0] === "image" && argv[1] === "inspect") {
      const reference = argv[2] ?? "";
      if (reference === this.artifact.lock.pull.image) {
        return result(
          inspectJson({
            id: `sha256:${"b".repeat(64)}`,
            repoDigests: [this.artifact.lock.pull.image],
          }),
        );
      }
      if (reference.startsWith("bornagent-internal-base:")) {
        return this.baseTagged
          ? result(inspectJson({ id: `sha256:${"b".repeat(64)}` }))
          : result("", 1, "No such image");
      }
      if (
        reference.startsWith("bornagent-internal-artifact:") ||
        reference === `sha256:${"a".repeat(64)}`
      ) {
        return this.built
          ? result(
              inspectJson({
                id: `sha256:${"a".repeat(64)}`,
                labels: {
                  ...this.artifact.lock.runtime_contract.required_labels,
                  "org.bornagent.lockfile-sha256":
                    this.artifact.lockSha256,
                },
                user: this.artifact.lock.runtime_contract.numeric_user,
              }),
            )
          : result("", 1, "No such image");
      }
    }
    throw new Error(`unexpected Docker argv: ${argv.join(" ")}`);
  }
}

describe("Phase 15 locked Docker acquisition", () => {
  it("denies an unlisted artifact before the first Docker command", async () => {
    const artifact = await loadBuiltInDockerArtifact(
      BUILT_IN_DOCKER_ARTIFACT_ID,
    );
    const port = new FakeDockerPort(artifact);
    const acquirer = new DockerArtifactAcquirer(port, {}, "win32");

    await expect(
      acquirer.status({ artifactId: "model-provided-image", policy: await policy() }),
    ).rejects.toMatchObject({ code: "policy_docker_artifact_denied", exitCode: 2 });
    expect(port.calls).toEqual([]);
  });

  it("rejects remote Docker overrides before daemon inspection", async () => {
    const artifact = await loadBuiltInDockerArtifact(
      BUILT_IN_DOCKER_ARTIFACT_ID,
    );
    const port = new FakeDockerPort(artifact);
    const acquirer = new DockerArtifactAcquirer(
      port,
      { DOCKER_HOST: "tcp://remote.example:2375" },
      "win32",
    );

    await expect(
      acquirer.status({
        artifactId: BUILT_IN_DOCKER_ARTIFACT_ID,
        policy: await policy(),
      }),
    ).rejects.toMatchObject({ code: "docker_remote_override_denied", exitCode: 2 });
    expect(port.calls).toEqual([]);
  });

  it("builds only the hashed package context and returns immutable execution identity", async () => {
    const artifact = await loadBuiltInDockerArtifact(
      BUILT_IN_DOCKER_ARTIFACT_ID,
    );
    const port = new FakeDockerPort(artifact);
    const acquirer = new DockerArtifactAcquirer(port, {}, "win32");
    const prepared = await acquirer.prepare({
      artifactId: BUILT_IN_DOCKER_ARTIFACT_ID,
      policy: await policy(),
      source: "build",
    });

    expect(prepared).toMatchObject({
      artifactReady: true,
      builds: 1,
      outcome: "built",
      registryAccesses: 0,
      registryCredentialReads: 0,
      pushes: 0,
      remoteBuilds: 0,
    });
    expect(prepared.executionConfig?.imageIdentity).toMatchObject({
      artifactLockSha256: artifact.lockSha256,
      configImageId: `sha256:${"a".repeat(64)}`,
      contextManifestSha256: artifact.lock.build.context_manifest_sha256,
      dockerfileSha256: artifact.lock.build.dockerfile_sha256,
      kind: "trusted_local_build",
    });
    expect(port.buildArgv).toEqual(
      expect.arrayContaining([
        "--pull=false",
        "--network=none",
        "--file",
        artifact.dockerfilePath,
        artifact.contextDirectory,
      ]),
    );
    expect(port.buildArgv).not.toEqual(
      expect.arrayContaining(["--push", "--ssh", "--secret"]),
    );
  });
});
