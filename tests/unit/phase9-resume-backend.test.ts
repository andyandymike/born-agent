import { describe, expect, it } from "vitest";

import {
  assertCheckpointBackendCompatibility,
  BackendCheckpointCompatibilityError,
  type BackendCheckpointCodec,
} from "../../src/model/backend-resume.js";
import {
  BackendContinuation,
  type BackendIdentity,
} from "../../src/model/model-backend.js";

class FakeContinuation extends BackendContinuation {
  constructor(readonly value: string) {
    super();
  }
}

const identity: BackendIdentity = {
  adapter: "fake-adapter",
  adapterVersion: "1.0.0",
  configFingerprint: "a".repeat(64),
  model: "fake-model",
  provider: "ollama",
};

const codec: BackendCheckpointCodec = {
  codecVersion: "fake-v1",
  provider: "ollama",
  decode: async (bytes, selectedIdentity) => {
    expect(selectedIdentity).toEqual(identity);
    return new FakeContinuation(new TextDecoder().decode(bytes));
  },
  encode: async (continuation) => {
    if (!(continuation instanceof FakeContinuation)) {
      throw new TypeError("wrong fake continuation");
    }
    return new TextEncoder().encode(continuation.value);
  },
};

describe("Phase 9 backend resume contract", () => {
  it("round-trips opaque continuation bytes only through its codec", async () => {
    const bytes = await codec.encode(new FakeContinuation("opaque-fixture"));
    const decoded = await codec.decode(bytes, identity);

    expect(decoded).toBeInstanceOf(FakeContinuation);
    expect((decoded as FakeContinuation).value).toBe("opaque-fixture");
    expect(() => JSON.stringify(decoded)).toThrow("opaque");
  });

  it.each([
    ["provider", { provider: "openai" }, "checkpoint_provider_mismatch"],
    ["model", { model: "other" }, "checkpoint_model_mismatch"],
    ["codec", { codecVersion: "fake-v2" }, "checkpoint_codec_mismatch"],
  ] as const)("rejects a %s mismatch before decoding", (_name, override, code) => {
    expect(() =>
      assertCheckpointBackendCompatibility(
        {
          codecVersion: "fake-v1",
          model: "fake-model",
          provider: "ollama",
          ...override,
        },
        identity,
        codec,
      ),
    ).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("uses a stable compatibility error type", () => {
    const error = new BackendCheckpointCompatibilityError(
      "checkpoint_codec_mismatch",
      "fixture",
    );
    expect(error).toBeInstanceOf(Error);
  });
});
