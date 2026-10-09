#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ALLOWED_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
export type CiSnapshot = {
  runs: Array<{ status?: string; conclusion?: string | null }>;
  statuses: Array<{ state?: string }>;
};
export type CiResult =
  | { green: true; runCount: number }
  | { green: false; reason: "ci-failed" | "ci-missing" };

export function evaluateCi(snapshot: CiSnapshot): "green" | "pending" | "ci-failed" | "ci-missing" {
  if (snapshot.statuses.some(({ state }) => state === "failure" || state === "error"))
    return "ci-failed";
  if (snapshot.runs.length === 0) return "ci-missing";
  if (snapshot.runs.some(({ status }) => status !== "completed")) return "pending";
  return snapshot.runs.every(({ conclusion }) => ALLOWED_CONCLUSIONS.has(conclusion ?? ""))
    ? "green"
    : "ci-failed";
}

export function readCi(repository: string, sha: string): CiSnapshot {
  const runs = JSON.parse(
    execFileSync(
      "gh",
      ["api", `repos/${repository}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`],
      { encoding: "utf8" },
    ),
  ) as { workflow_runs?: CiSnapshot["runs"] };
  const statuses = JSON.parse(
    execFileSync("gh", ["api", `repos/${repository}/commits/${sha}/status`], {
      encoding: "utf8",
    }),
  ) as { statuses?: CiSnapshot["statuses"] };
  return { runs: runs.workflow_runs ?? [], statuses: statuses.statuses ?? [] };
}

export async function waitForCi(
  repository: string,
  sha: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    read?: () => CiSnapshot;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<CiResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const intervalMs = options.intervalMs ?? 10_000;
  const read = options.read ?? (() => readCi(repository, sha));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = read();
    const state = evaluateCi(snapshot);
    if (state === "green") return { green: true, runCount: snapshot.runs.length };
    if (state === "ci-failed") return { green: false, reason: state };
    if (Date.now() >= deadline)
      return { green: false, reason: state === "ci-missing" ? state : "ci-failed" };
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

function usage(): never {
  console.error("usage: piw-ci-wait REPOSITORY HEAD_SHA");
  process.exit(2);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [repository, sha, ...rest] = argv;
  if (
    !repository ||
    !/^[\w.-]+\/[\w.-]+$/u.test(repository) ||
    !sha ||
    !/^[0-9a-f]{40}$/u.test(sha) ||
    rest.length
  )
    usage();
  const timeoutMinutes = Number(process.env.PIW_CI_WAIT_MINUTES ?? "10");
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 0)
    throw new Error("invalid PIW_CI_WAIT_MINUTES");
  const result = await waitForCi(repository, sha, { timeoutMs: timeoutMinutes * 60_000 });
  if (!result.green) {
    console.error(result.reason);
    process.exitCode = 1;
    return;
  }
  console.log(`ci-green runs=${result.runCount} sha=${sha}`);
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
