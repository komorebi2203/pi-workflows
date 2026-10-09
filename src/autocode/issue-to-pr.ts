#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliStepExecutor } from "../server/cli-executor.js";
import { agent, compute, defineWorkflow } from "../workflows/definition.js";
import { WorkflowEngine } from "../workflows/engine.js";

const REPO = "komorebi2203/autocode-sandbox";
const ROOT = "/srv/piw";
type Input = { issue: number; runId: string; worktree: string; branch: string };
type Route = { route: "continue" | "retry" | "blocked"; reason?: string; detail?: string };

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function inputParser(value: unknown): Input {
  const valueInput = value as Partial<Input>;
  if (
    !Number.isSafeInteger(valueInput.issue) ||
    Number(valueInput.issue) < 1 ||
    !valueInput.runId ||
    !valueInput.worktree ||
    !valueInput.branch
  )
    throw new Error("invalid issue-to-pr input");
  return valueInput as Input;
}
function assertRouting(): void {
  const value = JSON.parse(readFileSync("/opt/piw/routing.json", "utf8")) as {
    roles?: Record<string, { executor?: string; command?: string; fallback?: unknown[] }>;
  };
  for (const role of ["plan", "implement", "review", "bulk"]) {
    const route = value.roles?.[role];
    if (!route || !["cli", "rpc"].includes(route.executor ?? "") || !Array.isArray(route.fallback))
      throw new Error(`invalid routing role ${role}`);
  }
  if (
    value.roles?.plan?.command !== "claude" ||
    value.roles?.implement?.command !== "codex" ||
    value.roles?.review?.command !== "codex"
  )
    throw new Error("invalid primary role commands");
  readFileSync("/opt/piw/claude-plugins/MANIFEST", "utf8");
}
export function changedAssertions(worktree: string): string[] {
  const diff = run(
    "git",
    [
      "diff",
      "--unified=0",
      "main",
      "--",
      "*.test.*",
      "*.spec.*",
      "test/**",
      "tests/**",
      "__tests__/**",
    ],
    worktree,
  );
  let file = "unknown";
  const found: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    if (line.startsWith("-") && !line.startsWith("---") && /\b(?:assert|expect)\s*\(/u.test(line))
      found.push(file);
  }
  return [...new Set(found)];
}

