import { describe, expect, it, vi } from "vitest";

import { NodeOllamaLocalCatalogPort } from "../../src/providers/pi/ollama-local-catalog-port.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

describe("NodeOllamaLocalCatalogPort", () => {
  it("requests only literal-loopback /api/tags and normalizes the result", async () => {
    const fetcher = vi.fn(
      async (
        _input: Parameters<typeof fetch>[0],
        _init?: Parameters<typeof fetch>[1],
      ) => {
        void _input;
        void _init;
        return new Response(
          JSON.stringify({
            models: [
              { digest: digestB, name: "z-model:2b" },
              { digest: digestA, model: "a-model:1b" },
            ],
          }),
          { status: 200 },
        );
      },
    );
    const port = new NodeOllamaLocalCatalogPort(fetcher as typeof fetch);

    await expect(
      port.refresh({
        baseURL: "http://localhost:11434",
        timeoutMs: 100,
      }),
    ).resolves.toEqual([
      { digest: digestA, tag: "a-model:1b" },
      { digest: digestB, tag: "z-model:2b" },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:11434/api/tags",
    );
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "error",
      }),
    );
    expect(
      JSON.stringify(fetcher.mock.calls[0]?.[1]),
    ).not.toContain("authorization");
  });

  it.each([
    "http://ollama.example:11434",
    "http://localhost:11434/v1",
    "https://localhost:11434",
  ])("rejects %s before fetch", async (baseURL) => {
    const fetcher = vi.fn(async () => new Response("{}"));
    const port = new NodeOllamaLocalCatalogPort(fetcher as typeof fetch);

    await expect(
      port.refresh({ baseURL, timeoutMs: 100 }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "remote_provider_forbidden_by_cost_policy",
      }),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed local catalog evidence", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          models: [{ digest: "not-a-digest", name: "qwen3:1.7b" }],
        }),
        { status: 200 },
      ),
    );
    const port = new NodeOllamaLocalCatalogPort(fetcher as typeof fetch);

    await expect(
      port.refresh({
        baseURL: "http://127.0.0.1:11434",
        timeoutMs: 100,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "local_catalog_protocol_error" }),
    );
  });

  it("maps an aborted fake request to a stable timeout", async () => {
    const fetcher = vi.fn(
      async (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("fake request aborted")),
            { once: true },
          );
        }),
    );
    const port = new NodeOllamaLocalCatalogPort(fetcher as typeof fetch);

    await expect(
      port.refresh({
        baseURL: "http://[::1]:11434",
        timeoutMs: 1,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "local_catalog_timeout" }),
    );
  });
});
