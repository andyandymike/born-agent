import { randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { ApplicationControlError } from "./application-errors.js";
import {
  hostControlIdentityV1Schema,
  principalContextV1Schema,
  type HostControlIdentityV1,
  type PrincipalContextV1,
} from "./application-protocol.js";
import { ControlStatePaths } from "./control-state-paths.js";
import {
  createPrivateFileIfAbsent,
  createPrivateJsonIfAbsent,
  isMissing,
  readBoundedPrivateBytes,
  readBoundedPrivateJson,
} from "./durable-control-file.js";

const LOCAL_SCOPES = Object.freeze([
  "artifact.metadata.read",
  "control.operation.read",
  "repository.read",
  "repository.register",
  "session.create",
  "session.mutate",
  "session.read",
] as const);

const localOwnerRecordSchema = z.object({
  principal: principalContextV1Schema.superRefine((value, context) => {
    if (value.kind !== "human" || value.principalId !== "local_owner" || value.grantRevision !== 1) {
      context.addIssue({ code: "custom", message: "local owner principal identity is invalid" });
    }
  }),
  recordSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.literal(1),
  scopes: z.array(z.enum(LOCAL_SCOPES)).length(LOCAL_SCOPES.length),
}).strict().superRefine((value, context) => {
  const { recordSha256, ...content } = value;
  if (sha256Canonical(content) !== recordSha256) {
    context.addIssue({ code: "custom", message: "local owner record hash mismatch" });
  }
  const expectedGrant = sha256Canonical({
    authentication_id: value.principal.authenticationId,
    grant_revision: 1,
    principal_id: "local_owner",
    scopes: LOCAL_SCOPES,
  });
  if (value.principal.grantSha256 !== expectedGrant) {
    context.addIssue({ code: "custom", message: "local owner grant hash mismatch" });
  }
});

export interface HostControlAuthorityV1 {
  readonly identity: HostControlIdentityV1;
  readonly integrityKey: Uint8Array;
  readonly localOwner: PrincipalContextV1;
  readonly localOwnerScopes: readonly string[];
  readonly paths: ControlStatePaths;
}

async function readIdentity(paths: ControlStatePaths): Promise<HostControlIdentityV1> {
  try {
    return Object.freeze(hostControlIdentityV1Schema.parse(await readBoundedPrivateJson(paths.hostIdentityPath, 8 * 1024)));
  } catch (error) {
    if (error instanceof ApplicationControlError) throw error;
    throw new ApplicationControlError("control_identity_corrupt", "host control identity is invalid", { cause: error });
  }
}

async function readPrincipal(paths: ControlStatePaths): Promise<z.infer<typeof localOwnerRecordSchema>> {
  try {
    return Object.freeze(localOwnerRecordSchema.parse(await readBoundedPrivateJson(paths.localPrincipalPath, 8 * 1024)));
  } catch (error) {
    if (error instanceof ApplicationControlError) throw error;
    throw new ApplicationControlError("control_identity_corrupt", "local owner principal is invalid", { cause: error });
  }
}

/** Read an already-initialized Host authority without creating missing identity material. */
export async function loadExistingHostControlAuthority(input: {
  readonly root: string;
}): Promise<HostControlAuthorityV1> {
  const paths = await ControlStatePaths.create(input.root);
  const identity = await readIdentity(paths);
  if (identity.stateRootIdentitySha256 !== paths.stateRootIdentitySha256) {
    throw new ApplicationControlError("control_identity_corrupt", "host identity belongs to a different state root");
  }
  const integrityKey = await readBoundedPrivateBytes(paths.integrityKeyPath, 32);
  if (integrityKey.byteLength !== 32) {
    throw new ApplicationControlError("control_identity_corrupt", "control integrity key has an invalid length");
  }
  const principal = await readPrincipal(paths);
  return Object.freeze({
    identity,
    integrityKey: Buffer.from(integrityKey),
    localOwner: principal.principal,
    localOwnerScopes: Object.freeze([...principal.scopes]),
    paths,
  });
}

export async function loadOrCreateHostControlAuthority(input: {
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly randomUuid?: () => string;
  readonly root: string;
}): Promise<HostControlAuthorityV1> {
  const paths = await ControlStatePaths.create(input.root);
  const makeUuid = input.randomUuid ?? randomUUID;
  const makeBytes = input.randomBytes ?? randomBytes;
  let identityMissing = false;
  try {
    await readIdentity(paths);
  } catch (error) {
    if (!isMissing((error as ErrorOptions).cause) && !isMissing(error)) throw error;
    identityMissing = true;
  }
  if (identityMissing && await paths.hasAuthorityRecords()) {
    throw new ApplicationControlError(
      "control_identity_corrupt",
      "host identity is missing while control authority records already exist",
    );
  }
  if (identityMissing) {
    const content = {
      controllerId: makeUuid(),
      revision: 1 as const,
      stateRootIdentitySha256: paths.stateRootIdentitySha256,
    };
    const identity = hostControlIdentityV1Schema.parse({
      ...content,
      identitySha256: sha256Canonical(content),
    });
    await createPrivateJsonIfAbsent({ paths, target: paths.hostIdentityPath, value: identity });
  }

  const identity = await readIdentity(paths);
  if (identity.stateRootIdentitySha256 !== paths.stateRootIdentitySha256) {
    throw new ApplicationControlError("control_identity_corrupt", "host identity belongs to a different state root");
  }

  let principalMissing = false;
  try {
    await readPrincipal(paths);
  } catch (error) {
    if (!isMissing((error as ErrorOptions).cause) && !isMissing(error)) throw error;
    principalMissing = true;
  }
  if (principalMissing && await paths.hasAuthorityRecords()) {
    throw new ApplicationControlError(
      "control_identity_corrupt",
      "local owner identity is missing while control authority records already exist",
    );
  }
  if (principalMissing) {
    const authenticationId = makeUuid();
    const grantSha256 = sha256Canonical({
      authentication_id: authenticationId,
      grant_revision: 1,
      principal_id: "local_owner",
      scopes: LOCAL_SCOPES,
    });
    const content = {
      principal: {
        authenticationId,
        grantRevision: 1,
        grantSha256,
        kind: "human" as const,
        principalId: "local_owner",
      },
      schemaVersion: 1 as const,
      scopes: LOCAL_SCOPES,
    };
    await createPrivateJsonIfAbsent({
      paths,
      target: paths.localPrincipalPath,
      value: { ...content, recordSha256: sha256Canonical(content) },
    });
  }

  let keyMissing = false;
  try {
    await readBoundedPrivateBytes(paths.integrityKeyPath, 32);
  } catch (error) {
    if (!isMissing(error) && !isMissing((error as ErrorOptions).cause)) throw error;
    keyMissing = true;
  }
  if (keyMissing && await paths.hasAuthorityRecords()) {
    throw new ApplicationControlError(
      "control_identity_corrupt",
      "control integrity key is missing while authority records already exist",
    );
  }
  if (keyMissing) {
    const bytes = makeBytes(32);
    if (bytes.byteLength !== 32) throw new TypeError("control integrity key source returned the wrong length");
    await createPrivateFileIfAbsent({ bytes, paths, target: paths.integrityKeyPath });
  }
  const integrityKey = await readBoundedPrivateBytes(paths.integrityKeyPath, 32);
  if (integrityKey.byteLength !== 32) {
    throw new ApplicationControlError("control_identity_corrupt", "control integrity key has an invalid length");
  }
  const principal = await readPrincipal(paths);
  return Object.freeze({
    identity,
    integrityKey: Buffer.from(integrityKey),
    localOwner: principal.principal,
    localOwnerScopes: Object.freeze([...principal.scopes]),
    paths,
  });
}
