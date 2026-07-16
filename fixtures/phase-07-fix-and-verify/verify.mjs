import assert from "node:assert/strict";

import { clamp } from "./src/clamp.mjs";

assert.equal(clamp(12, 0, 10), 10);
assert.equal(clamp(-2, 0, 10), 0);
assert.equal(clamp(4, 0, 10), 4);
process.stdout.write("phase7 clamp verification passed\n");
