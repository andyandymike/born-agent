import {
  request as nodeHttpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { Readable } from "node:stream";

import { resolveLoopbackOllamaURL } from "./loopback-ollama-url.js";

type HttpRequest = typeof nodeHttpRequest;

export class DirectLoopbackFetchError extends Error {
  constructor(readonly code: "loopback_http_error" | "loopback_policy_violation") {
    super(code);
    this.name = "DirectLoopbackFetchError";
  }
}

export interface DirectLoopbackFetchPolicy {
  readonly allowedMethods: readonly string[];
  readonly baseURL: string;
  readonly path: { readonly exact: string } | { readonly prefix: string };
}

function allowedPath(
  pathname: string,
  rule: DirectLoopbackFetchPolicy["path"],
): boolean {
  return "exact" in rule ? pathname === rule.exact : pathname.startsWith(rule.prefix);
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index];
    const value = message.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

export function createDirectLoopbackFetch(
  policy: DirectLoopbackFetchPolicy,
  requestImpl: HttpRequest = nodeHttpRequest,
): typeof globalThis.fetch {
  const resolved = resolveLoopbackOllamaURL(policy.baseURL);
  if (!resolved.ok) throw new DirectLoopbackFetchError("loopback_policy_violation");
  const allowedOrigin = new URL(resolved.value).origin;
  const methods = new Set(policy.allowedMethods.map((method) => method.toUpperCase()));

  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== allowedOrigin ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0 ||
      !methods.has(request.method.toUpperCase()) ||
      !allowedPath(url.pathname, policy.path)
    ) {
      throw new DirectLoopbackFetchError("loopback_policy_violation");
    }

    const body = request.body === null
      ? undefined
      : Buffer.from(await request.arrayBuffer());
    const hostname = url.hostname === "[::1]" ? "::1" : url.hostname;
    const options: RequestOptions = {
      agent: false,
      headers: Object.fromEntries(request.headers.entries()),
      hostname,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      port: 11434,
      protocol: "http:",
      signal: request.signal,
    };

    return new Promise<Response>((resolve, reject) => {
      // PHASE8: node:http with a numeric loopback host and agent:false bypasses
      // ambient HTTP(S)_PROXY/global fetch dispatchers. It also never follows a
      // redirect, so an Ollama response cannot escape to a remote or billable host.
      const outgoing = requestImpl(options, (incoming) => {
        const status = incoming.statusCode ?? 0;
        if (status < 200 || status > 599 || (status >= 300 && status < 400)) {
          incoming.resume();
          reject(new DirectLoopbackFetchError("loopback_http_error"));
          return;
        }
        const hasBody = status !== 204 && status !== 205 && status !== 304;
        resolve(
          new Response(
            hasBody
              ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>)
              : null,
            {
              headers: responseHeaders(incoming),
              status,
              ...(incoming.statusMessage === undefined
                ? {}
                : { statusText: incoming.statusMessage }),
            },
          ),
        );
      });
      outgoing.on("error", () => {
        reject(new DirectLoopbackFetchError("loopback_http_error"));
      });
      if (body === undefined) outgoing.end();
      else outgoing.end(body);
    });
  };
}

export function captureFetchForSynchronousFactory<T>(
  fetcher: typeof globalThis.fetch,
  factory: () => T,
): T {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    // pi-ai/OpenAI captures global fetch synchronously in its SDK constructor;
    // the returned async stream keeps that captured direct-loopback function.
    return factory();
  } finally {
    globalThis.fetch = previous;
  }
}
