import type {
  CapabilityKind,
  CapabilitySourceKind,
  FrozenCapabilityIdentity,
} from "./capability-types.js";
import { CapabilityError } from "./capability-errors.js";

const FULL_ID = /^(builtin|user_install|workspace):([a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9])){0,79})@([A-Za-z0-9](?:[A-Za-z0-9]|[._-](?=[A-Za-z0-9])){0,63})\/(skill|hook|mcp_server)\/([a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9])){0,79})#sha256:([a-f0-9]{64})$/u;

export function formatQualifiedCapabilityId(input: {
  readonly componentId: string;
  readonly componentSha256: string;
  readonly kind: CapabilityKind;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly source: CapabilitySourceKind;
}): string {
  return `${input.source}:${input.pluginId}@${input.pluginVersion}/${input.kind}/${input.componentId}#sha256:${input.componentSha256}`;
}

export function parseQualifiedCapabilityId(value: string): Readonly<{
  componentId: string;
  componentSha256: string;
  kind: CapabilityKind;
  pluginId: string;
  pluginVersion: string;
  source: CapabilitySourceKind;
}> {
  const match = FULL_ID.exec(value);
  if (match === null) {
    throw new CapabilityError(
      "capability_path_invalid",
      "capability ID must include exact source, plugin version, kind, component, and SHA-256",
    );
  }
  return Object.freeze({
    componentId: match[5]!,
    componentSha256: match[6]!,
    kind: match[4] as CapabilityKind,
    pluginId: match[2]!,
    pluginVersion: match[3]!,
    source: match[1] as CapabilitySourceKind,
  });
}

export function sameCapabilityIdentity(
  left: FrozenCapabilityIdentity,
  right: FrozenCapabilityIdentity,
): boolean {
  return left.qualifiedId === right.qualifiedId &&
    left.pluginSha256 === right.pluginSha256;
}
