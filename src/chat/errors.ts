export type ChatClientErrorKind = "authentication" | "protocol" | "provider";
export type ProviderErrorCategory =
  | "network"
  | "rate_limit"
  | "request_error"
  | "server_error";

export interface ChatClientErrorDetails {
  readonly category?: ProviderErrorCategory | undefined;
  readonly code?: string | undefined;
  readonly requestId?: string | undefined;
  readonly status?: number | undefined;
}

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/u.test(value)
    ? value
    : undefined;
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

export class ChatClientError extends Error {
  readonly category: ProviderErrorCategory | undefined;
  readonly code: string | undefined;
  readonly kind: ChatClientErrorKind;
  readonly requestId: string | undefined;
  readonly status: number | undefined;

  constructor(kind: ChatClientErrorKind, details: ChatClientErrorDetails = {}) {
    super(kind);
    this.name = "ChatClientError";
    this.kind = kind;
    this.category = details.category;
    this.code = safeToken(details.code);
    this.requestId = safeToken(details.requestId);
    this.status = safeStatus(details.status);
  }
}

export function formatChatClientError(error: ChatClientError): string {
  const summary =
    error.kind === "authentication"
      ? "authentication failed"
      : error.kind === "protocol"
        ? "internal protocol error"
        : "provider request failed";
  const details = [
    error.category,
    error.status === undefined ? undefined : `status ${error.status}`,
    error.code === undefined ? undefined : `code ${error.code}`,
    error.requestId === undefined
      ? undefined
      : `request id ${error.requestId}`,
  ].filter((value): value is string => value !== undefined);

  return details.length === 0 ? summary : `${summary} (${details.join("; ")})`;
}
