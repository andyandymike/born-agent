import { createServer } from "node:net";

try {
  createServer(() => {}).listen(0, "127.0.0.1");
  process.stderr.write("network-guard-failed-open\n");
  process.exitCode = 9;
} catch (error) {
  if (error instanceof Error && error.message === "bornagent_network_denied") {
    process.stdout.write("bornagent_network_denied\n");
  } else {
    throw error;
  }
}
