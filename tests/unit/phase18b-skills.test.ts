import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactSessionRuntime } from "../../src/artifacts/artifact-session-runtime.js";
import { canonicalJson } from "../../src/completion/canonical-json.js";
import type { DecodedRunEvent } from "../../src/events/event-decoder-registry.js";
import { SkillRuntime } from "../../src/skills/skill-runtime.js";
import { projectSkillRunSummary } from "../../src/skills/skill-run-summary.js";
import { createSkillTools } from "../../src/skills/skill-tools.js";
import {
  createTestCapabilityRoots,
  writeTestCapabilityPackage,
  writeTestSourceIndex,
} from "../phase18a-test-helpers.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000018";
const RUN_ID = "20000000-0000-4000-8000-000000000018";
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

function skillMetadata(input: {
  readonly componentId: string;
  readonly invocation: "model_allowed" | "user_only";
}) {
  return `${canonicalJson({
    component_id: input.componentId,
    context: {
      max_entry_bytes: 4096,
      max_resource_bytes: 4096,
      max_total_resource_bytes: 8192,
    },
    description: "Progressively disclosed review guidance.",
    display_name: "Review guidance",
    entry: "SKILL.md",
    invocation: input.invocation,
    kind: "skill",
    resources: [
      {
        description: "A bounded checklist.",
        media_type: "text/plain",
        path: "checklist.txt",
        resource_id: "checklist",
      },
    ],
    schema_version: 1,
  })}\n`;
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "bornagent-phase18b-skills-"));
  temporary.push(base);
  const roots = await createTestCapabilityRoots(base);
  const modelPackage = await writeTestCapabilityPackage(
    join(roots.userRoot, "model"),
    {
      componentId: "review",
      extraFiles: {
        "checklist.txt": "alpha\nβeta\ngamma\n",
        "skill.json": skillMetadata({ componentId: "review", invocation: "model_allowed" }),
      },
    },
  );
  const userPackage = await writeTestCapabilityPackage(
    join(roots.userRoot, "user"),
    {
      componentId: "private-review",
      pluginId: "acme.private",
      extraFiles: {
        "checklist.txt": "private\n",
        "skill.json": skillMetadata({ componentId: "private-review", invocation: "user_only" }),
      },
    },
  );
  await writeTestSourceIndex(join(roots.userRoot, "enablement.json"), 2, [
    { enabled: true, package: modelPackage, path: "model" },
    { enabled: true, package: userPackage, path: "user" },
  ]);
  const snapshot = await roots.platform.createSnapshot("2026-08-08T00:00:00.000Z");
  const artifactEvents: unknown[] = [];
  const artifacts = await ArtifactSessionRuntime.create({
    eventAppender: {
      appendArtifactEvent: async (_runId, event) => void artifactEvents.push(event),
    },
    events: [],
    runId: RUN_ID,
    sessionId: SESSION_ID,
    workspace: roots.workspace,
  });
  const events: Array<{ data: unknown; eventId: string; type: string }> = [];
  let counter = 0;
  const randomUUID = () => {
    counter += 1;
    return `30000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
  const runtime = new SkillRuntime({
    artifacts,
    content: roots.platform.createContentSource(snapshot),
    events: {
      append: async (type, data, eventId = randomUUID()) => {
        events.push({ data, eventId, type });
      },
    },
    randomUUID,
    recency: () => events.length,
    snapshot,
  });
  return { artifactEvents, events, modelPackage, roots, runtime, snapshot };
}

describe("Phase 18B Skills and progressive context", () => {
  it("keeps user-only Skills out of model discovery and separates opaque arguments", async () => {
    const value = await fixture();
    const page = value.runtime.listModelAllowed({ limit: 10 });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.skill_id).toContain("acme.review");
    const privateSkillId = value.snapshot.plugins
      .flatMap((plugin) => plugin.components)
      .find((component) => component.identity.pluginId === "acme.private")!
      .identity.qualifiedId;
    await expect(
      value.runtime.activateModel(privateSkillId),
    ).rejects.toMatchObject({ code: "skill_not_model_invocable" });

    const activated = await value.runtime.activateUser(
      "acme.private/private-review",
      "{{entry}}; ../../escape; $(touch impossible)",
    );
    expect(activated.status).toBe("activated");
    const context = value.runtime.contextItems();
    expect(context.map((item) => item.kind)).toEqual([
      "skill_arguments",
      "skill_entry",
    ]);
    expect(context[0]?.content).toContain("$(touch impossible)");
    expect(context[1]?.content).toContain("# Inert test skill");
    expect(context[1]?.content).not.toContain("$(touch impossible)");
  });

  it("reads only declared resources with UTF-8-safe paging and durable summaries", async () => {
    const value = await fixture();
    const skillId = value.runtime.listModelAllowed({ limit: 10 }).entries[0]!.skill_id;
    const activated = await value.runtime.activateModel(skillId);
    const activationId = String(activated.activation_id);
    const first = await value.runtime.readResource({
      activationId,
      maxBytes: 7,
      resourceId: "checklist",
    });
    expect(first).toMatchObject({ offset: 0, resource_id: "checklist", truncated: true });
    expect(Buffer.byteLength(String(first.content), "utf8")).toBeLessThanOrEqual(7);
    await expect(
      value.runtime.readResource({ activationId, offset: 7, resourceId: "checklist" }),
    ).rejects.toMatchObject({ code: "skill_resource_invalid" });
    await expect(
      value.runtime.readResource({ activationId, resourceId: "../../SKILL.md" }),
    ).rejects.toMatchObject({ code: "skill_resource_not_declared" });

    const decoded = value.events.map((event, index) => ({
      data: event.data,
      eventId: event.eventId,
      runId: RUN_ID,
      runSeq: index + 1,
      scope: "run" as const,
      sessionId: SESSION_ID,
      sessionSeq: index + 1,
      sourceSchemaVersion: 2 as const,
      timestamp: "2026-08-08T00:00:00.000Z",
      type: event.type,
    })) as DecodedRunEvent[];
    expect(projectSkillRunSummary(decoded)).toMatchObject({
      activations: [{ selectedBy: "model", status: "activated" }],
      resourceReadCount: 1,
    });
    expect(value.artifactEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("fails stale instead of hot-rebinding source bytes and registers read-only tools", async () => {
    const value = await fixture();
    const skillId = value.runtime.listModelAllowed({ limit: 10 }).entries[0]!.skill_id;
    await writeFile(
      join(value.roots.userRoot, "model", "SKILL.md"),
      "# Changed after snapshot\n",
      "utf8",
    );
    await expect(
      value.runtime.activateModel(skillId),
    ).rejects.toMatchObject({ code: "capability_snapshot_stale" });
    expect(createSkillTools(value.runtime).map((tool) => [tool.name, tool.capability])).toEqual([
      ["list_skills", "read"],
      ["use_skill", "read"],
      ["read_skill_resource", "read"],
    ]);
  });
});
