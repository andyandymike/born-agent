import assert from "node:assert/strict";

import { constrainReading } from "./src/inclusive-boundary.mjs";

assert.equal(constrainReading(-4, 0, 10), 0);
assert.equal(constrainReading(6, 0, 10), 6);
assert.equal(constrainReading(14, 0, 10), 10);
process.stdout.write("inclusive boundary verification passed\n");
