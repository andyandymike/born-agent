import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalJson } from "../../src/completion/canonical-json.js";
import { Ml1MemoryService } from "../../src/memory/product/memory-service.js";
import type { Ml1EpisodeRecordV1 } from "../../src/memory/core/ml1-episode-record.js";
import { SqliteEpisodeStore } from "../../src/memory/store/sqlite-episode-store.js";

const [action, stateRoot, workspace] = process.argv.slice(2);
if (action === undefined || stateRoot === undefined || workspace === undefined) {
  throw new TypeError("usage: agent-memory-ml1-process <write|read> <state-root> <workspace>");
}
const manifest = JSON.parse(await readFile(
  resolve("fixtures/agent-memory/ml1/manifest.json"),
  "utf8",
)) as { readonly expectedRecord: Ml1EpisodeRecordV1 };
const expected = manifest.expectedRecord;
const store = await SqliteEpisodeStore.create({ stateRoot });
try {
  const service = new Ml1MemoryService({
    repositoryId: expected.scope.applicationRepositoryId,
    scope: expected.scope,
    store,
    workspace,
  });
  if (action === "write") {
    const result = await service.ingestCompletedRun(expected.source.sessionId, expected.source.runId);
    process.stdout.write(`${canonicalJson(result)}\n`);
  } else if (action === "read") {
    const view = await service.show(expected.recordId);
    process.stdout.write(`${canonicalJson(view)}\n`);
  } else {
    throw new TypeError("unknown ML1 process fixture action");
  }
} finally {
  store.close();
}
