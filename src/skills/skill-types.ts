import type { ArtifactStoredReference } from "../artifacts/artifact-types.js";
import type {
  CapabilitySnapshotV1,
  FrozenCapabilityIdentity,
  FrozenCapabilityRecord,
} from "../capabilities/capability-types.js";
import type { ContextItemInput } from "../context/context-item.js";
import type { ParsedCapabilityComponent } from "../capabilities/plugin-manifest-schema.js";

export type FrozenSkillMetadata = Extract<
  ParsedCapabilityComponent,
  { readonly kind: "skill" }
>;

export interface FrozenSkillCatalogEntry {
  readonly active: boolean;
  readonly description: string;
  readonly displayName: string;
  readonly identity: FrozenCapabilityIdentity;
  readonly invocation: "model_allowed" | "user_only";
  readonly metadata: FrozenSkillMetadata;
  readonly record: FrozenCapabilityRecord;
  readonly resourceCount: number;
  readonly source: FrozenCapabilityIdentity["source"];
  readonly version: string;
}

export interface SkillActivation {
  readonly activationId: string;
  readonly content: string;
  readonly contentArtifact: ArtifactStoredReference;
  readonly contentSha256: string;
  readonly entryContext: ContextItemInput;
  readonly identity: FrozenCapabilityIdentity;
  readonly resourceCatalogSha256: string;
  readonly selectedBy: "model" | "user";
  readonly userArguments: string;
  readonly userArgumentsArtifact?: ArtifactStoredReference;
  readonly userArgumentsContext?: ContextItemInput;
}

export interface SkillCatalogPage {
  readonly entries: readonly Readonly<{
    active: boolean;
    description: string;
    display_name: string;
    resource_count: number;
    skill_id: string;
    source: FrozenCapabilityIdentity["source"];
    version: string;
  }>[];
  readonly next_cursor: string | null;
  readonly snapshot_id: CapabilitySnapshotV1["snapshotId"];
}
