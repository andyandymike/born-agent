export interface BeaconConfig {
  readonly channel: string;
  readonly retryLimit: number;
}

export const DEFAULT_BEACON_CONFIG: BeaconConfig = {
  channel: "aurora",
  retryLimit: 4,
};
