import { describe, expect, it } from "vitest";
import { evaluateCi, waitForCi, type CiSnapshot } from "../src/autocode/ci-wait.js";

const snapshot = (runs: CiSnapshot["runs"], statuses: CiSnapshot["statuses"] = []) => ({
  runs,
  statuses,
});

describe("exact-head Actions CI", () => {
  it("allows only completed success, skipped, or neutral runs", () => {
    expect(
      evaluateCi(
        snapshot([
          { status: "completed", conclusion: "success" },
          { status: "completed", conclusion: "skipped" },
          { status: "completed", conclusion: "neutral" },
        ]),
      ),
    ).toBe("green");
    expect(evaluateCi(snapshot([{ status: "in_progress", conclusion: null }]))).toBe("pending");
    expect(evaluateCi(snapshot([{ status: "completed", conclusion: "failure" }]))).toBe(
      "ci-failed",
    );
  });

  it("fails on commit failure or error", () => {
    const greenRun = [{ status: "completed", conclusion: "success" }];
    expect(evaluateCi(snapshot(greenRun, [{ state: "failure" }]))).toBe("ci-failed");
    expect(evaluateCi(snapshot(greenRun, [{ state: "error" }]))).toBe("ci-failed");
  });

  it("reports zero runs as ci-missing after the bounded wait", async () => {
    await expect(
      waitForCi("owner/repository", "a".repeat(40), {
        timeoutMs: 0,
        read: () => snapshot([]),
      }),
    ).resolves.toEqual({ green: false, reason: "ci-missing" });
  });

  it("waits for every run and returns green", async () => {
    const reads = [
      snapshot([{ status: "queued", conclusion: null }]),
      snapshot([{ status: "completed", conclusion: "success" }]),
    ];
    await expect(
      waitForCi("owner/repository", "b".repeat(40), {
        timeoutMs: 100,
        intervalMs: 1,
        read: () => reads.shift() ?? snapshot([]),
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({ green: true, runCount: 1 });
  });
});