export function createIssueToPrWorkflow() {
  let verifyFailures = 0;
  let reviewFailures = 0;
  return defineWorkflow({
    source: import.meta.url,
    contractId: "pi-workflows.issue-to-pr.v1",
    name: "issue-to-pr",
    title: ({ input }) => `issue-to-pr #${(input as Input).issue}`,
    input: inputParser,
    startAt: "preflight",
    maxSteps: 24,
    nodes: {
      preflight: compute({
        statusDetail: "checking subscription credentials",
        run: () => {
          run("/opt/piw/bin/piw-preflight", ["--agent-dir", "/home/piw/.pi/agent"]);
          run("/opt/piw/bin/t6-skills-check", []);
          assertRouting();
          return { route: "continue" };
        },
      }),
      checkout: compute({
        statusDetail: "creating a fresh worktree",
        run: ({ input }) => {
          const value = input as Input;
          if (!value.worktree.startsWith(`${ROOT}/work/`))
            throw new Error("worktree escaped authorized root");
          const mirror = `${ROOT}/repos/autocode-sandbox`;
          mkdirSync(dirname(value.worktree), { recursive: true });
          if (!existsSync(join(mirror, ".git"))) run("gh", ["repo", "clone", REPO, mirror]);
          run("git", ["fetch", "origin", "main"], mirror);
          rmSync(value.worktree, { recursive: true, force: true });
          run("git", ["worktree", "prune"], mirror);
          run(
            "git",
            ["worktree", "add", "-b", value.branch, value.worktree, "origin/main"],
            mirror,
          );
          const issue = run(
            "gh",
            ["issue", "view", String(value.issue), "-R", REPO, "--json", "number,title,body,url"],
            value.worktree,
          );
          writeFileSync(join(value.worktree, ".piw-issue.json"), `${issue}\n`, { mode: 0o600 });
          return { route: "continue" };
        },
      }),
      plan: agent({
        executor: "cli",
        cli: { command: "/opt/piw/bin/piw-role", args: ["plan", "{prompt}"] },
        statusDetail: "planning from the issue",
        prompt: ({ input }) =>
          `Read issue ${(input as Input).issue} using gh issue view -R ${REPO}. Write a short implementation and verification plan. Do not change files.`,
        expectedOutput: "A short plain-text plan.",
      }),
      savePlan: compute({
        run: ({ input, outputs }) => {
          writeFileSync(join((input as Input).worktree, ".piw-plan.md"), String(outputs.plan));
          return { route: "continue" };
        },
      }),
      implement: agent({
        executor: "cli",
        cli: { command: "/opt/piw/bin/piw-role", args: ["implement", "{prompt}"] },
        timeoutMs: 45 * 60_000,
        statusDetail: "implementing",
        prompt: ({ input, outputs }) =>
          `Implement issue ${(input as Input).issue} in the current worktree. Plan:\n${String(outputs.plan)}\nInspect .piw-verify.log if present. Do not commit, push, open a PR, or modify an existing test assertion.`,
        expectedOutput: "A concise implementation summary.",
      }),
      verify: compute({
        statusDetail: "running npm test",
        run: ({ input }) => {
          const value = input as Input;
          const result = spawnSync("npm", ["test"], {
            cwd: value.worktree,
            encoding: "utf8",
            timeout: 15 * 60_000,
          });
          writeFileSync(
            join(value.worktree, ".piw-verify.log"),
            `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
            { mode: 0o600 },
          );
          if (result.status === 0) return { route: "continue" } satisfies Route;
          verifyFailures += 1;
          return verifyFailures <= 2
            ? { route: "retry", reason: "verify", detail: "npm test failed" }
            : { route: "blocked", reason: "verify" };
        },
      }),
      review: agent({
        executor: "cli",
        cli: { command: "/opt/piw/bin/piw-role", args: ["review", "{prompt}"] },
        timeoutMs: 30 * 60_000,
        statusDetail: "reviewing",
        prompt: () =>
          'Review git diff against main. Return JSON only: {"route":"continue"} if there are no P0/P1 findings, otherwise {"route":"retry","detail":"actionable findings"}. Do not edit files.',
        expectedOutput: '{ "route": "continue|retry", "detail": "optional" }',
      }),
      assessReview: compute({
        run: ({ outputs }) => {
          const result = outputs.review as Route;
          if (result?.route === "continue") return result;
          reviewFailures += 1;
          return reviewFailures <= 2
            ? { route: "retry", reason: "review", detail: result?.detail }
            : { route: "blocked", reason: "review" };
        },
      }),
      guard: compute({
        statusDetail: "guarding test assertions",
        run: ({ input }) => {
          const files = changedAssertions((input as Input).worktree);
          return files.length
            ? { route: "blocked", reason: "test-guard", detail: files.join(", ") }
            : { route: "continue" };
        },
      }),
      pr: compute({
        statusDetail: "opening the pull request",
        run: ({ input }) => {
          const value = input as Input;
          run("git", ["add", "-A"], value.worktree);
          run(
            "git",
            ["reset", "--", ".piw-issue.json", ".piw-plan.md", ".piw-verify.log"],
            value.worktree,
          );
          run("git", ["commit", "-m", `feat: resolve issue ${value.issue}`], value.worktree);
          run("git", ["push", "-u", "origin", value.branch], value.worktree);
          const url = run(
            "gh",
            [
              "pr",
              "create",
              "-R",
              REPO,
              "--head",
              value.branch,
              "--base",
              "main",
              "--title",
              `feat: resolve issue ${value.issue}`,
              "--body",
              `Closes #${value.issue}`,
            ],
            value.worktree,
          );
          return JSON.parse(
            run(
              "gh",
              ["pr", "view", url, "-R", REPO, "--json", "number,headRefOid,url"],
              value.worktree,
            ),
          ) as { number: number; headRefOid: string; url: string };
        },
      }),
      gate: compute({
        statusDetail: "waiting for CI and writing the gate",
        run: ({ input, outputs }) => {
          const value = input as Input;
          const pr = outputs.pr as { number: number; headRefOid: string; url: string };
          run(
            "gh",
            ["pr", "checks", String(pr.number), "-R", REPO, "--watch", "--fail-fast"],
            value.worktree,
          );
          const current = JSON.parse(
            run(
              "gh",
              ["pr", "view", String(pr.number), "-R", REPO, "--json", "headRefOid,state"],
              value.worktree,
            ),
          ) as { headRefOid: string; state: string };
          if (current.state !== "OPEN" || current.headRefOid !== pr.headRefOid)
            throw new Error("PR head changed before gate creation");
          const path = join(ROOT, "state", "gates", `pr-${pr.number}.json`);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(
            path,
            `${JSON.stringify({ schema: "piw.local-gate.v1", repository: REPO, issue: value.issue, pr: pr.number, sha: pr.headRefOid, status: "pending-human-merge", createdAt: new Date().toISOString() }, null, 2)}\n`,
            { mode: 0o600 },
          );
          return {
            status: "completed",
            pr: pr.number,
            url: pr.url,
            sha: pr.headRefOid,
            gate: path,
          };
        },
      }),
      blocked: compute({
        run: ({ outputs }) => {
          const candidates = [outputs.guard, outputs.assessReview, outputs.verify] as Route[];
          const reason = candidates.find((item) => item?.route === "blocked");
          return { status: "blocked", reason: reason?.reason ?? "unknown", detail: reason?.detail };
        },
      }),
    },
    edges: [
      { from: "preflight", to: "checkout" },
      { from: "checkout", to: "plan" },
      { from: "plan", to: "savePlan" },
      { from: "savePlan", to: "implement" },
      { from: "implement", to: "verify" },
      {
        from: "verify",
        switch: {
          on: "$.route",
          cases: { continue: "review", retry: "implement", blocked: "blocked" },
        },
      },
      { from: "review", to: "assessReview" },
      {
        from: "assessReview",
        switch: {
          on: "$.route",
          cases: { continue: "guard", retry: "implement", blocked: "blocked" },
        },
      },
      { from: "guard", switch: { on: "$.route", cases: { continue: "pr", blocked: "blocked" } } },
      { from: "pr", to: "gate" },
    ],
  });
}

function usage(): never {
  console.error("usage: issue-to-pr --issue NUMBER");
  process.exit(2);
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const at = argv.indexOf("--issue");
  if (at < 0 || !/^\d+$/u.test(argv[at + 1] ?? "")) usage();
  const issue = Number(argv[at + 1]);
  const runId = `${new Date()
    .toISOString()
    .replace(/[-:.TZ]/gu, "")
    .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const input: Input = {
    issue,
    runId,
    worktree: `${ROOT}/work/${runId}`,
    branch: `autocode/${issue}-${runId}`,
  };
  const engine = new WorkflowEngine({
    executor: new CliStepExecutor({ cwd: ROOT, env: { PIW_WORKTREE: input.worktree } }),
    databasePath: `${ROOT}/state/workflows.sqlite`,
    defaultNodeTimeoutMs: 60 * 60_000,
  });
  const result = await engine.run(createIssueToPrWorkflow(), input, { runId });
  console.log(
    JSON.stringify(
      { runId, workflowStatus: result.state.status, outcome: result.state.finalOutput },
      null,
      2,
    ),
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  void main().catch((error) => {
    console.error(`issue-to-pr failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
