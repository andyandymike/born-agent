import { homedir } from "node:os";
import { join } from "node:path";

import { ApplicationControlError } from "./application-errors.js";

/** PHASE21: resolve the Host-owned application authority root outside a repository. */
export function resolveControlStateRoot(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}): string {
  const explicit = input.env.BORN_CONTROL_STATE_ROOT;
  if (explicit !== undefined) {
    if (explicit.length === 0) throw new ApplicationControlError("control_identity_corrupt", "control state override is empty");
    return explicit;
  }
  if (input.platform === "win32") {
    return join(input.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "BornAgent", "application-control");
  }
  return join(input.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "bornagent", "application-control");
}
