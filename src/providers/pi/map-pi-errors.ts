import type {
  ProviderFailure,
  ProviderFailureCategory,
} from "../../model/provider-failure.js";
import type { PiRuntimeError } from "./pi-runtime-port.js";

function requestId(value: string | undefined): string | undefined {
  return value !== undefined && /^[A-Za-z0-9._:-]{1,200}$/u.test(value)
    ? value
    : undefined;
}

function categoryFor(
  error: PiRuntimeError,
  aborted: boolean,
): ProviderFailureCategory {
  if (aborted) return "cancelled";
  const code = error.code?.toLowerCase() ?? "";
  const message = error.message.toLowerCase();
  if (
    error.status === 401 ||
    /auth|api[_ -]?key|unauthoriz/u.test(code) ||
    /authentication|api key|unauthoriz/u.test(message)
  ) {
    return "authentication";
  }
  if (
    error.status === 403 ||
    /forbidden|permission/u.test(code) ||
    /forbidden|permission denied/u.test(message)
  ) {
    return "permission";
  }
  if (
    error.status === 404 ||
    /model[_ -]?not[_ -]?found/u.test(code) ||
    /model (?:was )?not found/u.test(message)
  ) {
    return "model_not_found";
  }
  if (
    /quota|insufficient[_ -]?credits|billing[_ -]?limit/u.test(code) ||
    /quota|insufficient credits|billing limit/u.test(message)
  ) {
    return "quota";
  }
  if (
    error.status === 429 ||
    /rate[_ -]?limit/u.test(code) ||
    /rate limit/u.test(message)
  ) {
    return "rate_limit";
  }
  if (
    error.status === 408 ||
    /timeout|timed[_ -]?out|etimedout/u.test(code) ||
    /timed out|timeout/u.test(message)
  ) {
    return "timeout";
  }
  if (
    /network|econn|enotfound|fetch[_ -]?failed|socket/u.test(code) ||
    /network|connection|socket|fetch failed/u.test(message) ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return "network";
  }
  if (
    error.status === 400 ||
    error.status === 422 ||
    /invalid[_ -]?request/u.test(code) ||
    /invalid request/u.test(message)
  ) {
    return "invalid_request";
  }
  return "protocol";
}

const MESSAGES: Readonly<Record<ProviderFailureCategory, string>> = {
  authentication: "provider authentication failed",
  cancelled: "provider request was cancelled",
  invalid_request: "provider rejected the request",
  model_not_found: "configured model was not found",
  network: "provider network request failed",
  permission: "provider denied this request",
  protocol: "provider returned an invalid or unsupported response",
  quota: "provider quota is unavailable",
  rate_limit: "provider rate limit was reached",
  timeout: "provider request timed out",
};

export function mapPiError(
  error: PiRuntimeError,
  options: { readonly aborted: boolean; readonly protocolCode?: string },
): ProviderFailure {
  const category = categoryFor(error, options.aborted);
  const providerRequestId = requestId(error.providerRequestId);
  const status =
    error.status !== undefined &&
    Number.isInteger(error.status) &&
    error.status >= 100 &&
    error.status <= 599
      ? error.status
      : undefined;
  return {
    category,
    code:
      options.protocolCode ??
      (category === "cancelled" ? "request_cancelled" : `provider_${category}`),
    message: MESSAGES[category],
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    retryable: category === "network" || category === "rate_limit" || category === "timeout",
    ...(status === undefined ? {} : { status }),
  };
}

export function piProtocolFailure(code: string): ProviderFailure {
  return mapPiError(
    { message: code },
    { aborted: false, protocolCode: code },
  );
}
