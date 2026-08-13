import { sha256Canonical } from "../completion/canonical-json.js";
import { z } from "zod";
import { parseStrictJson } from "../system/strict-json.js";

import {
  applicationActionTargetV1Schema,
  artifactReferenceV1Schema,
  type PreparedActionV1,
  type ApplicationActionTargetV1,
  type ArtifactReferenceV1,
  type ResourceScopeV1,
} from "./application-protocol.js";
import type { ControlArtifactStore } from "./control-artifact-store.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const actionDisplayArtifactV1Schema = z.object({
  actionKind: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u),
  displaySha256: sha256Schema,
  effectPreviewRefs: z.array(artifactReferenceV1Schema).max(128),
  policyRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  policySha256: sha256Schema,
  preparedActionId: z.string().uuid(),
  principalScope: z.string().min(1).max(256),
  schemaVersion: z.literal(1),
  summary: z.string().min(1).max(16_384),
  target: applicationActionTargetV1Schema,
  targetIdentity: z.unknown(),
  warnings: z.array(z.string().max(4_096)).max(128),
}).strict().superRefine((value, context) => {
  const { displaySha256, ...content } = value;
  if (sha256Canonical(content) !== displaySha256) {
    context.addIssue({ code: "custom", message: "action display hash mismatch" });
  }
});

export type ActionDisplayArtifactV1 = Readonly<z.infer<typeof actionDisplayArtifactV1Schema>>;

export class ActionDisplayBuilder {
  constructor(private readonly artifacts: ControlArtifactStore) {}

  async build(input: {
    readonly actionKind: string;
    readonly policyRevision: number;
    readonly policySha256: string;
    readonly preparedActionId: string;
    readonly principalScope: string;
    readonly resourceScope: ResourceScopeV1;
    readonly summary: string;
    readonly target: ApplicationActionTargetV1;
    readonly targetIdentity: unknown;
    readonly warnings: readonly string[];
  }): Promise<{
    readonly artifact: ArtifactReferenceV1;
    readonly display: ActionDisplayArtifactV1;
  }> {
    const content = {
      actionKind: input.actionKind,
      effectPreviewRefs: Object.freeze([]) as readonly ArtifactReferenceV1[],
      policyRevision: input.policyRevision,
      policySha256: input.policySha256,
      preparedActionId: input.preparedActionId,
      principalScope: input.principalScope,
      schemaVersion: 1 as const,
      summary: input.summary,
      target: input.target,
      targetIdentity: input.targetIdentity,
      warnings: Object.freeze([...input.warnings]),
    };
    const display = Object.freeze(actionDisplayArtifactV1Schema.parse({
      ...content,
      displaySha256: sha256Canonical(content),
    }));
    const record = await this.artifacts.storeJson({
      createdByOperationId: null,
      resourceScope: input.resourceScope,
      transportVisibility: "resource_authorized",
      value: display,
    });
    return Object.freeze({
      artifact: this.artifacts.reference({
        disclosure: "content_authorized",
        disclosureProfileSha256: input.policySha256,
        record,
      }),
      display,
    });
  }

  async readAndVerify(prepared: PreparedActionV1): Promise<ActionDisplayArtifactV1> {
    const artifact = await this.artifacts.readVerified({
      artifactId: prepared.displayArtifact.artifactId,
      expectedResourceScope: prepared.displayArtifact.resourceScope,
      maximumBytes: 128 * 1024,
    });
    let value: unknown;
    try {
      value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes));
    } catch (error) {
      throw new TypeError("prepared display artifact is not JSON", { cause: error });
    }
    const display = actionDisplayArtifactV1Schema.parse(value);
    if (
      display.displaySha256 !== prepared.displaySha256 ||
      display.preparedActionId !== prepared.preparedActionId ||
      display.actionKind !== prepared.actionKind ||
      display.principalScope !== prepared.principalId ||
      display.policyRevision !== prepared.policyRevision ||
      display.policySha256 !== prepared.policySha256 ||
      sha256Canonical(display.target) !== sha256Canonical(prepared.target) ||
      sha256Canonical(display.targetIdentity) !== prepared.targetIdentitySha256
    ) {
      throw new TypeError("prepared display does not exact-match its action binding");
    }
    return Object.freeze(display);
  }
}
