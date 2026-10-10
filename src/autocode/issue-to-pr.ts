#!/usr/bin/env node
/* istanbul ignore file -- live orchestration requires three external subscription logins */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliStepExecutor } from "../server/cli-executor.js";
import { agent, compute, defineWorkflow } from "../workflows/definition.js";
import { WorkflowEngine } from "../workflows/engine.js";
import type { AgentStepExecutor, AgentStepRequest } from "../workflows/types.js";
import { waitForCi } from "./ci-wait.js";
import {
  DEFAULT_REPO,
  gatePath,
  loadRepos,
  repoName,
  requireRepo,
  type RepoConfig,
} from "./repos.js";

const ROOT = "/srv/piw";
type Input = {
  repo: string;
  repoConfig: RepoConfig;
  issue?: number;
  linearIdentifier?: string;
  taskFile?: string;
  runId: string;
  worktree: string;
  branch: string;
  taskTitle?: string;
};
type Route = {
  route: "continue" | "retry" | "blocked" | "failed";
  reason?: string;
  detail?: string;
};
type TreeFingerprint = { status: string; diffHash: string };
type RunEventState = "running" | "pr" | "gate" | "blocked" | "failed" | "completed";
type RunEvent = {
  state: RunEventState;
  repo?: string;
  reason?: string;
  pr?: number;
  prUrl?: string;
  headSha?: string;
  heartbeat?: boolean;
  taskFile?: string;
  provenance?: RunProvenance;
};
type RunEventEmitter = (event: RunEvent) => void;

type StepName = "plan" | "implement" | "review";
type PromptHashes = Partial<Record<StepName, string>>;
export type RunProvenance = {
  repo: string;
  prompt_sha256: Record<StepName, string>;
  model: Record<StepName, { routing: unknown; cli_version: string }>;
  sandbox: Record<StepName | "verify", string>;
  install_argv: string[] | null;
  routing_sha256: string;
  diff_sha256: string;
  base_sha: string;
  head_sha: string;
};

export const PLAN_PROMPT =
  "Read .piw-issue.json, which contains the authorized task. Print a short implementation and verification plan as plain stdout text. Do not use or mention a workflow submission tool. Do not change files.";
export const REVIEW_PROMPT =
  'Review git diff against main. Print only stdout JSON: {"route":"continue"} if there are no P0/P1 findings, otherwise {"route":"retry","detail":"actionable findings"}. Do not use or mention a workflow submission tool. Do not edit files.';
