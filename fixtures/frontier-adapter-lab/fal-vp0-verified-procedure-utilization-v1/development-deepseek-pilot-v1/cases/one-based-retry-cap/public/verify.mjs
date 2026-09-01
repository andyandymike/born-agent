import assert from "node:assert/strict";

import { retryDelayMs } from "./src/retry-backoff.mjs";

assert.equal(retryDelayMs(1, 100, 1_000), 100);
assert.equal(retryDelayMs(2, 100, 1_000), 200);
assert.equal(retryDelayMs(5, 100, 1_000), 1_000);
process.stdout.write("one-based retry cap verification passed\n");
