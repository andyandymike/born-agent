import { resolveLoopbackOllamaURL } from "../../security/loopback-ollama-url.js";
import { createDirectLoopbackFetch } from "../../security/direct-loopback-fetch.js";

export const DEFAULT_OLLAMA_LOCAL_CATALOG_BASE_URL =
  "http://127.0.0.1:11434";
export const OLLAMA_LOCAL_CATALOG_TIMEOUT_MS = 2_500;
const MAX_LOCAL_CATALOG_TIMEOUT_MS = 5_000;
const MAX_CATALOG_RESPONSE_BYTES = 1_048_576;

export interface OllamaLocalModelDiscovery {
  readonly digest: string;
  readonly tag: string;
}

export interface OllamaLocalCatalogRefreshRequest {
  readonly baseURL: string;
  readonly timeoutMs: number;
}

export interface OllamaLocalCatalogPort {
  refresh(
    request: OllamaLocalCatalogRefreshRequest,
  ): Promise<readonly OllamaLocalModelDiscovery[]>;
}

export type OllamaLocalCatalogErrorCode =
  | "local_catalog_http_error"
  | "local_catalog_protocol_error"
  | "local_catalog_timeout"
  | "remote_provider_forbidden_by_cost_policy";

export class OllamaLocalCatalogError extends Error {
  constructor(readonly code: OllamaLocalCatalogErrorCode) {
    super(code);
    this.name = "OllamaLocalCatalogError";
  }
}

type Fetch = typeof globalThis.fetch;

function parseCatalog(body: string): readonly OllamaLocalModelDiscovery[] {
  if (Buffer.byteLength(body, "utf8") > MAX_CATALOG_RESPONSE_BYTES) {
    throw new OllamaLocalCatalogError("local_catalog_protocol_error");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(body) as unknown;
  } catch {
    throw new OllamaLocalCatalogError("local_catalog_protocol_error");
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("models" in decoded) ||
    !Array.isArray(decoded.models)
  ) {
    throw new OllamaLocalCatalogError("local_catalog_protocol_error");
  }

  const byTag = new Map<string, string>();
  for (const item of decoded.models) {
    if (typeof item !== "object" || item === null) {
      throw new OllamaLocalCatalogError("local_catalog_protocol_error");
    }
    const candidate = item as {
      readonly digest?: unknown;
      readonly model?: unknown;
      readonly name?: unknown;
    };
    const tag =
      typeof candidate.name === "string"
        ? candidate.name
        : candidate.model;
    if (
      typeof tag !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u.test(tag) ||
      typeof candidate.digest !== "string" ||
      !/^(?:sha256:)?[a-f0-9]{64}$/u.test(candidate.digest)
    ) {
      throw new OllamaLocalCatalogError("local_catalog_protocol_error");
    }
    const previous = byTag.get(tag);
    if (previous !== undefined && previous !== candidate.digest) {
      throw new OllamaLocalCatalogError("local_catalog_protocol_error");
    }
    byTag.set(tag, candidate.digest);
  }

  return [...byTag.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tag, digest]) => ({ digest, tag }));
}

export class NodeOllamaLocalCatalogPort implements OllamaLocalCatalogPort {
  constructor(private readonly fetcher?: Fetch) {}

  async refresh(
    request: OllamaLocalCatalogRefreshRequest,
  ): Promise<readonly OllamaLocalModelDiscovery[]> {
    // PHASE15: Docker artifact acquisition is a separate capability. This port
    // can only inspect /api/tags; a missing Ollama model never authorizes pull,
    // tag substitution, or provider fallback.
    const resolved = resolveLoopbackOllamaURL(request.baseURL);
    if (!resolved.ok) {
      throw new OllamaLocalCatalogError(
        "remote_provider_forbidden_by_cost_policy",
      );
    }
    if (
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > MAX_LOCAL_CATALOG_TIMEOUT_MS
    ) {
      throw new OllamaLocalCatalogError("local_catalog_protocol_error");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      // PHASE8: local discovery is opt-in and is revalidated at the transport
      // boundary. Redirects are forbidden so /api/tags cannot escape literal
      // loopback, and no provider credential is attached to this request.
      const fetcher = this.fetcher ?? createDirectLoopbackFetch({
        allowedMethods: ["GET"],
        baseURL: resolved.value,
        path: { exact: "/api/tags" },
      });
      const response = await fetcher(
        `${resolved.value}/api/tags`,
        {
          headers: { accept: "application/json" },
          method: "GET",
          redirect: "error",
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new OllamaLocalCatalogError("local_catalog_http_error");
      }
      return parseCatalog(await response.text());
    } catch (error) {
      if (error instanceof OllamaLocalCatalogError) throw error;
      if (controller.signal.aborted) {
        throw new OllamaLocalCatalogError("local_catalog_timeout");
      }
      throw new OllamaLocalCatalogError("local_catalog_http_error");
    } finally {
      clearTimeout(timer);
    }
  }
}
