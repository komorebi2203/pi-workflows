import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertReviewUnmodified,
  blockedOutcome,
  changedAssertions,
  createIssueToPrWorkflow,
  settledWorkflowStatus,
  treeFingerprint,
} from "../src/autocode/issue-to-pr.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { makeStateDatabasePath, ScriptedExecutor } from "./helpers.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

describe("issue-to-pr workflow", () => {
  it("defines bounded verify and review loops before guard and PR", () => {
    const workflow = createIssueToPrWorkflow();
    expect(workflow.name).toBe("issue-to-pr");
    expect(workflow.maxSteps).toBe(24);
    expect(workflow.edges).toContainEqual({
      from: "verify",
      switch: {
        on: "$.route",
        cases: { continue: "beforeReview", retry: "implement", blocked: "blocked" },
      },
    });
    expect(workflow.edges).toContainEqual({
      from: "guard",
      switch: { on: "$.route", cases: { continue: "pr", blocked: "blocked" } },
    });
  });

  it("settles a blocked run with a reason and JSON-safe output", async () => {
    const workflow = defineWorkflow({
      name: "issue-to-pr-blocked-test",
      startAt: "route",
      nodes: {
        route: compute({ run: () => ({ route: "blocked", reason: "verify" }) }),
        blocked: compute({ run: ({ outputs }) => blockedOutcome({ verify: outputs.route }) }),
      },
      edges: [{ from: "route", switch: { on: "$.route", cases: { blocked: "blocked" } } }],
    });
    const result = await new WorkflowEngine({
      executor: new ScriptedExecutor(),
      databasePath: await makeStateDatabasePath("issue-to-pr-blocked"),
    }).run(workflow, {});
    expect(result.state.finalOutput).toEqual({ status: "blocked", reason: "verify" });
    expect(settledWorkflowStatus(result.state.status, result.state.finalOutput)).toBe("blocked");
  });

  it("detects a review-time worktree modification", () => {
    const cwd = mkdtempSync(join(tmpdir(), "issue-to-pr-review-tree-"));
    git(cwd, ["init", "-b", "main"]);
    git(cwd, ["config", "user.email", "test@example.invalid"]);
    git(cwd, ["config", "user.name", "Test"]);
    writeFileSync(join(cwd, "tracked.txt"), "before\n");
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "-m", "base"]);
    const before = treeFingerprint(cwd);
    writeFileSync(join(cwd, "decoy.txt"), "written during review\n");
    expect(() => assertReviewUnmodified(before, treeFingerprint(cwd))).toThrow(
      "review-modified-tree",
    );
  });

  it("detects a changed existing assertion but permits a new test", () => {
    const cwd = mkdtempSync(join(tmpdir(), "issue-to-pr-guard-"));
    git(cwd, ["init", "-b", "main"]);
    git(cwd, ["config", "user.email", "test@example.invalid"]);
    git(cwd, ["config", "user.name", "Test"]);
    writeFileSync(join(cwd, "math.test.js"), "expect(add(2, 3)).toBe(5);\n");
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "-m", "base"]);
    writeFileSync(join(cwd, "new.test.js"), "expect(true).toBe(true);\n");
    expect(changedAssertions(cwd)).toEqual([]);
    writeFileSync(join(cwd, "math.test.js"), "expect(add(2, 3)).toBe(6);\n");
    expect(changedAssertions(cwd)).toEqual(["math.test.js"]);
  });

  it("detects a changed Node assert method assertion", () => {
    const cwd = mkdtempSync(join(tmpdir(), "issue-to-pr-node-assert-guard-"));
    git(cwd, ["init", "-b", "main"]);
    git(cwd, ["config", "user.email", "test@example.invalid"]);
    git(cwd, ["config", "user.name", "Test"]);
    writeFileSync(join(cwd, "math.test.js"), "assert.equal(add(2, 3), 5);\n");
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "-m", "base"]);
    writeFileSync(join(cwd, "math.test.js"), "assert.equal(add(2, 3), 6);\n");
    expect(changedAssertions(cwd)).toEqual(["math.test.js"]);
  });

  it("runs the CLI usage path through a symlink", () => {
    const cwd = mkdtempSync(join(tmpdir(), "issue-to-pr-bin-"));
    const link = join(cwd, "issue-to-pr");
    symlinkSync(join(process.cwd(), "dist/autocode/issue-to-pr.js"), link);
    try {
      execFileSync(process.execPath, [link], { encoding: "utf8", stdio: "pipe" });
      throw new Error("CLI unexpectedly succeeded");
    } catch (error) {
      expect(String((error as { stderr?: Buffer }).stderr)).toContain("usage: issue-to-pr");
    }
  });
});
