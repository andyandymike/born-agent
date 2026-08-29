import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { EM_R1_MODEL_ID, EM_R1_MODEL_REVISION } from "./experiment-schema.js";

interface TensorLike {
  readonly data: ArrayLike<bigint | number>;
  readonly dims: readonly number[];
}

interface TokenizerLike {
  (text: string, options: Readonly<{
    readonly max_length: number;
    readonly padding: boolean;
    readonly truncation: boolean;
  }>): Readonly<{
    readonly attention_mask: TensorLike;
    readonly input_ids: TensorLike;
  }>;
}

interface ExtractorLike {
  (texts: string | readonly string[], options: Readonly<{
    readonly normalize: true;
    readonly pooling: "mean";
  }>): Promise<TensorLike>;
  readonly tokenizer: TokenizerLike;
  dispose(): Promise<void>;
}

interface TransformersModuleLike {
  readonly env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
  };
  pipeline(
    task: "feature-extraction",
    model: string,
    options: Readonly<{
      readonly cache_dir: string;
      readonly dtype: "q8";
      readonly local_files_only: true;
      readonly revision: string;
    }>,
  ): Promise<unknown>;
}

interface ModelFileIdentity {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}

interface RehydrationManifest {
  readonly artifactBytes: number;
  readonly artifactSelection: "q8_model_quantized_onnx";
  readonly files: readonly ModelFileIdentity[];
  readonly modelArtifactManifestSha256: string;
  readonly reimplementationConfounded: boolean;
  readonly revision: typeof EM_R1_MODEL_REVISION;
  readonly runtimeModelId: typeof EM_R1_MODEL_ID;
}

export interface EmbeddingBatch {
  readonly durationMs: number;
  readonly vectors: readonly Float32Array[];
}

export interface TokenizationObservation {
  readonly attentionMask: readonly number[];
  readonly inputIds: readonly number[];
}

export interface LocalEmbeddingPort {
  readonly dimensions: 384;
  readonly modelArtifactManifestSha256: string;
  embed(inputs: readonly string[]): Promise<EmbeddingBatch>;
  tokenize(input: string): TokenizationObservation;
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeVector(source: ArrayLike<bigint | number>): Float32Array {
  if (source.length !== 384) throw new Error(`EM-R1 embedding dimension ${source.length} is not 384`);
  const vector = new Float32Array(384);
  let normSquared = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = Number(source[index]);
    if (!Number.isFinite(value)) throw new Error("EM-R1 embedding contains a non-finite value");
    vector[index] = value;
    normSquared += value * value;
  }
  const norm = Math.sqrt(normSquared);
  if (Math.abs(norm - 1) > 1e-3) {
    throw new Error(`EM-R1 embedding norm ${String(norm)} is outside 1 +/- 1e-3`);
  }
  return vector;
}

function numericArray(source: ArrayLike<bigint | number>): readonly number[] {
  return Object.freeze(Array.from(source, (entry) => Number(entry)));
}

export function normalizeEmR1Text(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

export function emR1QueryInput(normalizedQuery: string): string {
  return `query: ${normalizeEmR1Text(normalizedQuery)}`;
}

export function emR1PassageInput(title: string, text: string): string {
  return `passage: ${normalizeEmR1Text(title)}\n${normalizeEmR1Text(text)}`;
}

export class LocalE5EmbeddingProvider implements LocalEmbeddingPort {
  readonly dimensions = 384 as const;

  private constructor(
    private readonly extractor: ExtractorLike,
    readonly modelArtifactManifestSha256: string,
  ) {}

  static async load(labRoot: string): Promise<Readonly<{
    readonly coldLoadMs: number;
    readonly provider: LocalE5EmbeddingProvider;
    readonly reimplementationConfounded: boolean;
  }>> {
    const manifest = JSON.parse(await readFile(
      join(labRoot, "model-rehydration-manifest.json"),
      "utf8",
    )) as RehydrationManifest;
    if (
      manifest.runtimeModelId !== EM_R1_MODEL_ID ||
      manifest.revision !== EM_R1_MODEL_REVISION ||
      manifest.artifactSelection !== "q8_model_quantized_onnx"
    ) throw new Error("EM-R1 rehydration manifest does not match the pinned runtime contract");
    const cacheRoot = resolve(labRoot, ".cache", "model");
    let artifactBytes = 0;
    for (const expected of manifest.files) {
      const bytes = await readFile(resolve(cacheRoot, expected.path));
      artifactBytes += bytes.byteLength;
      if (bytes.byteLength !== expected.bytes || rawSha256(bytes) !== expected.sha256) {
        throw new Error(`EM-R1 model artifact ${expected.path} failed identity verification`);
      }
    }
    if (artifactBytes !== manifest.artifactBytes) {
      throw new Error("EM-R1 model artifact byte total does not match its manifest");
    }

    const packageName: string = "@huggingface/transformers";
    const transformers = await import(packageName) as TransformersModuleLike;
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;
    const started = performance.now();
    const loaded = await transformers.pipeline("feature-extraction", EM_R1_MODEL_ID, {
      cache_dir: cacheRoot,
      dtype: "q8",
      local_files_only: true,
      revision: EM_R1_MODEL_REVISION,
    });
    const coldLoadMs = performance.now() - started;
    return Object.freeze({
      coldLoadMs,
      provider: new LocalE5EmbeddingProvider(
        loaded as unknown as ExtractorLike,
        manifest.modelArtifactManifestSha256,
      ),
      reimplementationConfounded: manifest.reimplementationConfounded,
    });
  }

  async embed(inputs: readonly string[]): Promise<EmbeddingBatch> {
    if (inputs.length === 0) return Object.freeze({ durationMs: 0, vectors: Object.freeze([]) });
    const started = performance.now();
    const output = await this.extractor(inputs, { normalize: true, pooling: "mean" });
    const durationMs = performance.now() - started;
    if (
      output.dims.length !== 2 ||
      output.dims[0] !== inputs.length ||
      output.dims[1] !== this.dimensions ||
      output.data.length !== inputs.length * this.dimensions
    ) throw new Error(`EM-R1 batch embedding has invalid dimensions ${JSON.stringify(output.dims)}`);
    const vectors: Float32Array[] = [];
    for (let row = 0; row < inputs.length; row += 1) {
      const offset = row * this.dimensions;
      const values = Array.from(
        { length: this.dimensions },
        (_, index) => output.data[offset + index]!,
      );
      vectors.push(normalizeVector(values));
    }
    return Object.freeze({ durationMs, vectors: Object.freeze(vectors) });
  }

  tokenize(input: string): TokenizationObservation {
    const output = this.extractor.tokenizer(input, {
      max_length: 512,
      padding: false,
      truncation: true,
    });
    return Object.freeze({
      attentionMask: numericArray(output.attention_mask.data),
      inputIds: numericArray(output.input_ids.data),
    });
  }

  async dispose(): Promise<void> {
    await this.extractor.dispose();
  }
}
