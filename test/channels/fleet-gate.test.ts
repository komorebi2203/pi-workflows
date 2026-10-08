import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FleetGateAdapter } from "../../src/channels/fleet-gate.js";
import { humanDecisionChannelRequest } from "../../src/workflows/decision-presentation.js";
import {
  choice,
  createHumanDecisionRequest,
  defineHumanChoices,
  textInput,
} from "../../src/workflows/human-decision.js";
import { decisionPrompt, makeTempDir } from "../helpers.js";

const ROOM = "1516161412873982136";
const BOT = "1520338692429058209";

function charter(): string {
  return Array.from({ length: 16 }, (_, index) => {
    const rule = index + 1;
    const tier = rule <= 6 ? "🟩" : rule <= 9 ? "🟨" : "🟥";
    return `${tier} ${rule}. Rule ${rule}`;
  }).join("\n");
}

function request(text = "Apply the safe change.") {
  return humanDecisionChannelRequest(
    createHumanDecisionRequest({
      runId: "run-a",
      workflowName: "workflow-a",
      nodeId: "approve",
      attemptId: "attempt-a",
      contract: {
        audience: "fleet-gate",
        choices: defineHumanChoices({
          continue: choice({ label: "Continue" }),
          stop: choice({ label: "Stop" }),
        }),
      },
      prompt: {
        ...decisionPrompt({ privateMachineField: "not-for-display" }),
        presentation: {
          schema: "pi-workflows.decision-presentation.v1",
          summary: "Review this readable plan.",
          blocks: [{ kind: "paragraph", text }],
        },
      },
      createdAt: "2026-10-07T00:00:00.000Z",
    }),
  );
}

function requestWithTextInput(text = "Apply the safe change.") {
  return humanDecisionChannelRequest(
    createHumanDecisionRequest({
      runId: "run-a",
      workflowName: "workflow-a",
      nodeId: "approve",
      attemptId: "attempt-a",
      contract: {
        audience: "fleet-gate",
        choices: defineHumanChoices({
          continue: choice({ label: "Continue" }),
          replan: choice({
            label: "Replan",
            input: textInput({ name: "instructions", prompt: "What should change?" }),
          }),
        }),
      },
      prompt: {
        ...decisionPrompt({ privateMachineField: "not-for-display" }),
        presentation: {
          schema: "pi-workflows.decision-presentation.v1",
          summary: "Review this readable plan.",
          blocks: [{ kind: "paragraph", text }],
        },
      },
      createdAt: "2026-10-07T00:00:00.000Z",
    }),
  );
}

async function fixture() {
  const dir = await makeTempDir("fleet-gate-adapter");
  const charterPath = path.join(dir, "dobby.yaml");
  await fs.writeFile(charterPath, charter());
  const tasks = new Map<string, Record<string, unknown>>();
  const created: Record<string, unknown>[] = [];
  const withdrawn: string[] = [];
  const logs: string[] = [];
  const fleetTasks = {
    createTask(_psiRoot: string, task: Record<string, unknown>) {
      created.push(task);
      const id = `task-${created.length}`;
      tasks.set(id, { id, status: "pending", body: task.body });
      return { id };
    },
    readTask(_psiRoot: string, taskId: string) {
      return tasks.get(taskId);
    },
    withdraw(_psiRoot: string, taskId: string) {
      withdrawn.push(taskId);
      const task = tasks.get(taskId);
      if (task !== undefined) task.status = "cancelled";
    },
  };
  const discord = fakeDiscord();
  const createAdapter = () =>
    new FleetGateAdapter({
      profile: "dobby",
      token: "fixture-token",
      psiRoot: dir,
      fleetCoreDir: dir,
      dobbyCharter: charterPath,
      roomId: ROOM,
      pickupMs: 5,
      answerMs: 5,
      fleetTasks,
      fetchFn: discord.fetchFn,
      apiBase: "https://discord.invalid",
      logFn: (message) => logs.push(message),
    });
  return { adapter: createAdapter(), createAdapter, tasks, created, withdrawn, discord, logs };
}

