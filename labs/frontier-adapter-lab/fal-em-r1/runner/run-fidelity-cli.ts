import { resolve } from "node:path";

import { replayHistoricalEm1 } from "../src/fidelity-replay.js";
import { LocalE5EmbeddingProvider } from "../src/local-e5-provider.js";

const repositoryRoot = process.cwd();
const labRoot = resolve(repositoryRoot, "labs/frontier-adapter-lab/fal-em-r1");
const loaded = await LocalE5EmbeddingProvider.load(labRoot);
try {
  const result = await replayHistoricalEm1({
    retainedRoot: resolve(labRoot, ".cache/evidence/fidelity"),
    provider: loaded.provider,
    repositoryRoot,
  });
  process.stdout.write(`${JSON.stringify({
    ...result,
    reimplementationConfounded: loaded.reimplementationConfounded,
  }, null, 2)}\n`);
} finally {
  await loaded.provider.dispose();
}
