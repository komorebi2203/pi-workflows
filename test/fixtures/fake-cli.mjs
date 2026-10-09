#!/usr/bin/env node
const mode = process.argv[2];
if (mode === "success") {
  process.stdout.write(`${JSON.stringify({ answer: "fake-cli" })}\n`);
} else if (mode === "quota") {
  process.stderr.write("usage limit reached\n");
  process.exitCode = 1;
} else {
  process.stderr.write("ordinary failure\n");
  process.exitCode = 1;
}
