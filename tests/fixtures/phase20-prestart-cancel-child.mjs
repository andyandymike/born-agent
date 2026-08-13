// A real child process that deliberately stays before the authenticated
// handshake. Phase 21 cancellation tests use it to prove that a durable typed
// request closes the admitted pre-effect prefix without inventing a child run
// or receipt. The fallback prevents a failed test from leaking the process.
if (typeof process.send !== "function") process.exit(92);

const fallback = setTimeout(() => process.exit(91), 30_000);
fallback.unref();
process.on("message", () => undefined);
process.on("disconnect", () => process.exit(90));
setInterval(() => undefined, 1_000).unref();
