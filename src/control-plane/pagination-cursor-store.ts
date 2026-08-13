import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import { ApplicationControlError } from "./application-errors.js";
import {
  applicationPaginationCursorV1Schema,
  expectedResourceVersionV1Schema,
  resourceScopeSha256,
  resourceScopeV1Schema,
  type ApplicationPaginationCursorV1,
  type AuthenticatedCallContextV1,
  type ExpectedResourceVersionV1,
  type ResourceScopeV1,
} from "./application-protocol.js";
import type { ControlStatePaths } from "./control-state-paths.js";
import { createPrivateJsonIfAbsent, isMissing, readBoundedPrivateJson } from "./durable-control-file.js";

const bindingContentSchema = z.object({
  afterItemIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  cursorId: z.string().uuid(),
  cursorKind: z.string().min(1).max(128),
  disclosureProfileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  expiresAt: z.string().datetime({ offset: true }),
  grantSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  issuedAt: z.string().datetime({ offset: true }),
  maximumItems: z.number().int().positive().max(10_000),
  nextOffset: z.number().int().nonnegative().max(1_000_000),
  principalId: z.string().min(1).max(256),
  queryKind: z.string().min(1).max(128),
  redactionProfileId: z.string().min(1).max(128),
  requestPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  resourceScope: resourceScopeV1Schema,
  resourceVersion: expectedResourceVersionV1Schema,
  schemaVersion: z.literal(1),
  snapshotIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

const bindingSchema = bindingContentSchema.extend({
  bindingSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().superRefine((value, context) => {
  const { bindingSha256, ...content } = value;
  if (sha256Canonical(content) !== bindingSha256) {
    context.addIssue({ code: "custom", message: "pagination binding hash mismatch" });
  }
});

export type ApplicationPaginationCursorBindingV1 = Readonly<z.infer<typeof bindingSchema>>;

function authenticator(key: Uint8Array, cursorId: string, bindingSha256: string): string {
  return `pg_v1_${createHmac("sha256", key).update(canonicalJson({
    binding_sha256: bindingSha256,
    cursor_id: cursorId,
    schema_version: 1,
  }), "utf8").digest("base64url")}`;
}

export class PaginationCursorStore {
  constructor(
    private readonly integrityKey: Uint8Array,
    private readonly paths: ControlStatePaths,
  ) {
    if (integrityKey.byteLength !== 32) throw new TypeError("pagination cursor key must be 32 bytes");
  }

  async mint(input: Omit<ApplicationPaginationCursorBindingV1, "bindingSha256" | "cursorId" | "schemaVersion">): Promise<{
    readonly binding: ApplicationPaginationCursorBindingV1;
    readonly cursor: ApplicationPaginationCursorV1;
  }> {
    const content = bindingContentSchema.parse({
      ...input,
      cursorId: randomUUID(),
      schemaVersion: 1,
    });
    const binding = Object.freeze(bindingSchema.parse({
      ...content,
      bindingSha256: sha256Canonical(content),
    }));
    const result = await createPrivateJsonIfAbsent({
      paths: this.paths,
      target: join(this.paths.cursorRoot, `${binding.cursorId}.json`),
      value: binding,
    });
    if (result !== "created") throw new ApplicationControlError("control_operation_busy", "pagination cursor ID collision");
    return Object.freeze({
      binding,
      cursor: Object.freeze(applicationPaginationCursorV1Schema.parse({
        cursorAuthenticator: authenticator(this.integrityKey, binding.cursorId, binding.bindingSha256),
        cursorId: binding.cursorId,
        schemaVersion: 1,
      })),
    });
  }

  async validate(input: {
    readonly call: AuthenticatedCallContextV1;
    readonly cursor: ApplicationPaginationCursorV1;
    readonly disclosureProfileSha256: string;
    readonly exactVersion: ExpectedResourceVersionV1;
    readonly now: Date;
    readonly payloadSha256: string;
    readonly queryKind: string;
    readonly redactionProfileId: string;
    readonly resourceScope: ResourceScopeV1;
  }): Promise<ApplicationPaginationCursorBindingV1> {
    let binding: ApplicationPaginationCursorBindingV1;
    try {
      binding = bindingSchema.parse(
        await readBoundedPrivateJson(join(this.paths.cursorRoot, `${input.cursor.cursorId}.json`), 32 * 1024),
      );
    } catch (error) {
      if (isMissing(error) || isMissing((error as ErrorOptions).cause)) {
        throw new ApplicationControlError("control_resync_required", "pagination cursor is unavailable");
      }
      throw new ApplicationControlError("control_resync_required", "pagination cursor is corrupt", { cause: error });
    }
    const expectedAuthenticator = Buffer.from(authenticator(this.integrityKey, binding.cursorId, binding.bindingSha256));
    const actualAuthenticator = Buffer.from(input.cursor.cursorAuthenticator);
    if (
      expectedAuthenticator.byteLength !== actualAuthenticator.byteLength ||
      !timingSafeEqual(expectedAuthenticator, actualAuthenticator) ||
      binding.principalId !== input.call.principal.principalId ||
      binding.grantSha256 !== input.call.principal.grantSha256 ||
      binding.queryKind !== input.queryKind ||
      binding.redactionProfileId !== input.redactionProfileId ||
      binding.disclosureProfileSha256 !== input.disclosureProfileSha256 ||
      binding.requestPayloadSha256 !== input.payloadSha256 ||
      resourceScopeSha256(binding.resourceScope) !== resourceScopeSha256(input.resourceScope) ||
      sha256Canonical(binding.resourceVersion) !== sha256Canonical(input.exactVersion) ||
      Date.parse(binding.expiresAt) <= input.now.getTime()
    ) {
      throw new ApplicationControlError("control_resync_required", "pagination cursor does not match this authorized snapshot");
    }
    return Object.freeze(binding);
  }
}

