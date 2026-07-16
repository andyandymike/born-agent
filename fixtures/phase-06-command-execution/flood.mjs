const chunk = Buffer.alloc(16 * 1024, 0x78);

function writeMore() {
  while (process.stdout.write(chunk)) {
    // Backpressure is intentionally exercised until the executor terminates us.
  }
  process.stdout.once("drain", writeMore);
}

writeMore();

