import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { pipeline } from "@huggingface/transformers";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const MODEL_ID = "Xenova/multilingual-e5-small";
const REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const HISTORICAL_MANIFEST = "eb54f2a0fc3b5a2608f4c43b404e10bf4da856b9b405e48ff27fcecaeef55141";
const labRoot = resolve(import.meta.dirname, "..");
const cacheRoot = resolve(labRoot, ".cache", "model");
const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (proxy !== undefined && proxy.length > 0) {
  setGlobalDispatcher(new ProxyAgent(proxy));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function inventory(directory, base = directory) {
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const details = await stat(path);
    if (details.isDirectory()) {
      entries.push(...await inventory(path, base));
      continue;
    }
    if (!details.isFile()) continue;
    const bytes = await readFile(path);
    entries.push({
      path: relative(base, path).replaceAll("\\", "/"),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  return entries;
}

const started = performance.now();
const extractor = await pipeline("feature-extraction", MODEL_ID, {
  cache_dir: cacheRoot,
  dtype: "q8",
  local_files_only: false,
  revision: REVISION,
});
const loadedMs = performance.now() - started;
const probe = await extractor("query: local embedding rehydration probe", {
  normalize: true,
  pooling: "mean",
});
if (probe.dims.length !== 2 || probe.dims[0] !== 1 || probe.dims[1] !== 384) {
  throw new Error(`unexpected probe dimensions: ${JSON.stringify(probe.dims)}`);
}
await extractor.dispose();

const files = await inventory(cacheRoot);
const artifactBytes = files.reduce((total, entry) => total + entry.bytes, 0);
const logical = {
  schemaVersion: 2,
  experimentId: "fal-em-r1-selective-hybrid-v2",
  package: "@huggingface/transformers@3.3.3",
  packageLockSha256: sha256(await readFile(resolve(labRoot, "pnpm-lock.yaml"))),
  runtimeLicense: "Apache-2.0",
  upstreamModelId: "intfloat/multilingual-e5-small",
  upstreamModelLicense: "MIT",
  runtimeModelId: MODEL_ID,
  revision: REVISION,
  artifactSelection: "q8_model_quantized_onnx",
  cacheRetention: "retained_local_ignored_not_product_packaged",
  files,
  artifactBytes,
};
const modelArtifactManifestSha256 = sha256(canonical(logical));
process.stdout.write(`${JSON.stringify({
  ...logical,
  modelArtifactManifestSha256,
  historicalModelArtifactManifestSha256: HISTORICAL_MANIFEST,
  historicalManifestReproduced: modelArtifactManifestSha256 === HISTORICAL_MANIFEST,
  reimplementationConfounded: modelArtifactManifestSha256 !== HISTORICAL_MANIFEST,
  coldLoadObservationMs: loadedMs,
}, null, 2)}\n`);
