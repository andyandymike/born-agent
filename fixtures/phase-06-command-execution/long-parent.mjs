import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(fixtureDirectory, "grandchild.mjs")], {
  shell: false,
  stdio: "ignore",
  windowsHide: true,
});
if (child.pid === undefined) {
  throw new Error("grandchild did not receive a process id");
}

const identities = { grandchildPid: child.pid, parentPid: process.pid };
if (process.argv[2]) {
  await writeFile(process.argv[2], JSON.stringify(identities), "utf8");
}
process.stdout.write(`${JSON.stringify(identities)}\n`);
setInterval(() => {}, 1000);

