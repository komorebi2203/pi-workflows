#!/usr/bin/env node
/* istanbul ignore file -- live merge requires repository-scoped GitHub auth */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DEFAULT_REPO, gatePath, loadRepos, requireRepo } from "./repos.js";

const repository = process.argv[2] ?? "";
const pr = process.argv[3] ?? "";
if (!/^\d+$/u.test(pr ?? "")) {
  console.error("usage: piw-merge REPO PR_NUMBER");
  process.exit(2);
}
try {
  requireRepo(loadRepos(), repository);
} catch {
  console.error("REFUSE: repo-not-allowed");
  process.exit(1);
}

let record: { sha?: string; repo?: string; repository?: string };
try {
  let path = gatePath(repository, pr);
  try {
    readFileSync(path);
  } catch {
    if (repository === DEFAULT_REPO)
      path = `${process.env.PIW_GATE_ROOT ?? "/srv/piw/state/gates"}/pr-${pr}.json`;
  }
  record = JSON.parse(readFileSync(path, "utf8")) as typeof record;
} catch {
  console.error(`REFUSE: no gate record for PR ${pr}`);
  process.exit(1);
}
if (!record.sha) {
  console.error(`REFUSE: no gate SHA for PR ${pr}`);
  process.exit(1);
}
if ((record.repo ?? record.repository) !== repository) {
  console.error("REFUSE: gate repo mismatch");
  process.exit(1);
}

// The exact-head check deliberately uses three independent GitHub views.  A local
// gate record alone is never merge authority.
execFileSync("/opt/piw/bin/piw-gate-check", [repository, pr], { stdio: "inherit" });
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
