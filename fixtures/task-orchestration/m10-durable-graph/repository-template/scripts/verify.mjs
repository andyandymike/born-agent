import { mkdir, writeFile } from "node:fs/promises";

await import("../tests/fixture.test.mjs");
await mkdir(".m10-output", { recursive: true });
await writeFile(".m10-output/verification.txt", "m10 fixture verified\n", "utf8");
process.stdout.write("m10 canonical fixture verification passed\n");
