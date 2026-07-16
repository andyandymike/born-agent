import { loadBeaconConfig } from "./loader.js";

export function beaconLabel(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const config = loadBeaconConfig(env);
  return `channel=${config.channel};retries=${config.retryLimit}`;
}
