import { randomUUID } from "node:crypto";

import { PluginLifecycle } from "../../src/plugins/plugin-lifecycle.ts";

const [root, workspace, source] = process.argv.slice(2);
if (root === undefined || workspace === undefined || source === undefined) {
  process.exitCode = 2;
} else {
  const lifecycle = new PluginLifecycle({
    isProcessAlive: (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    },
    now: () => new Date().toISOString(),
    randomUUID,
    root,
    workspace,
  });
  try {
    const result = await lifecycle.install(source);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? `${error.name}:${error.message}` : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
