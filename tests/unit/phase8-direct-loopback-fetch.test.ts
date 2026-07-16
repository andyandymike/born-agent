import { EventEmitter } from "node:events";
import type {
  ClientRequest,
  IncomingMessage,
  request as NodeHttpRequest,
} from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  captureFetchForSynchronousFactory,
  createDirectLoopbackFetch,
} from "../../src/security/direct-loopback-fetch.js";

function fakeHttpRequest(status: number) {
  const observed: unknown[] = [];
  const request = vi.fn((options: unknown, callback: (message: IncomingMessage) => void) => {
    observed.push(options);
    const incoming = Readable.from([]) as unknown as IncomingMessage;
    Object.assign(incoming, {
      rawHeaders: [] as string[],
      statusCode: status,
      statusMessage: status === 200 ? "OK" : "Found",
    });
    const outgoing = new EventEmitter() as unknown as ClientRequest;
    outgoing.end = (() => {
      callback(incoming);
      return outgoing;
    }) as ClientRequest["end"];
    return outgoing;
  });
  return { observed, request };
}

describe("Phase 8 direct loopback fetch", () => {
  it("rejects a remote URL before opening a request", async () => {
    const fake = fakeHttpRequest(200);
    const fetcher = createDirectLoopbackFetch(
      {
        allowedMethods: ["POST"],
        baseURL: "http://localhost:11434",
        path: { prefix: "/v1/" },
      },
      fake.request as unknown as typeof NodeHttpRequest,
    );

    await expect(
      fetcher("https://api.openai.com/v1/chat/completions", { method: "POST" }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "loopback_policy_violation",
      }),
    );
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("uses a numeric direct connection and refuses redirects", async () => {
    const fake = fakeHttpRequest(302);
    const fetcher = createDirectLoopbackFetch(
      {
        allowedMethods: ["POST"],
        baseURL: "http://localhost:11434",
        path: { prefix: "/v1/" },
      },
      fake.request as unknown as typeof NodeHttpRequest,
    );

    await expect(
      fetcher("http://127.0.0.1:11434/v1/chat/completions", {
        body: "{}",
        method: "POST",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "loopback_http_error",
      }),
    );
    expect(fake.observed).toEqual([
      expect.objectContaining({
        agent: false,
        hostname: "127.0.0.1",
        port: 11434,
        protocol: "http:",
      }),
    ]);
  });

  it("lets an SDK constructor capture the guarded fetch and restores global state", () => {
    const guarded = vi.fn() as unknown as typeof globalThis.fetch;
    const previous = globalThis.fetch;
    const captured = captureFetchForSynchronousFactory(
      guarded,
      () => globalThis.fetch,
    );
    expect(captured).toBe(guarded);
    expect(globalThis.fetch).toBe(previous);
  });
});
