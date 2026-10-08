import { createHmac } from "node:crypto";
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
const HUMAN_USER = "722419769147654221";
const HMAC_KEY = "test-hmac-key";

it("carries a launch HMAC key into the adapter and fleet task environment", async () => {
  const fleetCoreDir = await makeTempDir("fleet-gate-launch");
  await fs.writeFile(
    path.join(fleetCoreDir, "fleet-tasks.mjs"),
    "export function createTask() { return { task_id: 'unused' }; }\n",
  );
  const prior = process.env.ORACLE_FLEET_HMAC_KEY;
  try {
    const adapter = await FleetGateAdapter.fromLaunch({
      schema: "pi-workflows.channel-adapter-launch.v1",
      adapterType: "fleet-gate",
      adapterEpoch: "adapter-1",
      profile: "dobby",
      token: "discord-token",
      hmacKey: HMAC_KEY,
      psiRoot: "/tmp/psi",
      fleetCoreDir,
      dobbyCharter: "/tmp/dobby.yaml",
      roomId: ROOM,
      actors: { "fleet:dobby": "delegate" },
      pickupMs: 1000,
      answerMs: 2000,
    });
    expect((adapter as unknown as { options: { hmacKey?: string } }).options.hmacKey).toBe(
      HMAC_KEY,
    );
    expect(process.env.ORACLE_FLEET_HMAC_KEY).toBe(HMAC_KEY);
  } finally {
    if (prior === undefined) delete process.env.ORACLE_FLEET_HMAC_KEY;
    else process.env.ORACLE_FLEET_HMAC_KEY = prior;
  }
});

// Same shape as the real fleet/dobby.yaml gate_policy block: the tier emoji is on a section header and
// the rules under it are plain "N. ..." lines (see fleet-gate-charter.test.ts for the verbatim snapshot).
function charter(): string {
  const rule = (n: number) => `    ${n}. Rule ${n}`;
  return [
    "charter:",
    "  gate_policy: |",
    "    🟩 green header:",
    ...[1, 2, 3, 4, 5, 6].map(rule),
    "    🟨 yellow header:",
    ...[7, 8, 9].map(rule),
    "    🟥 red header:",
    ...[10, 11, 12, 13, 14, 15, 16].map(rule),
  ].join("\n");
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
  const answerDir = path.join(dir, "piw-gate-answers");
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
      actors: {
        "discord:722419769147654221": "human",
        "fleet:dobby": "delegate",
      },
      pickupMs: 5,
      answerMs: 5,
      fleetTasks,
      fetchFn: discord.fetchFn,
      apiBase: "https://discord.invalid",
      answerDir,
      hmacKey: HMAC_KEY,
      idlePollMs: 0,
      logFn: (message) => logs.push(message),
    });
  return {
    adapter: createAdapter(),
    createAdapter,
    tasks,
    created,
    withdrawn,
    discord,
    logs,
    answerDir,
  };
}

