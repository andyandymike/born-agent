import { sha256Canonical } from "../completion/canonical-json.js";
import { ApplicationControlError } from "./application-errors.js";
import type { AuthenticatedCallContextV1, PrincipalContextV1 } from "./application-protocol.js";

export class LocalOwnerPrincipalAuthority {
  readonly localPolicySha256: string;

  constructor(
    private readonly current: PrincipalContextV1,
    readonly scopes: readonly string[],
  ) {
    this.localPolicySha256 = sha256Canonical({
      grant_sha256: current.grantSha256,
      mode: "phase21a_local_owner",
      principal_id: current.principalId,
      schema_version: 1,
      scopes: [...scopes].sort(),
    });
  }

  authenticate(context: AuthenticatedCallContextV1): PrincipalContextV1 {
    if (
      context.principal.principalId !== this.current.principalId ||
      context.principal.authenticationId !== this.current.authenticationId ||
      context.principal.grantRevision !== this.current.grantRevision ||
      context.principal.grantSha256 !== this.current.grantSha256 ||
      context.principal.kind !== "human" ||
      !["cli", "tui"].includes(context.surface.surface)
    ) {
      throw new ApplicationControlError("control_authentication_failed", "application caller is not the current local owner");
    }
    return this.current;
  }
}

