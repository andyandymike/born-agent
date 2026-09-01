import assert from "node:assert/strict";

import { pageWindow } from "./src/page-window.mjs";

assert.deepEqual(pageWindow(0, 3, 8), { start: 0, endExclusive: 3 });
assert.deepEqual(pageWindow(2, 3, 8), { start: 6, endExclusive: 8 });
assert.deepEqual(pageWindow(3, 3, 8), { start: 8, endExclusive: 8 });
process.stdout.write("end-exclusive page window verification passed\n");
