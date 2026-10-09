#!/usr/bin/env node
/* istanbul ignore file -- live gate verification requires repository-scoped GitHub auth */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const repository = "komorebi2203/autocode-sandbox";
const pr = process.argv[2];
if (!/^\d+$/u.test(pr ?? "")) {
  console.error("usage: piw-gate-check PR_NUMBER");
  process.exit(2);
}
if (pr === undefined) throw new Error("unreachable: validated PR number is missing");
const record = JSON.parse(readFileSync(`/srv/piw/state/gates/pr-${pr}.json`, "utf8")) as {
  sha?: string;
};
const current = JSON.parse(
  execFileSync(
    "gh",
    ["pr", "view", pr, "-R", repository, "--json", "headRefName,headRefOid,state"],
    { encoding: "utf8" },
  ),
) as { headRefName: string; headRefOid: string; state: string };
const remoteHead = execFileSync("git", ["ls-remote", "origin", `refs/pull/${pr}/head`], {
  cwd: "/srv/piw/repos/autocode-sandbox",
  encoding: "utf8",
})
  .trim()
  .split(/\s+/u)[0];
const branchHead = execFileSync(
  "git",
  ["ls-remote", "origin", `refs/heads/${current.headRefName}`],
  {
    cwd: "/srv/piw/repos/autocode-sandbox",
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
