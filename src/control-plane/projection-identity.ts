import { sha256Canonical } from "../completion/canonical-json.js";
import type {
  ProjectionIdentityV1,
  SessionLedgerHeadV1,
  SessionProjectionSnapshotV1,
} from "./application-protocol.js";

export function createSessionProjectionSnapshot<TProjection>(input: {
  readonly disclosureProfileSha256: string;
  readonly ledgerHead: SessionLedgerHeadV1;
  readonly projection: TProjection;
  readonly projectorId: string;
  readonly projectorVersion: number;
}): SessionProjectionSnapshotV1<TProjection> {
  const identity: ProjectionIdentityV1 = Object.freeze({
    disclosureProfileSha256: input.disclosureProfileSha256,
    ledgerHead: input.ledgerHead,
    projectionSha256: sha256Canonical(input.projection),
    projectorId: input.projectorId,
    projectorVersion: input.projectorVersion,
    schemaVersion: 1,
    sessionId: input.ledgerHead.sessionId,
  });
  return Object.freeze({ identity, projection: input.projection });
}

