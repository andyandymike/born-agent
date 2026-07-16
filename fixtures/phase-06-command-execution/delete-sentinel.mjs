import { unlink } from "node:fs/promises";
import { resolve } from "node:path";

const target = process.argv[2] ?? "sentinel.txt";
await unlink(resolve(target));
process.stdout.write("sentinel-deleted\n");

