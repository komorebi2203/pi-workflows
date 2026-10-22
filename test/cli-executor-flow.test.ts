import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CliStepExecutor, RoutedStepExecutor } from "../src/server/cli-executor.js";
import { agent, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import type { WorkflowTraceEvent } from "../src/workflows/types.js";
import { makeStateDatabasePath, ScriptedExecutor } from "./helpers.js";

const fakeCli = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));

function workflow(mode: "success" | "failure" | "quota", continued: () => void) {
  return defineWorkflow({
    name: `cli-${mode}`,
    startAt: "cli",
    nodes: {
      cli: agent({
        executor: "cli",
        cli: { command: process.execPath, args: [fakeCli, mode, "{prompt}"] },
        prompt: () => "produce JSON",
        validate: (output) => output,
      }),
      later: compute({
        run: () => {
          continued();
          return "continued";
        },
      }),
    },
    edges: [{ from: "cli", to: "later" }],
  });
}

async function run(mode: "success" | "failure" | "quota", continued: () => void) {
  const databasePath = await makeStateDatabasePath("pi-workflows-cli");
  const executor = new RoutedStepExecutor(
    new ScriptedExecutor(),
    new CliStepExecutor({ cwd: process.cwd() }),
  );
  const events: WorkflowTraceEvent[] = [];
  const result = await new WorkflowEngine({
    executor,
    databasePath,
    onEvent: (event) => events.push(event),
  }).run(workflow(mode, continued), {});
  return { ...result, events };
}

describe("CliStepExecutor", () => {
  it("uses parsed stdout JSON as the node output", async () => {
    let continued = false;
    const { state, events } = await run("success", () => (continued = true));

    expect(state.outputs.cli).toEqual({ answer: "fake-cli" });
    expect(state.status).toBe("completed");
    expect(events.find((event) => event.type === "node_finished")?.payload.output).toEqual({
      answer: "fake-cli",
    });
    expect(continued).toBe(true);
  });

  it("records a non-zero exit code and does not continue", async () => {
    let continued = false;
    const { state } = await run("failure", () => (continued = true));

    expect(state.status).toBe("failed");
    expect(state.steps[0]?.error).toContain("exitCode=1, reason=command");
    expect(continued).toBe(false);
  });

  it("classifies a usage-limit failure as quota without waiting for node timeout", async () => {
    let continued = false;
    const started = performance.now();
    const { state } = await run("quota", () => (continued = true));

    expect(performance.now() - started).toBeLessThan(5_000);
    expect(state.status).toBe("failed");
    expect(state.steps[0]?.error).toContain("exitCode=1, reason=quota");
    expect(continued).toBe(false);
  });
});
