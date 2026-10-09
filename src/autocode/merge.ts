#!/usr/bin/env node
/* istanbul ignore file -- live merge requires repository-scoped GitHub auth */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const repository = "komorebi2203/autocode-sandbox";
const pr = process.argv[2];
if (!/^\d+$/u.test(pr ?? "")) {
  console.error("usage: piw-merge PR_NUMBER");
  process.exit(2);
}
if (pr === undefined) throw new Error("unreachable: validated PR number is missing");

let record: { sha?: string };
try {
  record = JSON.parse(readFileSync(`/srv/piw/state/gates/pr-${pr}.json`, "utf8")) as {
    sha?: string;
  };
} catch {
  console.error(`REFUSE: no gate record for PR ${pr}`);
  process.exit(1);
}
if (!record.sha) {
  console.error(`REFUSE: no gate SHA for PR ${pr}`);
  process.exit(1);
}

execFileSync(
  "gh",
  ["pr", "merge", pr, "-R", repository, "--squash", "--match-head-commit", record.sha],
  { stdio: "inherit" },
);
