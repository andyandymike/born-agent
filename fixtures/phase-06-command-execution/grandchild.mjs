process.on("SIGTERM", () => {
  // Remain alive so the executor's force-kill path is exercised on POSIX.
});
setInterval(() => {}, 1000);

