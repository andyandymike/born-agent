import assert from "node:assert/strict";

import { clamp } from "../src/core/clamp.mjs";
import { formatClamp } from "../src/ui/format.mjs";

assert.equal(clamp(12, 0, 10), 10);
assert.equal(clamp(-2, 0, 10), 0);
assert.equal(formatClamp(10), "clamped:10");
