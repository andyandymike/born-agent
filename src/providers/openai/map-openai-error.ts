import OpenAI from "openai";

import type {
  ProviderFailure,
  ProviderFailureCategory,
} from "../../chat/stream-types.js";

function readProperty(object: unknown, property: string): unknown {
  return object !== null && typeof object === "object" && property in object
    ? object[property as keyof typeof object]
    : undefined;
}

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/u.test(value)
    ? value
    : undefined;
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function categoryFor(
  status: number | undefined,
  code: string | undefined,
  network: boolean,
): ProviderFailureCategory {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (code?.toLowerCase().includes("quota") === true) {
    return "quota";
  }
  if (status === 429 || code?.toLowerCase().includes("rate_limit") === true) {
    return "rate_limit";
  }
  if (network || status === undefined) {
    return "network";
  }
  return "provider";
}

function normalizedCode(category: ProviderFailureCategory): string {
  switch (category) {
    case "auth":
      return "authentication_failed";
    case "network":
      return "network_error";
    case "protocol":
      return "protocol_error";
    case "provider":
      return "provider_request_failed";
    case "quota":
      return "quota_exceeded";
    case "rate_limit":
      return "rate_limit_exceeded";
  }
}

function safeMessage(
  providerName: string,
  category: ProviderFailureCategory,
  status?: number,
): string {
  switch (category) {
    case "auth":
      return `${providerName} authentication failed`;
    case "network":
      return `${providerName} network request failed`;
    case "protocol":
      return `${providerName} stream protocol error`;
    case "quota":
      return `${providerName} quota exceeded`;
    case "rate_limit":
      return `${providerName} rate limit exceeded`;
    case "provider":
      return status === undefined
        ? `${providerName} request failed`
        : `${providerName} request failed (HTTP ${status})`;
  }
}

export function createProviderFailure(
  category: ProviderFailureCategory,
  providerName: string,
  details: {
    readonly providerRequestId?: string;
    readonly status?: number;
  } = {},
): ProviderFailure {
  return {
    category,
    code: normalizedCode(category),
    message: safeMessage(providerName, category, details.status),
    ...(details.providerRequestId === undefined
      ? {}
      : { providerRequestId: details.providerRequestId }),
    retryable:
      category === "network" ||
      category === "rate_limit" ||
      (category === "provider" &&
        details.status !== undefined &&
        details.status >= 500),
    ...(details.status === undefined ? {} : { status: details.status }),
  };
}

export function mapOpenAIError(
  error: unknown,
  providerName = "OpenAI",
): ProviderFailure {
  const status = safeStatus(readProperty(error, "status"));
  const code = safeToken(readProperty(error, "code"));
  const requestId = safeToken(
    readProperty(error, "requestID") ?? readProperty(error, "request_id"),
  );
  const network =
    error instanceof OpenAI.APIConnectionError ||
    readProperty(error, "name") === "APIConnectionError";
  const category = categoryFor(status, code, network);
  return createProviderFailure(category, providerName, {
    ...(requestId === undefined ? {} : { providerRequestId: requestId }),
    ...(status === undefined ? {} : { status }),
  });
}

export function mapOpenAIResponseFailure(
  code: string | null | undefined,
  providerName = "OpenAI",
): ProviderFailure {
  const safeCode = safeToken(code);
  const category = categoryFor(500, safeCode, false);
  return createProviderFailure(category, providerName, { status: 500 });
}
