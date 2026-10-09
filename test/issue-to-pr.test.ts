import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedAssertions, createIssueToPrWorkflow } from "../src/autocode/issue-to-pr.js";

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
        cases: { continue: "review", retry: "implement", blocked: "blocked" },
      },
    });
    expect(workflow.edges).toContainEqual({
      from: "guard",
      switch: { on: "$.route", cases: { continue: "pr", blocked: "blocked" } },
    });
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
});
