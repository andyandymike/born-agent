// A real Node process used only by Phase 20 recovery integration tests. It
// deliberately never authenticates the IPC handshake, then exits on its own if
// the parent-side bounded process-tree cleanup is unavailable in a sandbox.
if (typeof process.send !== "function") process.exit(92);

const fallback = setTimeout(() => process.exit(91), 500);
fallback.unref();
process.on("message", () => undefined);
process.on("disconnect", () => process.exit(90));
setInterval(() => undefined, 100).unref();
