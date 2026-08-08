let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
JSON.parse(input);
process.stdout.write(JSON.stringify({ schema_version: 1, status: "observed", artifacts: [] }));