export function implementPrompt(plan: unknown): string {
  return `Implement the task in .piw-issue.json. Plan:\n${String(plan)}\nInspect .piw-verify.log if present. Do not commit, push, open a PR, or modify an existing test assertion.`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function collectProvenance(
  worktree: string,
  promptHashes: PromptHashes,
  headSha: string,
  repo = DEFAULT_REPO,
  base = "main",
  installArgv: string[] | undefined = undefined,
): RunProvenance {
  const routingText = readFileSync("/opt/piw/routing.json", "utf8");
  const routing = JSON.parse(routingText) as {
    roles: Record<StepName, unknown>;
  };
  const policyHash = sha256(readFileSync("/opt/piw/bin/piw-plan-sandbox"));
  const verifyPolicyHash = sha256(readFileSync("/opt/piw/bin/piw-verify-sandbox"));
  const baseSha = run("git", ["rev-parse", `origin/${base}`], worktree);
  const diff = runBytes("git", ["diff", "--binary", `origin/${base}...HEAD`], worktree);
  return {
    repo,
    prompt_sha256: Object.fromEntries(
      (["plan", "implement", "review"] as const).map((step) => {
        const hash = promptHashes[step];
        if (hash === undefined) throw new Error(`missing exact prompt hash for ${step}`);
        return [step, hash];
      }),
    ) as Record<StepName, string>,
    model: {
      plan: {
        routing: routing.roles.plan,
        cli_version: run("claude", ["--version"]),
      },
      implement: {
        routing: routing.roles.implement,
        cli_version: run("codex", ["--version"]),
      },
      review: {
        routing: routing.roles.review,
        cli_version: run("codex", ["--version"]),
      },
    },
    sandbox: {
      plan: `piw-plan-sandbox policy_sha256=${policyHash}`,
      implement: "codex workspace-write",
      review: "codex read-only",
      verify: `piw-verify-sandbox policy_sha256=${verifyPolicyHash}`,
    },
    install_argv: installArgv ?? null,
    routing_sha256: sha256(routingText),
    diff_sha256: sha256(diff),
    base_sha: baseSha,
    head_sha: headSha,
  };
}

export type SandboxedCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type SpawnVerify = typeof spawnSync;

export function runVerifySandbox(
  worktree: string,
  argv: [string, ...string[]],
  shareNet = false,
  spawn: SpawnVerify = spawnSync,
): SandboxedCommandResult {
  const result = spawn(
    "/opt/piw/bin/piw-verify-sandbox",
    [...(shareNet ? ["--share-net"] : []), "--", ...argv],
    {
      cwd: worktree,
      env: { ...process.env, PIW_WORKTREE: worktree },
      encoding: "utf8",
      timeout: 15 * 60_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

export class TerminalEventGuard {
  private terminal = false;
  private fallbackReason = "crash:process exited before a terminal event";
  private readonly onExit = () => this.fail(this.fallbackReason);
  private readonly onSigterm = () => {
    this.fail("crash:SIGTERM");
    process.exit(143);
  };

  constructor(private readonly emitEvent: RunEventEmitter) {
    process.once("exit", this.onExit);
    process.once("SIGTERM", this.onSigterm);
  }

  emit(event: RunEvent): void {
    if (this.terminal) return;
    if (["blocked", "failed", "completed"].includes(event.state)) this.terminal = true;
    this.emitEvent(event);
  }

  setFallback(error: unknown): void {
    this.fallbackReason = crashReason(error);
  }

  fail(reason = this.fallbackReason): void {
    this.emit({ state: "failed", reason });
  }

  finish(): void {
    this.fail();
    process.off("exit", this.onExit);
    process.off("SIGTERM", this.onSigterm);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function crashReason(error: unknown): string {
  const message = errorMessage(error);
  return message.startsWith("issue-read:") ? "issue-read" : `crash:${message}`;
}

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function runBytes(command: string, args: string[], cwd?: string): Buffer {
  return execFileSync(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function inputParser(value: unknown): Input {
  const valueInput = value as Partial<Input>;
  if (
    (!valueInput.taskFile &&
      (!Number.isSafeInteger(valueInput.issue) || Number(valueInput.issue) < 1)) ||
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
    if (
      line.startsWith("-") &&
      !line.startsWith("---") &&
      /\b(?:assert(?:\.\w+)?|expect)\s*\(/u.test(line)
    )
      found.push(file);
  }
  return [...new Set(found)];
}

export function treeFingerprint(worktree: string): TreeFingerprint {
  const status = run("git", ["status", "--porcelain"], worktree);
  const diff = run("git", ["diff", "--binary", "HEAD"], worktree);
  return { status, diffHash: createHash("sha256").update(diff).digest("hex") };
}

export function assertReviewUnmodified(before: TreeFingerprint, after: TreeFingerprint): void {
  if (before.status !== after.status || before.diffHash !== after.diffHash)
    throw new Error("review-modified-tree: reviewer changed the worktree");
}

export function blockedOutcome(outputs: Record<string, unknown>) {
  const candidates = [outputs.guard, outputs.assessReview, outputs.verify] as Route[];
  const blocked = candidates.find((item) => item?.route === "blocked");
  return {
    status: "blocked",
    reason: blocked?.reason ?? "unknown",
    ...(blocked?.detail === undefined ? {} : { detail: blocked.detail }),
  };
}

export function settledWorkflowStatus(engineStatus: string, finalOutput: unknown): string {
  return finalOutput !== null &&
    typeof finalOutput === "object" &&
    (finalOutput as { status?: unknown }).status === "blocked"
    ? "blocked"
    : engineStatus;
}

export function createIssueToPrWorkflow(
  emit: RunEventEmitter = () => undefined,
  promptHashes: PromptHashes = {},
) {
  let verifyFailures = 0;
  let reviewFailures = 0;
  return defineWorkflow({
    source: import.meta.url,
    contractId: "pi-workflows.issue-to-pr.v1",
    name: "issue-to-pr",
    title: ({ input }) =>
      `issue-to-pr ${(input as Input).linearIdentifier ?? `#${(input as Input).issue}`}`,
    input: inputParser,
    startAt: "preflight",
    maxSteps: 24,
    nodes: {
      preflight: compute({
        statusDetail: "checking subscription credentials",
        run: () => {
          run("/opt/piw/bin/piw-preflight", ["--agent-dir", "/home/piw/.pi/agent"]);
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
          const mirror = `${ROOT}/repos/${repoName(value.repo)}`;
          mkdirSync(dirname(value.worktree), { recursive: true });
          if (!existsSync(join(mirror, ".git"))) run("gh", ["repo", "clone", value.repo, mirror]);
          run("git", ["fetch", "origin", value.repoConfig.base], mirror);
          rmSync(value.worktree, { recursive: true, force: true });
          run("git", ["worktree", "prune"], mirror);
          run(
            "git",
            [
              "worktree",
              "add",
              "-b",
              value.branch,
              value.worktree,
              `origin/${value.repoConfig.base}`,
            ],
            mirror,
          );
          run("git", ["config", "user.name", "pi-workflows"], value.worktree);
          run("git", ["config", "user.email", "pi-workflows@localhost"], value.worktree);
          let issue: string;
          if (value.taskFile) issue = readFileSync(value.taskFile, "utf8").trim();
          else {
            try {
              issue = run(
                "gh",
                [
                  "issue",
                  "view",
                  String(value.issue),
                  "-R",
                  value.repo,
                  "--json",
                  "number,title,body,url",
                ],
                value.worktree,
              );
            } catch (error) {
              throw new Error(`issue-read:${errorMessage(error)}`);
            }
          }
          writeFileSync(join(value.worktree, ".piw-issue.json"), `${issue}\n`, {
            mode: 0o600,
          });
          execFileSync("/opt/piw/bin/t6-skills-check", [], {
            cwd: value.worktree,
            env: { ...process.env, PIW_WORKTREE: value.worktree },
            stdio: ["ignore", "pipe", "pipe"],
          });
          return { route: "continue" };
        },
      }),
      plan: agent({
        executor: "cli",
        cli: { command: "/opt/piw/bin/piw-role", args: ["plan", "{prompt}"] },
        statusDetail: "planning from the issue",
        prompt: () => PLAN_PROMPT,
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
        cli: {
          command: "/opt/piw/bin/piw-role",
          args: ["implement", "{prompt}"],
        },
        timeoutMs: 45 * 60_000,
        statusDetail: "implementing",
        prompt: ({ outputs }) => implementPrompt(outputs.plan),
        expectedOutput: "A concise implementation summary.",
      }),
      verify: compute({
        statusDetail: "running repository verification",
        run: ({ input }) => {
          const value = input as Input;
          const results: SandboxedCommandResult[] = [];
          if (value.repoConfig.install)
            results.push(runVerifySandbox(value.worktree, value.repoConfig.install, true));
          if (results.every((result) => result.status === 0))
            results.push(runVerifySandbox(value.worktree, value.repoConfig.verify));
          writeFileSync(
            join(value.worktree, ".piw-verify.log"),
            results
              .map(
                (result) =>
                  `${result.stdout}\n${result.stderr}${result.error ? `\n${result.error.message}` : ""}`,
              )
              .join("\n"),
            { mode: 0o600 },
          );
          if (results.length > 0 && results.every((result) => result.status === 0))
            return { route: "continue" } satisfies Route;
          verifyFailures += 1;
          return verifyFailures <= 2
            ? {
                route: "retry",
                reason: "verify",
                detail: `${value.repoConfig.verify.join(" ")} failed`,
              }
            : { route: "blocked", reason: "verify" };
        },
      }),
      review: agent({
        executor: "cli",
        cli: { command: "/opt/piw/bin/piw-role", args: ["review", "{prompt}"] },
        timeoutMs: 30 * 60_000,
        statusDetail: "reviewing",
        prompt: () => REVIEW_PROMPT,
        expectedOutput:
          '{ "route": "continue|retry|failed", "reason": "optional", "detail": "optional" }',
      }),
      beforeReview: compute({
        run: ({ input }) => treeFingerprint((input as Input).worktree),
      }),
      assessReview: compute({
        run: ({ input, outputs }) => {
          const result = outputs.review as Route;
          const before = outputs.beforeReview as TreeFingerprint;
          const after = treeFingerprint((input as Input).worktree);
          assertReviewUnmodified(before, after);
          if (result?.route === "failed" || result?.reason === "infra")
            throw new Error(`infra: ${result?.detail ?? "reviewer could not run"}`);
          if (result?.route === "continue") return result;
          if (result?.route !== "retry")
            throw new Error("infra: reviewer did not return the stdout JSON contract");
          reviewFailures += 1;
          return reviewFailures <= 2
            ? { route: "retry", reason: "review", detail: result?.detail }
            : { route: "blocked", reason: "review" };
        },
      }),
      guard: compute({
        statusDetail: "guarding test assertions",
        run: ({ input }) => {
          const worktree = (input as Input).worktree;
          const files = changedAssertions(worktree);
          if (run("git", ["diff", "--name-only", "HEAD"], worktree) === "")
            return {
              route: "blocked",
              reason: "review",
              detail: "no implementation changes",
            };
          return files.length
            ? {
                route: "blocked",
                reason: "test-guard",
                detail: files.join(", "),
              }
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
          const taskRef = value.linearIdentifier ?? (value.issue ? `issue ${value.issue}` : "task");
          run("git", ["commit", "-m", `feat: resolve ${taskRef}`], value.worktree);
          run("git", ["push", "-u", "origin", value.branch], value.worktree);
          const url = run(
            "gh",
            [
              "pr",
              "create",
              "--draft",
              "-R",
              value.repo,
              "--head",
              value.branch,
              "--base",
              value.repoConfig.base,
              "--title",
              value.taskTitle ?? `feat: resolve ${taskRef}`,
              "--body",
              value.linearIdentifier
                ? `Linear: ${value.linearIdentifier}`
                : value.issue
                  ? `Closes #${value.issue}`
                  : "Linear: none",
            ],
            value.worktree,
          );
          const opened = JSON.parse(
            run(
              "gh",
              ["pr", "view", url, "-R", value.repo, "--json", "number,headRefOid,url"],
              value.worktree,
            ),
          ) as { number: number; headRefOid: string; url: string };
          emit({
            state: "pr",
            pr: opened.number,
            prUrl: opened.url,
            headSha: opened.headRefOid,
          });
          return opened;
        },
      }),
      gate: compute({
        statusDetail: "waiting for CI and writing the gate",
        run: async ({ input, outputs }) => {
          const value = input as Input;
          const pr = outputs.pr as {
            number: number;
            headRefOid: string;
            url: string;
          };
          const ci = await waitForCi(value.repo, pr.headRefOid);
          if (!ci.green) throw new Error(ci.reason);
          const current = JSON.parse(
            run(
              "gh",
              ["pr", "view", String(pr.number), "-R", value.repo, "--json", "headRefOid,state"],
              value.worktree,
            ),
          ) as { headRefOid: string; state: string };
          if (current.state !== "OPEN" || current.headRefOid !== pr.headRefOid)
            throw new Error("PR head changed before gate creation");
          const provenance = collectProvenance(
            value.worktree,
            promptHashes,
            pr.headRefOid,
            value.repo,
            value.repoConfig.base,
            value.repoConfig.install,
          );
          const path = gatePath(value.repo, pr.number);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(
            path,
            `${JSON.stringify({ schema: "piw.local-gate.v1", repo: value.repo, repository: value.repo, issue: value.issue, pr: pr.number, sha: pr.headRefOid, status: "pending-human-merge", createdAt: new Date().toISOString() }, null, 2)}\n`,
            { mode: 0o600 },
          );
          emit({
            state: "gate",
            repo: value.repo,
            pr: pr.number,
            prUrl: pr.url,
            headSha: pr.headRefOid,
            provenance,
          });
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
        run: ({ outputs }) => blockedOutcome(outputs),
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
          cases: {
            continue: "beforeReview",
            retry: "implement",
            blocked: "blocked",
          },
        },
      },
      { from: "beforeReview", to: "review" },
      { from: "review", to: "assessReview" },
      {
        from: "assessReview",
        switch: {
          on: "$.route",
          cases: { continue: "guard", retry: "implement", blocked: "blocked" },
        },
      },
      {
        from: "guard",
        switch: {
          on: "$.route",
          cases: { continue: "pr", blocked: "blocked" },
        },
      },
      { from: "pr", to: "gate" },
    ],
  });
}

function usage(): never {
  console.error("usage: issue-to-pr [--repo OWNER/NAME] (--issue NUMBER | --task-file PATH)");
  process.exit(2);
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const ri = argv.indexOf("--run-id");
  const generatedRunId = `${new Date()
    .toISOString()
    .replace(/[-:.TZ]/gu, "")
    .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const requestedRunId = ri >= 0 ? argv[ri + 1] : undefined;
  if (requestedRunId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/u.test(requestedRunId)) usage();
  const runId = requestedRunId ?? generatedRunId;
  const repoAt = argv.indexOf("--repo");
  const repo = repoAt >= 0 ? (argv[repoAt + 1] ?? "") : DEFAULT_REPO;
  let revision = 0;
  let latestState: RunEventState = "running";
  let latestPr: Omit<RunEvent, "state"> = {};
  let linearIdentifier: string | undefined;
  let taskFile: string | undefined;
  const relayEmit: RunEventEmitter = (event) => {
    latestState = event.state;
    latestPr = {
      ...latestPr,
      ...(event.pr === undefined ? {} : { pr: event.pr }),
      ...(event.prUrl === undefined ? {} : { prUrl: event.prUrl }),
      ...(event.headSha === undefined ? {} : { headSha: event.headSha }),
    };
    const payload = {
      runId,
      revision: revision++,
      state: event.state,
      eventAt: new Date().toISOString(),
      ...(linearIdentifier === undefined ? {} : { linearIdentifier }),
      ...latestPr,
      ...(event.reason === undefined ? {} : { reason: event.reason.slice(0, 2000) }),
      ...(event.heartbeat === undefined ? {} : { heartbeat: event.heartbeat }),
      ...(taskFile === undefined ? {} : { taskFile }),
      repo,
      ...(event.provenance === undefined ? {} : { provenance: event.provenance }),
    };
    const submitted = spawnSync(
      "/opt/piw/bin/piw-relay-submit",
      ["event", JSON.stringify(payload)],
      { encoding: "utf8" },
    );
    if (submitted.status !== 0) {
      const detail = (
        submitted.stderr ||
        submitted.error?.message ||
        `exit ${submitted.status}`
      ).trim();
      console.error(`relay-submit failed: ${detail}`);
    }
  };
  const terminal = new TerminalEventGuard(relayEmit);
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    let repos: Record<string, RepoConfig>;
    try {
      repos = loadRepos();
    } catch (error) {
      terminal.fail(`repo-not-allowed`);
      throw error;
    }
    let repoConfig: RepoConfig;
    try {
      repoConfig = requireRepo(repos, repo);
    } catch {
      terminal.fail("repo-not-allowed");
      console.error("failed: repo-not-allowed");
      process.exitCode = 1;
      return;
    }
    const at = argv.indexOf("--issue");
    const tf = argv.indexOf("--task-file");
    if (
      at >= 0 === tf >= 0 ||
      (at >= 0 && !/^\d+$/u.test(argv[at + 1] ?? "")) ||
      (tf >= 0 && !argv[tf + 1])
    )
      usage();
    const issue = at >= 0 ? Number(argv[at + 1]) : undefined;
    taskFile = tf >= 0 ? argv[tf + 1] : undefined;
    let taskTitle: string | undefined;
    if (taskFile) {
      const task = JSON.parse(readFileSync(taskFile, "utf8")) as {
        identifier?: unknown;
        title?: unknown;
        body?: unknown;
      };
      if (
        (task.identifier !== undefined &&
          (typeof task.identifier !== "string" ||
            !/^[A-Z][A-Z0-9]+-\d+$/u.test(task.identifier))) ||
        typeof task.title !== "string" ||
        typeof task.body !== "string"
      )
        usage();
      linearIdentifier = task.identifier as string | undefined;
      taskTitle = task.title;
    }
    const input: Input = {
      repo,
      repoConfig,
      ...(issue === undefined ? {} : { issue }),
      ...(taskFile === undefined ? {} : { taskFile }),
      ...(linearIdentifier === undefined ? {} : { linearIdentifier }),
      ...(taskTitle === undefined ? {} : { taskTitle }),
      runId,
      worktree: `${ROOT}/work/${runId}`,
      branch: `autocode/${linearIdentifier ?? issue ?? "task"}-${runId}`,
    };
    const emit: RunEventEmitter = (event) => {
      terminal.emit(event);
    };
    emit({ state: "running" });
    const heartbeatMinutes = Number(process.env.PIW_RUN_HEARTBEAT_MINUTES ?? "10");
    heartbeat = setInterval(
      () => emit({ state: latestState, ...latestPr, heartbeat: true }),
      Math.max(1, heartbeatMinutes) * 60_000,
    );
    heartbeat.unref();
    const promptHashes: PromptHashes = {};
    const cliExecutor = new CliStepExecutor({
      cwd: ROOT,
      env: { PIW_WORKTREE: input.worktree },
    });
    const executor: AgentStepExecutor = {
      assistantMessageMode: "unsupported",
      async runAgentStep(request: AgentStepRequest, signal: AbortSignal) {
        const step = request.contract.nodeId;
        if (step === "plan" || step === "implement" || step === "review")
          promptHashes[step] = sha256(request.prompt);
        return await cliExecutor.runAgentStep(request, signal);
      },
    };
    const engine = new WorkflowEngine({
      executor,
      databasePath: `${ROOT}/state/workflows.sqlite`,
      defaultNodeTimeoutMs: 60 * 60_000,
    });
    const result = await engine.run(createIssueToPrWorkflow(emit, promptHashes), input, { runId });
    const workflowStatus = settledWorkflowStatus(result.state.status, result.state.finalOutput);
    const reason =
      result.state.error ??
      ((result.state.finalOutput as { reason?: string } | undefined)?.reason || workflowStatus);
    if (workflowStatus === "blocked") emit({ state: "blocked", reason });
    else if (workflowStatus === "completed") emit({ state: "completed" });
    else
      emit({
        state: "failed",
        reason: crashReason(reason),
      });
    console.log(
      JSON.stringify(
        {
          runId,
          workflowStatus,
          outcome: result.state.finalOutput,
          ...(result.state.error === undefined ? {} : { error: result.state.error }),
        },
        null,
        2,
      ),
    );
    if (workflowStatus !== "completed") process.exitCode = 1;
  } catch (error) {
    terminal.setFallback(error);
    throw error;
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    terminal.finish();
  }
}
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  void main().catch((error) => {
    console.error(`issue-to-pr failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
