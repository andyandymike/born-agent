process.stdout.write("stdout-1-你好\n");
process.stderr.write("stderr-1-世界\n");
setTimeout(() => {
  process.stdout.write("\u001b[31mstdout-2\u001b[0m\n");
  process.stderr.write("stderr-2\rreplaced\n");
}, 10);

