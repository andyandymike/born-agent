import { createHash } from "node:crypto";

import type { ArtifactSessionRuntimeLike } from "../artifacts/artifact-session-runtime.js";
import type { ArtifactStoredReference } from "../artifacts/artifact-types.js";
import type {
  CapabilitySnapshotV1,
  FrozenCapabilityIdentity,
} from "../capabilities/capability-types.js";
import type { FrozenCapabilityContentSource } from "../capabilities/capability-platform.js";
import { CapabilityError } from "../capabilities/capability-errors.js";
import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import type {
  ContextArtifactReference,
  ContextItemInput,
  ContextJson,
} from "../context/context-item.js";
import { FrozenSkillCatalog } from "./skill-catalog.js";
import type {
  Phase18SkillRunEventData,
  Phase18SkillRunEventType,
} from "./skill-event-schema.js";
import { SkillError } from "./skill-errors.js";
import type {
  FrozenSkillCatalogEntry,
  SkillActivation,
  SkillCatalogPage,
} from "./skill-types.js";

const MAX_SELECTED_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_USER_ARGUMENT_BYTES = 32 * 1024;

export interface SkillEventAppender {
  append<TType extends Phase18SkillRunEventType>(
    type: TType,
    data: Phase18SkillRunEventData<TType>,
    eventId?: string,
  ): Promise<void>;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactReference(artifact: ArtifactStoredReference): ContextArtifactReference {
  return Object.freeze({
    artifactId: artifact.artifactId,
    bytes: artifact.bytes,
    mediaType: artifact.mediaType,
    relativeRef: artifact.objectRef,
    sha256: artifact.sha256,
  });
}

function decodeContent(
  bytes: Uint8Array,
  code: "skill_entry_invalid" | "skill_resource_invalid",
): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SkillError(code, "Skill content must be valid UTF-8", 8, { cause: error });
  }
  if (text.includes("\0")) {
    throw new SkillError(code, "Skill content cannot contain NUL bytes");
  }
  return text;
}

function contentEnvelope(input: {
  readonly content: string;
  readonly identity: FrozenCapabilityIdentity;
  readonly kind: "entry" | "resource";
  readonly resourceId?: string;
  readonly selectedBy: "model" | "user";
  readonly sha256: string;
  readonly truncated: boolean;
}): string {
  // A canonical JSON envelope is the structural boundary. Markdown headings,
  // role labels, XML closers, and terminal controls inside content cannot forge it.
  return `BORNAGENT_UNTRUSTED_SKILL_CONTENT_V1\n${canonicalJson({
    authority: "untrusted_content",
    content: input.content,
    content_sha256: input.sha256,
    identity: input.identity,
    kind: input.kind,
    ...(input.resourceId === undefined ? {} : { resource_id: input.resourceId }),
    schema_version: 1,
    selected_by: input.selectedBy,
    truncated: input.truncated,
  })}`;
}

function isUtf8Boundary(bytes: Uint8Array, offset: number): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    return true;
  } catch {
    return false;
  }
}

function boundedUtf8Slice(
  bytes: Uint8Array,
  offset: number,
  maximumBytes: number,
): { readonly bytes: Uint8Array; readonly end: number; readonly text: string } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength) {
    throw new SkillError("skill_resource_invalid", "Skill resource offset is outside the content");
  }
  if (!isUtf8Boundary(bytes, offset)) {
    throw new SkillError("skill_resource_invalid", "Skill resource offset is not a UTF-8 boundary");
  }
  let end = Math.min(bytes.byteLength, offset + maximumBytes);
  while (end > offset && !isUtf8Boundary(bytes, end)) end -= 1;
  const selected = bytes.slice(offset, end);
  return Object.freeze({
    bytes: selected,
    end,
    text: decodeContent(selected, "skill_resource_invalid"),
  });
}

function entryContext(input: {
  readonly activationId: string;
  readonly artifact: ArtifactStoredReference;
  readonly content: string;
  readonly eventId: string;
  readonly identity: FrozenCapabilityIdentity;
  readonly recency: number;
  readonly selectedBy: "model" | "user";
}): ContextItemInput {
  return Object.freeze({
    artifactRefs: Object.freeze([artifactReference(input.artifact)]),
    authority: "untrusted_content",
    content: contentEnvelope({
      content: input.content,
      identity: input.identity,
      kind: "entry",
      selectedBy: input.selectedBy,
      sha256: input.artifact.sha256,
      truncated: false,
    }),
    kind: "skill_entry",
    metadata: {
      activation_id: input.activationId,
      artifact_id: input.artifact.artifactId,
      identity: input.identity as unknown as ContextJson,
      selected_by: input.selectedBy,
    },
    priority: "high",
    recency: input.recency,
    role: "system",
    sourceEventIds: [input.eventId],
    visibility: "provider_context",
  });
}