describe("fleet gate adapter", () => {
  it("paces an empty poll instead of returning at once", async () => {
    // Guards the 2026-10-08 hot loop: an instant empty poll made adapter-entry report
    // channel.ready ~128 times a second, each journaled as an event (5.8M rows, 4.9 GB).
    const adapter = new FleetGateAdapter({
      profile: "dobby",
      token: "fixture-token",
      psiRoot: "/nonexistent",
      fleetCoreDir: "/nonexistent",
      dobbyCharter: "/nonexistent",
      roomId: "1",
      actors: {},
      pickupMs: 5,
      answerMs: 5,
      fleetTasks: { createTask: () => ({}) },
      idlePollMs: 60,
    });
    const started = Date.now();
    const result = await adapter.poll(7);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(result).toEqual({ cursor: 7, answers: [] });
  });

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
    expect(String(created[0]?.body)).toContain("16. Rule 16");
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

  it("accepts the single verdict line when Dobby writes it LAST (live pilot shape, 2026-10-08)", async () => {
    const { adapter, tasks } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    await adapter.present(value);
    const gateId = gateIdFromTask(tasks.get("task-1"));
    tasks.set("task-1", {
      status: "done",
      source_member: "dobby",
      summary: `Reasoning first.\n- reversible, scratch repo\n\nPIW-GATE v1 ${gateId} continue rule=5`,
    });
    const polled = await adapter.poll(0);
    expect(polled.answers).toEqual([
      expect.objectContaining({ response: { choice: "continue" }, actorId: "fleet:dobby" }),
    ]);
  });

  it("escalates when the reply carries two verdict lines (ambiguous)", async () => {
    const { adapter, tasks } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    await adapter.present(value);
    const gateId = gateIdFromTask(tasks.get("task-1"));
    tasks.set("task-1", {
      status: "done",
      source_member: "dobby",
      summary: `PIW-GATE v1 ${gateId} continue rule=5\nPIW-GATE v1 ${gateId} stop rule=5`,
    });
    const polled = await adapter.poll(0);
    expect(polled.answers).toEqual([]);
  });

  it("sends Dobby only the gate_policy block and the facts-only instruction", async () => {
    const { adapter, tasks } = await fixture();
    const value = request();
    await adapter.present(value);
    const body = String(tasks.get("task-1")?.body);
    expect(body).toContain("16. Rule 16");
    expect(body).not.toContain("charter:");
    expect(body).toContain("Judge ONLY from the facts written in this request");
  });

  it("posts a card within Discord's limit when Dobby's escalation reason is long (live round 3)", async () => {
    const { adapter, tasks, discord } = await fixture();
    const value = request("R".repeat(1500));
    adapter.setRequests([value]);
    await adapter.present(value);
    const gateId = gateIdFromTask(tasks.get("task-1"));
    tasks.set("task-1", {
      status: "done",
      source_member: "dobby",
      summary: `${"เหตุผลยาว ".repeat(160)}\n\nPIW-GATE v1 ${gateId} escalate rule=11`,
    });
    await adapter.poll(0);
    const card = discord.calls.find((c) => c.method === "POST" && c.route.endsWith("/messages"));
    const content = String((card?.body as { content?: string })?.content);
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toContain(`PIW-GATE-CARD ${gateId}`);
    expect(content).toContain("<@722419769147654221>");
    expect(content).toContain("continue");
    expect(discord.latestMessageId()).toBe("card-1");
  });

  it("retries the escalation card on the next poll after a failed post", async () => {
    const { adapter, tasks, discord } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    await adapter.present(value);
    const gateId = gateIdFromTask(tasks.get("task-1"));
    tasks.set("task-1", {
      status: "done",
      source_member: "dobby",
      summary: `PIW-GATE v1 ${gateId} escalate rule=11`,
    });
    discord.control.failNextPost = true;
    await adapter.poll(0).catch(() => undefined);
    await adapter.poll(0);
    expect(discord.latestMessageId()).toBe("card-1");
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

  it("posts Discord buttons without reaction pre-reacts", async () => {
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
    expect(discord.calls.some((call) => call.method === "PUT")).toBe(false);
    const post = discord.calls.find((call) => call.method === "POST");
    expect(post?.body).toMatchObject({
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 2,
              label: "Continue",
              custom_id: `piwgate:v1:${gateId}:0`,
            },
            {
              type: 2,
              style: 2,
              label: "Stop",
              custom_id: `piwgate:v1:${gateId}:1`,
            },
          ],
        },
      ],
    });
  });

  it("ignores forged fleet gate answer files with bad signatures", async () => {
    const { adapter, tasks, discord, answerDir, logs } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    await adapter.present(value);
    const gateId = await escalateWithRedDobbyVerdict(adapter, tasks);
    await writeAnswerFile(answerDir, {
      gateId,
      choiceIndex: 0,
      userId: HUMAN_USER,
      messageId: discord.latestMessageId(),
      channelId: ROOM,
      interactionId: "interaction-bad-sig",
      signKey: "wrong-key",
    });

    expect((await adapter.poll(0)).answers).toEqual([]);
    expect(logs.some((line) => line.includes("signature mismatch"))).toBe(true);
  });

  it("ignores signed answer files for another Discord card", async () => {
    const { adapter, tasks, discord, answerDir, logs } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    await adapter.present(value);
    const gateId = await escalateWithRedDobbyVerdict(adapter, tasks);
    await writeAnswerFile(answerDir, {
      gateId,
      choiceIndex: 0,
      userId: HUMAN_USER,
      messageId: "card-other",
      channelId: ROOM,
      interactionId: "interaction-wrong-message",
    });

    expect((await adapter.poll(0)).answers).toEqual([]);
    expect(logs.some((line) => line.includes("messageId mismatch"))).toBe(true);
    expect(discord.latestMessageId()).toBe("card-1");
  });

  it("ignores signed answer files from non-human profile actors", async () => {
    const { adapter, tasks, discord, answerDir, logs } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    await adapter.present(value);
    const gateId = await escalateWithRedDobbyVerdict(adapter, tasks);
    await writeAnswerFile(answerDir, {
      gateId,
      choiceIndex: 0,
      userId: "999",
      messageId: discord.latestMessageId(),
      channelId: ROOM,
      interactionId: "interaction-wrong-user",
    });

    expect((await adapter.poll(0)).answers).toEqual([]);
    expect(logs.some((line) => line.includes("user is not a human actor"))).toBe(true);
  });

  it("ignores signed answer files with a stale gateId", async () => {
    const { adapter, tasks, discord, answerDir, logs } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    await adapter.present(value);
    const gateId = await escalateWithRedDobbyVerdict(adapter, tasks);
    await writeAnswerFile(answerDir, {
      gateId,
      payloadGateId: "oldgate",
      choiceIndex: 0,
      userId: HUMAN_USER,
      messageId: discord.latestMessageId(),
      channelId: ROOM,
      interactionId: "interaction-stale-gate",
    });

    expect((await adapter.poll(0)).answers).toEqual([]);
    expect(logs.some((line) => line.includes("gateId mismatch"))).toBe(true);
  });

  it("accepts a valid signed button answer with human provenance", async () => {
    const { adapter, tasks, discord, answerDir } = await fixture();
    const value = request();
    adapter.setRequests([value]);
    await adapter.present(value);
    const gateId = await escalateWithRedDobbyVerdict(adapter, tasks);
    await writeAnswerFile(answerDir, {
      gateId,
      choiceIndex: 0,
      userId: HUMAN_USER,
      messageId: discord.latestMessageId(),
      channelId: ROOM,
      interactionId: "interaction-valid",
    });

    expect((await adapter.poll(12)).answers).toEqual([
      expect.objectContaining({
        response: { choice: "continue" },
        actorId: `discord:${HUMAN_USER}`,
        chatId: ROOM,
        eventId: "interaction-valid",
        idempotencyKey: "fleet-gate:dobby:discord:interaction-valid",
        cursor: 13,
      }),
    ]);
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
  let nextMessage = 1;
  const control = { failNextPost: false };
  return {
    calls,
    control,
    latestMessageId() {
      const id = messages[0]?.id;
      if (id === undefined) throw new Error("no Discord message posted");
      return id;
    },
    fetchFn: async (url: string, init?: RequestInit) => {
      const route = new URL(url).pathname + new URL(url).search;
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ method, route, body });
      let result: unknown = {};
      if (method === "GET" && route.endsWith("/messages?limit=50")) result = messages;
      if (method === "POST" && route.endsWith("/messages")) {
        // Real Discord: content over 2000 chars is a 400 (live 2026-10-08 round 3).
        if (control.failNextPost || String(body.content).length > 2000) {
          control.failNextPost = false;
          return {
            ok: false,
            status: 400,
            async json() {
              return { code: 50035, message: "Invalid Form Body" };
            },
          };
        }
        const message = { id: `card-${nextMessage}`, content: String(body.content) };
        nextMessage += 1;
        messages.unshift(message);
        result = message;
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

async function escalateWithRedDobbyVerdict(
  adapter: FleetGateAdapter,
  tasks: Map<string, Record<string, unknown>>,
): Promise<string> {
  const gateId = gateIdFromTask(tasks.get("task-1"));
  tasks.set("task-1", {
    status: "done",
    source_member: "dobby",
    summary: `PIW-GATE v1 ${gateId} continue rule=11`,
  });
  expect((await adapter.poll(0)).answers).toEqual([]);
  return gateId;
}

async function writeAnswerFile(
  answerDir: string,
  options: {
    gateId: string;
    payloadGateId?: string;
    choiceIndex: number;
    userId: string;
    messageId: string;
    channelId: string;
    interactionId: string;
    signKey?: string;
  },
): Promise<void> {
  await fs.mkdir(answerDir, { recursive: true });
  const answer = {
    schema: "piw-gate-answer.v1",
    gateId: options.payloadGateId ?? options.gateId,
    choiceIndex: options.choiceIndex,
    userId: options.userId,
    messageId: options.messageId,
    channelId: options.channelId,
    interactionId: options.interactionId,
    at: "2026-10-08T00:00:00.000Z",
  };
  const sig = createHmac("sha256", options.signKey ?? HMAC_KEY)
    .update(
      JSON.stringify([
        answer.schema,
        answer.gateId,
        answer.choiceIndex,
        answer.userId,
        answer.messageId,
        answer.channelId,
        answer.interactionId,
        answer.at,
      ]),
    )
    .digest("hex");
  await fs.writeFile(
    path.join(answerDir, `${options.gateId}.json`),
    JSON.stringify({ ...answer, sig }),
  );
}
