import OpenAI from "openai";

import {
  ChatClientError,
  type ChatClientErrorDetails,
  type ProviderErrorCategory,
} from "../../chat/errors.js";

function readProperty(object: unknown, property: string): unknown {
  return object !== null && typeof object === "object" && property in object
    ? object[property as keyof typeof object]
    : undefined;
}

function categoryForStatus(status: unknown): ProviderErrorCategory {
  if (status === 429) {
    return "rate_limit";
  }
  if (typeof status === "number" && status >= 500) {
    return "server_error";
  }
  return status === undefined ? "network" : "request_error";
}

export function mapOpenAIError(error: unknown): ChatClientError {
  const status = readProperty(error, "status");
  const details: ChatClientErrorDetails = {
    category: categoryForStatus(status),
    code: readProperty(error, "code") as string | undefined,
    requestId: (readProperty(error, "requestID") ??
      readProperty(error, "request_id")) as string | undefined,
    status: status as number | undefined,
  };

  if (error instanceof OpenAI.AuthenticationError || status === 401) {
    return new ChatClientError("authentication", details);
  }

  return new ChatClientError("provider", details);
}