function argumentsContext(input: {
  readonly activationId: string;
  readonly artifact: ArtifactStoredReference;
  readonly argumentsValue: string;
  readonly eventId: string;
  readonly identity: FrozenCapabilityIdentity;
  readonly recency: number;
}): ContextItemInput {
  // PHASE18: Skill arguments stay opaque user data. They are never template,
  // path, URL, resource ID, or shell interpolation input.
  return Object.freeze({
    artifactRefs: Object.freeze([artifactReference(input.artifact)]),
    authority: "authoritative",
    content: `BORNAGENT_SKILL_USER_ARGUMENTS_V1\n${canonicalJson({
      activation_id: input.activationId,
      arguments: input.argumentsValue,
      identity: input.identity,
      schema_version: 1,
    })}`,
    kind: "skill_arguments",
    metadata: {
      activation_id: input.activationId,
      artifact_id: input.artifact.artifactId,
      identity: input.identity as unknown as ContextJson,
    },
    priority: "critical",
    protectedCategory: "user_instruction",
    recency: input.recency,
    role: "user",
    sourceEventIds: [input.eventId],
    visibility: "provider_context",
  });
}

export class SkillRuntime {
  readonly catalog: FrozenSkillCatalog;
  readonly #activations = new Map<string, SkillActivation>();
  readonly #activationKeys = new Map<string, string>();
  readonly #resourceContexts: ContextItemInput[] = [];
  readonly #resourceBytes = new Map<string, number>();
  #selectedBytes = 0;

  constructor(
    private readonly options: {
      readonly artifacts: ArtifactSessionRuntimeLike;
      readonly content: FrozenCapabilityContentSource;
      readonly events: SkillEventAppender;
      readonly randomUUID: () => string;
      readonly recency: () => number;
      readonly snapshot: CapabilitySnapshotV1;
    },
  ) {
    this.catalog = new FrozenSkillCatalog(options.snapshot, () => this.activeSkillIds());
  }

  activeSkillIds(): ReadonlySet<string> {
    return new Set([...this.#activations.values()].map((entry) => entry.identity.qualifiedId));
  }

  contextItems(): readonly ContextItemInput[] {
    return Object.freeze([
      ...[...this.#activations.values()].flatMap((activation) => [
        ...(activation.userArgumentsContext === undefined
          ? []
          : [activation.userArgumentsContext]),
        activation.entryContext,
      ]),
      ...this.#resourceContexts,
    ]);
  }

  listModelAllowed(input: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly query?: string;
  }): SkillCatalogPage {
    return this.catalog.listModelAllowed({
      ...input,
      activeSkillIds: this.activeSkillIds(),
    });
  }

  async activateModel(skillId: string): Promise<Readonly<Record<string, unknown>>> {
    const entry = this.catalog.exact(skillId);
    if (entry.invocation !== "model_allowed") {
      throw new SkillError(
        "skill_not_model_invocable",
        "Skill is not model-invocable in the frozen run catalog",
      );
    }
    return this.activate(entry, "model", "");
  }

  async activateUser(
    selector: string,
    userArguments = "",
  ): Promise<Readonly<Record<string, unknown>>> {
    if (Buffer.byteLength(userArguments, "utf8") > MAX_USER_ARGUMENT_BYTES || userArguments.includes("\0")) {
      throw new SkillError("skill_entry_invalid", "Skill user arguments exceed their bounded text contract", 2);
    }
    return this.activate(this.catalog.resolveUserSelector(selector), "user", userArguments);
  }