describe("fleet gate adapter", () => {
  it("presents one signed Dobby task with the charter and verdict grammar", async () => {
    const { adapter, created } = await fixture();
    const value = request();
    const messages = await adapter.present(value);
    expect(messages).toEqual([
      expect.objectContaining({ chatId: ROOM, messageId: "task-1", recipientIndex: 0 }),
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      from: "piw",
      to: "dobby",
      kind: "answer",
      deliver_channel: ROOM,
    });
    expect(created[0]).not.toHaveProperty("subject");
    expect(String(created[0]?.body)).toContain("🟥 16. Rule 16");
    expect(String(created[0]?.body)).toContain("PIW-GATE v1");
  });

  it("presents text-input choices and escalates when Dobby selects one", async () => {
    const { adapter, tasks, discord } = await fixture();
    const value = requestWithTextInput();
    adapter.setRequests([value]);
    await expect(adapter.present(value)).resolves.toHaveLength(1);
    expect(String(tasks.get("task-1")?.body)).toContain("What should change?");
    const gateId = gateIdFromTask(tasks.get("task-1"));
    tasks.set("task-1", {
      status: "done",
      source_member: "dobby",
      summary: `PIW-GATE v1 ${gateId} replan rule=1`,
    });
    expect((await adapter.poll(0)).answers).toEqual([]);
    expect(discord.calls.some((call) => call.method === "POST")).toBe(true);
  });

  it("accepts a Dobby green verdict as a delegate answer", async () => {
    const { adapter, tasks } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    await adapter.present(value);
    const gateId = gateIdFromTask(tasks.get("task-1"));
    tasks.set("task-1", {
      status: "done",
      source_member: "dobby",
      summary: `PIW-GATE v1 ${gateId} continue rule=1\nLooks safe.`,
    });
    const polled = await adapter.poll(0);
    expect(polled.answers).toEqual([
      expect.objectContaining({
        response: { choice: "continue" },
        actorId: "fleet:dobby",
        chatId: ROOM,
        eventId: "task-1",
        idempotencyKey: "fleet-gate:dobby:task:task-1",
      }),
    ]);
  });

  it("rehydrates a restarted adapter from verified delivery messages before accepting Dobby", async () => {
    const { adapter, createAdapter, tasks } = await fixture();
    const value = request();
    const messages = await adapter.present(value);
    const gateId = gateIdFromTask(tasks.get("task-1"));
    tasks.set("task-1", {
      status: "done",
      source_member: "dobby",
      summary: `PIW-GATE v1 ${gateId} continue rule=1\nLooks safe.`,
    });

    const restarted = createAdapter();
    restarted.setRequests([
      { ...value, messages: [{ ...messages[0]!, contentDigest: "sha256:wrong" }] },
    ]);
    expect((await restarted.poll(0)).answers).toEqual([]);

    restarted.setRequests([{ ...value, messages }]);
    expect((await restarted.poll(0)).answers).toEqual([
      expect.objectContaining({
        response: { choice: "continue" },
        actorId: "fleet:dobby",
        eventId: "task-1",
      }),
    ]);
  });

  it("bot pre-reactions + user 999 reaction -> no answer after 3 polls", async () => {
    const { adapter, tasks, discord } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    await adapter.present(value);
    const gateId = gateIdFromTask(tasks.get("task-1"));
    tasks.set("task-1", {
      status: "done",
      source_member: "dobby",
      summary: `PIW-GATE v1 ${gateId} continue rule=11`,
    });
    for (let index = 0; index < 3; index += 1) {
      discord.react("✅", BOT);
      discord.react("✅", "999");
      expect((await adapter.poll(index)).answers).toEqual([]);
    }
    expect(discord.calls.some((call) => call.method === "POST")).toBe(true);
  });

  it("verdict with previous gateId -> discarded, escalated", async () => {
    const { adapter, tasks, discord } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    await adapter.present(value);
    tasks.set("task-1", {
      status: "done",
      source_member: "dobby",
      summary: "PIW-GATE v1 oldgate continue rule=1",
    });
    expect((await adapter.poll(0)).answers).toEqual([]);
    expect(discord.calls.some((call) => call.method === "POST")).toBe(true);
  });

  it("PIW-GATE v1 <id> continue rule=11 -> refused (red), escalated, no channel.answer", async () => {
    const { adapter, tasks, discord } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    await adapter.present(value);
    const gateId = gateIdFromTask(tasks.get("task-1"));
    tasks.set("task-1", {
      status: "done",
      source_member: "dobby",
      summary: `PIW-GATE v1 ${gateId} continue rule=11`,
    });
    expect((await adapter.poll(0)).answers).toEqual([]);
    expect(discord.calls.some((call) => call.method === "POST")).toBe(true);
  });

  it("malformed/rejected/blocked/timed_out/pending>pickupMs -> escalate, zero answers", async () => {
    for (const task of [
      { status: "done", source_member: "dobby", summary: "not a verdict" },
      { status: "rejected" },
      { status: "blocked" },
      { status: "timed_out" },
    ]) {
      const { adapter, tasks, discord } = await fixture();
      const value = request();
      adapter.setRequests([value]);
      await adapter.present(value);
      tasks.set("task-1", task);
      expect((await adapter.poll(0)).answers).toEqual([]);
      expect(discord.calls.some((call) => call.method === "POST")).toBe(true);
    }
    const { adapter, discord } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    await adapter.present(value);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await adapter.poll(0)).answers).toEqual([]);
    expect(discord.calls.some((call) => call.method === "POST")).toBe(true);
  });

  it("settle(cancelled) on pending -> withdraw called; late verdict -> no answer", async () => {
    const { adapter, tasks, withdrawn } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    const messages = await adapter.present(value);
    await expect(adapter.settle("cancelled", undefined, messages, value)).resolves.toEqual({
      state: "confirmed",
    });
    expect(withdrawn).toEqual(["task-1"]);
    const gateId = gateIdFromTask(tasks.get("task-1"));
    tasks.set("task-1", {
      status: "done",
      source_member: "dobby",
      summary: `PIW-GATE v1 ${gateId} continue rule=1`,
    });
    expect((await adapter.poll(0)).answers).toEqual([]);
  });

  it("rehydrates delivered messages before confirming settlement after restart", async () => {
    const { adapter, createAdapter, withdrawn } = await fixture();
    const value = request();
    const messages = await adapter.present(value);

    const restarted = createAdapter();
    await expect(restarted.settle("cancelled", undefined, messages, value)).resolves.toEqual({
      state: "confirmed",
    });
    expect(withdrawn).toEqual(["task-1"]);

    const badDigest = createAdapter();
    await expect(
      badDigest.settle(
        "cancelled",
        undefined,
        [{ ...messages[0]!, contentDigest: "sha256:wrong" }],
        value,
      ),
    ).resolves.toEqual({
      state: "unknown",
      errorCode: "fleetGateDeliveryNotRehydrated",
    });
  });

  it("reports accepted tasks as unsettled and ignores a late Dobby verdict", async () => {
    const { adapter, tasks, withdrawn, logs } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    const messages = await adapter.present(value);
    const gateId = gateIdFromTask(tasks.get("task-1"));
    tasks.set("task-1", { ...tasks.get("task-1"), status: "accepted" });

    await expect(adapter.settle("cancelled", undefined, messages, value)).resolves.toEqual({
      state: "unknown",
      errorCode: "fleetGateAcceptedTaskNotWithdrawable",
    });
    await expect(adapter.settle("cancelled", undefined, messages, value)).resolves.toEqual({
      state: "unknown",
      errorCode: "fleetGateAcceptedTaskNotWithdrawable",
    });
    expect(withdrawn).toEqual([]);

    tasks.set("task-1", {
      status: "done",
      source_member: "dobby",
      summary: `PIW-GATE v1 ${gateId} continue rule=1`,
    });
    expect((await adapter.poll(0)).answers).toEqual([]);
    expect(logs.some((line) => line.includes("ignored late Dobby verdict"))).toBe(true);
  });
});

