#!/usr/bin/env node
/* istanbul ignore file -- live gate verification requires repository-scoped GitHub auth */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DEFAULT_REPO, gatePath, loadRepos, repoName, requireRepo } from "./repos.js";

const repository = process.argv[2] ?? "";
const pr = process.argv[3] ?? "";
if (!/^\d+$/u.test(pr ?? "")) {
  console.error("usage: piw-gate-check REPO PR_NUMBER");
  process.exit(2);
}
try {
  requireRepo(loadRepos(), repository);
} catch {
  console.error("REFUSE: repo-not-allowed");
  process.exit(1);
}
let path = gatePath(repository, pr);
try {
  readFileSync(path);
} catch {
  if (repository === DEFAULT_REPO)
    path = `${process.env.PIW_GATE_ROOT ?? "/srv/piw/state/gates"}/pr-${pr}.json`;
}
const record = JSON.parse(readFileSync(path, "utf8")) as {
  sha?: string;
  repo?: string;
  repository?: string;
};
if ((record.repo ?? record.repository) !== repository) {
  console.error("REFUSE: gate repo mismatch");
  process.exit(1);
}
const current = JSON.parse(
  execFileSync(
    "gh",
    ["pr", "view", pr, "-R", repository, "--json", "headRefName,headRefOid,state"],
    { encoding: "utf8" },
  ),
) as { headRefName: string; headRefOid: string; state: string };
const remoteHead = execFileSync("git", ["ls-remote", "origin", `refs/pull/${pr}/head`], {
  cwd: `/srv/piw/repos/${repoName(repository)}`,
  encoding: "utf8",
})
  .trim()
  .split(/\s+/u)[0];
const branchHead = execFileSync(
  "git",
  ["ls-remote", "origin", `refs/heads/${current.headRefName}`],
  {
    cwd: `/srv/piw/repos/${repoName(repository)}`,
    encoding: "utf8",
  },
)
  .trim()
  .split(/\s+/u)[0];
if (current.state !== "OPEN") {
  console.error(`REFUSE: PR state is ${current.state}`);
  process.exit(1);
}
if (
  !record.sha ||
  !remoteHead ||
  !branchHead ||
  record.sha !== remoteHead ||
  remoteHead !== current.headRefOid ||
  current.headRefOid !== branchHead
) {
  console.error("REFUSE: SHA mismatch");
  process.exit(1);
}
console.log(`PASS: gate SHA matches PR head (${record.sha.slice(0, 12)})`);