  private async activate(
    entry: FrozenSkillCatalogEntry,
    selectedBy: "model" | "user",
    userArguments: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const argumentsSha256 = sha256(userArguments);
    const activationKey = sha256Canonical({
      arguments_sha256: argumentsSha256,
      skill_id: entry.identity.qualifiedId,
    });
    const existingId = this.#activationKeys.get(activationKey);
    if (existingId !== undefined) {
      return Object.freeze({
        activation_id: existingId,
        skill_id: entry.identity.qualifiedId,
        status: "already_active",
      });
    }
    const activationId = this.options.randomUUID();
    const requestedEventId = this.options.randomUUID();
    const argumentsArtifactId = userArguments.length === 0
      ? undefined
      : `sha256:${argumentsSha256}` as const;
    await this.options.events.append(
      "skill.activation.requested",
      {
        activation_id: activationId,
        selected_by: selectedBy,
        skill_identity: { ...entry.identity, kind: "skill" },
        ...(argumentsArtifactId === undefined
          ? {}
          : {
              user_arguments_artifact_id: argumentsArtifactId,
              user_arguments_sha256: argumentsSha256,
            }),
      },
      requestedEventId,
    );

    try {
      let userArgumentsArtifact: ArtifactStoredReference | undefined;
      if (userArguments.length > 0) {
        userArgumentsArtifact = await this.options.artifacts.materializeText({
          bytes: Buffer.from(userArguments, "utf8"),
          expectedSha256: argumentsSha256,
          mediaType: "text/plain; charset=utf-8",
          originEventId: requestedEventId,
        });
      }
      const content = await this.options.content.readComponentFile(
        entry.identity,
        entry.metadata.entry,
      );
      if (
        content.mediaType !== "text/markdown; charset=utf-8" ||
        content.bytes.byteLength > entry.metadata.context.max_entry_bytes
      ) {
        throw new SkillError("skill_entry_invalid", "Skill entry violates its frozen media or byte budget");
      }
      const text = decodeContent(content.bytes, "skill_entry_invalid");
      if (this.#selectedBytes + content.bytes.byteLength > MAX_SELECTED_SKILL_BYTES) {
        throw new SkillError("skill_context_limit_exceeded", "selected Skill content exceeds 2 MiB");
      }
      const artifact = await this.options.artifacts.materializeText({
        bytes: content.bytes,
        expectedSha256: content.sha256,
        mediaType: "text/markdown; charset=utf-8",
        originEventId: requestedEventId,
      });
      const resourceCatalogSha256 = sha256Canonical({
        resources: entry.metadata.resources ?? [],
        schema_version: 1,
      });
      const activatedEventId = this.options.randomUUID();
      await this.options.events.append(
        "skill.activated",
        {
          activation_id: activationId,
          byte_length: content.bytes.byteLength,
          content_artifact_id: artifact.artifactId,
          content_sha256: artifact.sha256,
          resource_catalog_sha256: resourceCatalogSha256,
        },
        activatedEventId,
      );
      const recency = this.options.recency();
      const activation: SkillActivation = Object.freeze({
        activationId,
        content: text,
        contentArtifact: artifact,
        contentSha256: artifact.sha256,
        entryContext: entryContext({
          activationId,
          artifact,
          content: text,
          eventId: activatedEventId,
          identity: entry.identity,
          recency,
          selectedBy,
        }),
        identity: entry.identity,
        resourceCatalogSha256,
        selectedBy,
        userArguments,
        ...(userArgumentsArtifact === undefined
          ? {}
          : {
              userArgumentsArtifact,
              userArgumentsContext: argumentsContext({
                activationId,
                artifact: userArgumentsArtifact,
                argumentsValue: userArguments,
                eventId: activatedEventId,
                identity: entry.identity,
                recency,
              }),
            }),
      });
      this.#activations.set(activationId, activation);
      this.#activationKeys.set(activationKey, activationId);
      this.#selectedBytes += content.bytes.byteLength;
      return Object.freeze({
        activation_id: activationId,
        byte_length: content.bytes.byteLength,
        content_artifact_id: artifact.artifactId,
        resource_catalog: Object.freeze((entry.metadata.resources ?? []).map((resource) => ({
          description: resource.description,
          media_type: resource.media_type,
          resource_id: resource.resource_id,
        }))),
        resource_catalog_sha256: resourceCatalogSha256,
        selected_by: selectedBy,
        skill_id: entry.identity.qualifiedId,
        status: "activated",
      });
    } catch (error) {
      await this.options.events.append("skill.activation.failed", {
        activation_id: activationId,
        code:
          error instanceof SkillError || error instanceof CapabilityError
            ? error.code
            : "skill_activation_incomplete",
        detail_sha256: sha256(error instanceof Error ? error.message : "unknown"),
      });
      if (error instanceof SkillError || error instanceof CapabilityError) throw error;
      throw new SkillError(
        "skill_activation_incomplete",
        "Skill activation could not be completed durably",
        8,
        { cause: error },
      );
    }
  }