function fakeDiscord() {
  const calls: Array<{ method: string; route: string; body: unknown }> = [];
  const messages: Array<{ id: string; content: string }> = [];
  const reactions = new Map<string, Set<string>>();
  let nextMessage = 1;
  return {
    calls,
    react(emoji: string, userId: string) {
      const users = reactions.get(emoji) ?? new Set<string>();
      users.add(userId);
      reactions.set(emoji, users);
    },
    fetchFn: async (url: string, init?: RequestInit) => {
      const route = new URL(url).pathname + new URL(url).search;
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ method, route, body });
      let result: unknown = {};
      if (method === "GET" && route.endsWith("/messages?limit=50")) result = messages;
      if (method === "POST" && route.endsWith("/messages")) {
        const message = { id: `card-${nextMessage}`, content: String(body.content) };
        nextMessage += 1;
        messages.unshift(message);
        result = message;
      }
      if (method === "GET" && route.includes("/reactions/")) {
        const emoji = decodeURIComponent(route.split("/reactions/")[1] ?? "");
        result = [...(reactions.get(emoji) ?? new Set<string>())].map((id) => ({ id }));
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return result;
        },
      };
    },
  };
}

function gateIdFromTask(task: Record<string, unknown> | undefined): string {
  const body = String(task?.body ?? "");
  const match = body.match(/PIW-GATE v1 ([0-9a-f]{16})/u);
  if (match === null) throw new Error("gate id missing");
  return match[1] as string;
}
