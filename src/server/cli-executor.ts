import { spawn } from "node:child_process";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
} from "../workflows/types.js";
import type { SupervisedProcessRegistry } from "./rpc-executor.js";

const QUOTA_PATTERN = /\b(?:quota|usage[ -]limit|rate[ -]limit)\b/i;

export type CliStepExecutorOptions = {
  cwd: string;
  registry?: SupervisedProcessRegistry;
  env?: Record<string, string>;
};

/** Runs an opted-in agent step as one external process and validates its stdout. */
export class CliStepExecutor implements AgentStepExecutor {
  readonly assistantMessageMode = "unsupported" as const;

  constructor(private readonly options: CliStepExecutorOptions) {}

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    if (request.executor !== "cli" || request.cli === undefined) {
      throw new Error("CLI executor received a step without CLI configuration");
    }
    const configuredArgs = request.cli.args ?? ["{prompt}"];
    const hasPlaceholder = configuredArgs.some((arg) => arg.includes("{prompt}"));
    const args = configuredArgs.map((arg) => arg.replaceAll("{prompt}", request.prompt));
    if (!hasPlaceholder) args.push(request.prompt);

    const result = await runCommand(request.cli.command, args, this.options, signal);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "no diagnostic output";
      const reason = QUOTA_PATTERN.test(`${result.stderr}\n${result.stdout}`) ? "quota" : "command";
      throw new Error(`CLI step failed (exitCode=${result.exitCode}, reason=${reason}): ${detail}`);
    }

    let output: unknown = result.stdout.trim();
    try {
      output = JSON.parse(result.stdout);
    } catch {
      // Official subscription CLIs normally print their final response as text.
      // JSON-producing wrappers retain structure through the parse path above.
    }
    const accepted = await request.accept(output);
    if (!accepted.ok) throw new Error(`CLI step output rejected: ${accepted.error}`);
    return { output: accepted.value };
  }
}

export class RoutedStepExecutor implements AgentStepExecutor {
  readonly assistantMessageMode: "visible" | "park" | "unsupported";
  readonly preservesActiveTimeBudget: boolean;
  readonly enforcesToolAllowlist: boolean;

  constructor(
    private readonly defaultExecutor: AgentStepExecutor,
    private readonly cliExecutor: AgentStepExecutor,
  ) {
    this.assistantMessageMode = defaultExecutor.assistantMessageMode ?? "unsupported";
    this.preservesActiveTimeBudget = defaultExecutor.preservesActiveTimeBudget ?? false;
    this.enforcesToolAllowlist = defaultExecutor.enforcesToolAllowlist ?? false;
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    return await (
      request.executor === "cli" ? this.cliExecutor : this.defaultExecutor
    ).runAgentStep(request, signal);
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: CliStepExecutorOptions,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  if (child.pid !== undefined) await options.registry?.register(child.pid);

  return await new Promise((resolve, reject) => {
    const abort = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
      reject(signal.reason ?? new Error("Workflow step aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      signal.removeEventListener("abort", abort);
      Promise.resolve(child.pid === undefined ? undefined : options.registry?.unregister(child.pid))
        .then(() => resolve({ stdout, stderr, exitCode }))
        .catch(reject);
    });
  });
}
