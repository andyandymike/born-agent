import {
  mkdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_PLAN_FILE_BYTES,
  PlanFileLoader,
} from "../../src/plans/plan-file-loader.js";
import {
  cleanupTemporaryWorkspaces,
  temporaryWorkspace,
} from "./phase16b-test-helpers.js";

afterEach(cleanupTemporaryWorkspaces);

const valid = JSON.stringify({
  items: [
    {
      acceptance: "It passes.",
      id: "implement",
      required: true,
      title: "Implement",
    },
  ],
  schema_version: 1,
  title: "Plan",
});

describe("Phase 16B strict Plan file loader", () => {
  it("loads only the strict user-editable schema", async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(join(workspace, "plan.json"), valid, "utf8");

    await expect(new PlanFileLoader().load(workspace, "plan.json")).resolves.toEqual({
      items: [
        {
          acceptance: "It passes.",
          id: "implement",
          required: true,
          title: "Implement",
        },
      ],
      schema_version: 1,
      title: "Plan",
    });
  });

  it("rejects duplicate keys, authority fields, invalid UTF-8, and oversize files", async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(
      join(workspace, "duplicate.json"),
      '{"schema_version":1,"title":"A","title":"B","items":[]}',
      "utf8",
    );
    await writeFile(
      join(workspace, "authority.json"),
      JSON.stringify({ ...JSON.parse(valid), plan_id: "forged" }),
      "utf8",
    );
    await writeFile(
      join(workspace, "invalid-utf8.json"),
      Buffer.from([0xff, 0xfe]),
    );
    await writeFile(
      join(workspace, "oversize.json"),
      Buffer.alloc(MAX_PLAN_FILE_BYTES + 1, 0x20),
    );
    const loader = new PlanFileLoader();

    await expect(loader.load(workspace, "duplicate.json")).rejects.toMatchObject({
      code: "plan_file_invalid",
    });
    await expect(loader.load(workspace, "authority.json")).rejects.toMatchObject({
      code: "plan_file_invalid",
    });
    await expect(loader.load(workspace, "invalid-utf8.json")).rejects.toMatchObject({
      code: "plan_file_invalid_utf8",
    });
    await expect(loader.load(workspace, "oversize.json")).rejects.toMatchObject({
      code: "plan_file_too_large",
    });
  });

  it("rejects absolute, escape, and non-file paths", async () => {
    const workspace = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    await writeFile(join(outside, "plan.json"), valid, "utf8");
    await mkdir(join(workspace, "directory"));
    const loader = new PlanFileLoader();

    await expect(loader.load(workspace, join(outside, "plan.json"))).rejects.toMatchObject({
      code: "plan_file_outside_workspace",
    });
    await expect(loader.load(workspace, "../plan.json")).rejects.toMatchObject({
      code: "plan_file_outside_workspace",
    });
    await expect(loader.load(workspace, "directory")).rejects.toMatchObject({
      code: "plan_file_not_regular",
    });
  });
});
