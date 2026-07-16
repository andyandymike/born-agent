export type ProviderFailureCategory =
  | "authentication"
  | "permission"
  | "rate_limit"
  | "quota"
  | "network"
  | "timeout"
  | "invalid_request"
  | "model_not_found"
  | "protocol"
  | "cancelled";

export interface ProviderFailure {
  readonly category: ProviderFailureCategory;
  readonly code: string;
  readonly message: string;
  readonly providerRequestId?: string;
  readonly retryable: boolean;
  readonly status?: number;
}