  async readResource(input: {
    readonly activationId: string;
    readonly maxBytes?: number;
    readonly offset?: number;
    readonly resourceId: string;
  }): Promise<Readonly<Record<string, unknown>>> {
    const activation = this.#activations.get(input.activationId);
    if (activation === undefined) {
      throw new SkillError("skill_not_available", "Skill activation is not active in this run", 8);
    }
    const entry = this.catalog.exact(activation.identity.qualifiedId);
    // PHASE18: resource selection accepts only a declaration ID from an active
    // Skill. Raw paths can never cross this content boundary.
    const declared = entry.metadata.resources?.find(
      (resource) => resource.resource_id === input.resourceId,
    );
    if (declared === undefined) {
      throw new SkillError(
        "skill_resource_not_declared",
        "Skill resource ID is not declared by this activation",
      );
    }
    const maximum = input.maxBytes ?? Math.min(64 * 1024, entry.metadata.context.max_resource_bytes);
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > entry.metadata.context.max_resource_bytes
    ) {
      throw new SkillError("skill_resource_invalid", "Skill resource max_bytes is invalid");
    }
    const content = await this.options.content.readComponentFile(
      activation.identity,
      declared.path,
    );
    if (content.bytes.byteLength > entry.metadata.context.max_resource_bytes) {
      throw new SkillError("skill_resource_invalid", "Skill resource exceeds its declared byte budget");
    }
    const expectedMedia = `${declared.media_type}; charset=utf-8`;
    if (content.mediaType !== expectedMedia) {
      throw new SkillError("skill_resource_invalid", "Skill resource media type does not match its declaration");
    }
    decodeContent(content.bytes, "skill_resource_invalid");
    const firstRead = !this.#resourceBytes.has(`${activation.activationId}:${declared.resource_id}`);
    if (firstRead) {
      const activationResourceBytes = [...this.#resourceBytes.entries()]
        .filter(([key]) => key.startsWith(`${activation.activationId}:`))
        .reduce((total, [, bytes]) => total + bytes, 0);
      if (
        activationResourceBytes + content.bytes.byteLength >
          entry.metadata.context.max_total_resource_bytes ||
        this.#selectedBytes + content.bytes.byteLength > MAX_SELECTED_SKILL_BYTES
      ) {
        throw new SkillError("skill_context_limit_exceeded", "Skill resource selection exceeds its total budget");
      }
    }
    const selected = boundedUtf8Slice(content.bytes, input.offset ?? 0, maximum);
    const readEventId = this.options.randomUUID();
    const artifact = await this.options.artifacts.materializeText({
      bytes: selected.bytes,
      expectedSha256: sha256(selected.bytes),
      mediaType: declared.media_type === "text/markdown"
        ? "text/markdown; charset=utf-8"
        : "text/plain; charset=utf-8",
      originEventId: readEventId,
    });
    const truncated = selected.end < content.bytes.byteLength;
    await this.options.events.append(
      "skill.resource.read",
      {
        activation_id: activation.activationId,
        byte_length: selected.bytes.byteLength,
        content_artifact_id: artifact.artifactId,
        content_sha256: artifact.sha256,
        end_offset: selected.end,
        full_content_sha256: content.sha256,
        next_offset: truncated ? selected.end : null,
        offset: input.offset ?? 0,
        read_id: readEventId,
        resource_id: declared.resource_id,
        total_bytes: content.bytes.byteLength,
        truncated,
      },
      readEventId,
    );
    if (firstRead) {
      this.#resourceBytes.set(
        `${activation.activationId}:${declared.resource_id}`,
        content.bytes.byteLength,
      );
      this.#selectedBytes += content.bytes.byteLength;
    }
    this.#resourceContexts.push(Object.freeze({
      artifactRefs: Object.freeze([artifactReference(artifact)]),
      authority: "untrusted_content",
      content: contentEnvelope({
        content: selected.text,
        identity: activation.identity,
        kind: "resource",
        resourceId: declared.resource_id,
        selectedBy: activation.selectedBy,
        sha256: content.sha256,
        truncated,
      }),
      kind: "skill_resource",
      metadata: {
        activation_id: activation.activationId,
        artifact_id: artifact.artifactId,
        full_content_sha256: content.sha256,
        next_offset: truncated ? selected.end : null,
        resource_id: declared.resource_id,
        truncated,
      },
      priority: "normal",
      recency: this.options.recency(),
      role: "system",
      sourceEventIds: [readEventId],
      visibility: "provider_context",
    }));
    return Object.freeze({
      activation_id: activation.activationId,
      content: selected.text,
      content_artifact_id: artifact.artifactId,
      content_sha256: content.sha256,
      next_offset: truncated ? selected.end : null,
      offset: input.offset ?? 0,
      resource_id: declared.resource_id,
      total_bytes: content.bytes.byteLength,
      truncated,
    });
  }
}
