#!/usr/bin/env node
/* istanbul ignore file -- live merge requires repository-scoped GitHub auth */
import { execFileSync, spawnSync } from "node:child_process";
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

// The exact-head check deliberately uses three independent GitHub views.  A local
// gate record alone is never merge authority.
execFileSync("/opt/piw/bin/piw-gate-check", [pr], { stdio: "inherit" });
execFileSync("gh", ["pr", "ready", pr, "-R", repository], { stdio: "inherit" });
const merged = spawnSync(
  "gh",
  ["pr", "merge", pr, "-R", repository, "--squash", "--match-head-commit", record.sha],
  { stdio: "inherit" },
);
if (merged.status !== 0) {
  const undone = spawnSync("gh", ["pr", "ready", pr, "-R", repository, "--undo"], {
    stdio: "inherit",
  });
  if (undone.status !== 0) console.error("ERROR: merge failed and restoring draft state failed");
  else console.error("REFUSE: merge failed; PR restored to draft");
  process.exit(merged.status ?? 1);
}
