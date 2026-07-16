import {
  DEFAULT_BEACON_CONFIG,
  type BeaconConfig,
} from "./config.js";

export function loadBeaconConfig(
  env: Readonly<Record<string, string | undefined>>,
): BeaconConfig {
  const requestedRetries = Number(env.BEACON_RETRY_LIMIT);
  return {
    channel: env.BEACON_CHANNEL?.trim() || DEFAULT_BEACON_CONFIG.channel,
    retryLimit:
      Number.isSafeInteger(requestedRetries) && requestedRetries > 0
        ? requestedRetries
        : DEFAULT_BEACON_CONFIG.retryLimit,
  };
}
