import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { digestCanonical } from "../workflows/decision-presentation.js";
import type { HumanDecisionChannelRequest, HumanDecisionResponse } from "../workflows/types.js";
import {
  type ChannelAdapterLaunch,
  type ChannelPollRequest,
  type TelegramMessageReference,
} from "./protocol.js";
import { renderDecisionText } from "./telegram.js";

const DEFAULT_DISCORD_API_BASE = "https://discord.com/api/v10";
const DEFAULT_GATE_ANSWER_DIR = "/root/hello-oracle/ψ/inbox/piw-gate-answers";
const DOBBY_ACTOR = "fleet:dobby";
const DOBBY_MEMBER = "dobby";
const YIM_DISCORD_USER = "722419769147654221";
const CHOICE_TEXT_MARKERS = ["✅", "🛑", "🔁", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"] as const;
const DISCORD_ACTION_ROW_LIMIT = 5;
const DISCORD_BUTTONS_PER_ROW_LIMIT = 5;
const DISCORD_BUTTON_LABEL_LIMIT = 80;
const DISCORD_BUTTON_CUSTOM_ID_LIMIT = 100;

type FleetTaskModule = {
  createTask: (psiRoot: string, task: Record<string, unknown>) => Promise<unknown> | unknown;
  readTask?: (psiRoot: string, taskId: string) => Promise<unknown> | unknown;
  getTask?: (psiRoot: string, taskId: string) => Promise<unknown> | unknown;
  withdraw?: (psiRoot: string, taskId: string, from?: string) => Promise<unknown> | unknown;
};

type FleetGateFetch = (
  input: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type FleetGateVerifiedAnswer = {
  request: HumanDecisionChannelRequest;
  response: HumanDecisionResponse;
  actorId: string;
  chatId: string;
  eventId: string;
  idempotencyKey: string;
  cursor: number;
};

export type FleetGateSettlementResult =
  | { state: "confirmed" }
  | { state: "unknown"; errorCode: string };

type GateState = {
  gateId: string;
  request: HumanDecisionChannelRequest;
  taskId: string;
  taskCreatedAt: number;
  body: string;
  rules: Map<number, "green" | "yellow" | "red">;
  status: "open" | "escalated" | "answered" | "settled";
  cardId?: string;
  lateVerdictLogged?: boolean;
  settlementErrorCode?: string;
};

type GateAnswerFile = {
  schema: "piw-gate-answer.v1";
  gateId: string;
  choiceIndex: number;
  userId: string;
  messageId: string;
  channelId: string;
  interactionId: string;
  at: string;
  sig: string;
};

export class FleetGateAdapter {
  private readonly request: FleetGateFetch;
  private readonly gates = new Map<string, GateState>();
  private readonly requests = new Map<string, HumanDecisionChannelRequest>();
  private readonly deliveries = new Map<string, TelegramMessageReference[]>();

  constructor(
    private readonly options: {
      profile: string;
      token: string;
      psiRoot: string;
      fleetCoreDir: string;
      dobbyCharter: string;
      roomId: string;
      actors: Record<string, "human" | "delegate">;
      pickupMs: number;
      answerMs: number;
      fleetTasks: FleetTaskModule;
      fetchFn?: FleetGateFetch;
      apiBase?: string;
      answerDir?: string;
      hmacKey?: string;
      logFn?: (message: string) => void;
    },
  ) {
    this.request = options.fetchFn ?? (fetch as FleetGateFetch);
  }

  static async fromLaunch(
    launch: Extract<ChannelAdapterLaunch, { adapterType: "fleet-gate" }>,
  ): Promise<FleetGateAdapter> {
    const fleetTasks = (await import(path.join(launch.fleetCoreDir, "fleet-tasks.mjs"))) as
      | FleetTaskModule
      | { default?: FleetTaskModule };
    return new FleetGateAdapter({
      profile: launch.profile,
      token: launch.token,
      psiRoot: launch.psiRoot,
      fleetCoreDir: launch.fleetCoreDir,
      dobbyCharter: launch.dobbyCharter,
      roomId: launch.roomId,
      actors: launch.actors,
      pickupMs: launch.pickupMs,
      answerMs: launch.answerMs,
      fleetTasks: "createTask" in fleetTasks ? fleetTasks : (fleetTasks.default as FleetTaskModule),
      ...(launch.apiBase === undefined ? {} : { apiBase: launch.apiBase }),
    });
  }

  setRequests(requests: readonly (HumanDecisionChannelRequest | ChannelPollRequest)[]): void {
    this.requests.clear();
    this.deliveries.clear();
    for (const item of requests) {
      const { request, messages } = pollRequestParts(item);
      this.requests.set(request.decisionId, request);
      if (messages.length > 0) this.deliveries.set(request.decisionId, messages);
    }
  }

  async present(request: HumanDecisionChannelRequest): Promise<TelegramMessageReference[]> {
    const charter = await fs.readFile(this.options.dobbyCharter, "utf8");
    const rules = parseRuleTable(charter);
    const gateId = this.gateId(request);
    const body = renderTaskBody(request, gateId, charter);
    const created = await this.options.fleetTasks.createTask(this.options.psiRoot, {
      from: "piw",
      to: "dobby",
      kind: "answer",
      deliver_channel: this.options.roomId,
      body,
    });
    const taskId = taskIdFrom(created);
    this.gates.set(request.decisionId, {
      gateId,
      request,
      taskId,
      taskCreatedAt: Date.now(),
      body,
      rules,
      status: "open",
    });
    return [
      {
        chatId: this.options.roomId,
        messageId: taskId,
        recipientIndex: 0,
        partIndex: 0,
        contentDigest: digestCanonical(body),
      },
    ];
  }

  async poll(cursor: number): Promise<{ cursor: number; answers: FleetGateVerifiedAnswer[] }> {
    let nextCursor = cursor;
    const answers: FleetGateVerifiedAnswer[] = [];
    for (const request of this.requests.values()) {
      const gate =
        this.gates.get(request.decisionId) ??
        (await this.rehydrateGate(request, this.deliveries.get(request.decisionId) ?? []));
      if (gate !== undefined) this.gates.set(request.decisionId, gate);
      if (gate === undefined || gate.status === "answered") continue;
      if (gate.status === "settled") {
        await this.logLateSettledVerdict(gate);
        continue;
      }
      if (gate.status === "open") {
        const task = await this.readTask(gate.taskId);
        const answer = await this.pollDobby(gate, task, nextCursor + 1);
        if (answer !== undefined) {
          nextCursor += 1;
          answers.push(answer);
          continue;
        }
      }
      if (gate.status === "escalated") {
        const answer = await this.pollDiscord(gate, nextCursor + 1);
        if (answer !== undefined) {
          nextCursor += 1;
          answers.push(answer);
        }
      }
    }
    return { cursor: nextCursor, answers };
  }

  async settle(
    outcome: "accepted" | "cancelled" | "expired",
    response: HumanDecisionResponse | undefined,
    messages: readonly TelegramMessageReference[],
    request?: HumanDecisionChannelRequest,
  ): Promise<FleetGateSettlementResult> {
    for (const message of messages) {
      const gate = await this.gateForSettlement(message, request);
      if (gate === undefined)
        return { state: "unknown", errorCode: "fleetGateDeliveryNotRehydrated" };
      if (gate.status === "settled") {
        if (gate.settlementErrorCode !== undefined) {
          return { state: "unknown", errorCode: gate.settlementErrorCode };
        }
        continue;
      }
      const task = await this.readTask(gate.taskId);
      const status = taskStatus(task);
      if (status === undefined) {
        return this.markSettlementUnknown(gate, "fleetGateTaskStatusUnavailable");
      }
      if (status === "pending") {
        if (this.options.fleetTasks.withdraw === undefined) {
          return this.markSettlementUnknown(gate, "fleetGateWithdrawUnavailable");
        }
        await this.options.fleetTasks.withdraw(this.options.psiRoot, gate.taskId, "piw");
      } else if (status === "accepted") {
        return this.markSettlementUnknown(gate, "fleetGateAcceptedTaskNotWithdrawable");
      } else if (
        status !== "done" &&
        status !== "cancelled" &&
        status !== "rejected" &&
        status !== "blocked" &&
        status !== "timed_out" &&
        status !== "stale"
      ) {
        return this.markSettlementUnknown(gate, "fleetGateUnexpectedTaskStatus");
      }
      await this.editSettlementCard(gate, outcome, response);
      gate.status = "settled";
    }
    return { state: "confirmed" };
  }

  private async editSettlementCard(
    gate: GateState,
    outcome: "accepted" | "cancelled" | "expired",
    response: HumanDecisionResponse | undefined,
  ): Promise<void> {
    const cardId = gate.cardId ?? (await this.findCard(gate.gateId));
    if (cardId === undefined) return;
    gate.cardId = cardId;
    const selection = response?.choice === undefined ? "" : ` (${response.choice})`;
    await this.discord("PATCH", `/channels/${this.options.roomId}/messages/${cardId}`, {
      content: `${this.cardMarker(gate.gateId)}\nDecision ${outcome}${selection}.`,
    });
  }

  private async pollDobby(
    gate: GateState,
    task: Record<string, unknown> | undefined,
    cursor: number,
  ): Promise<FleetGateVerifiedAnswer | undefined> {
    const status = taskStatus(task);
    if (status === "pending" && Date.now() - gate.taskCreatedAt > this.options.pickupMs) {
      await this.escalate(gate, "Dobby did not pick up the task before the pickup deadline.");
      return undefined;
    }
    if (status === "accepted" && Date.now() - gate.taskCreatedAt > this.options.answerMs) {
      await this.escalate(gate, "Dobby did not answer before the answer deadline.");
      return undefined;
    }
    if (
      status === "rejected" ||
      status === "blocked" ||
      status === "timed_out" ||
      status === "stale"
    ) {
      await this.escalate(gate, `Dobby task ended with status ${status}.`);
      return undefined;
    }
    if (status !== "done") return undefined;
    const summary = textField(task, "summary");
    const sourceMember = textField(task, "source_member");
    const verdict = parseVerdict(summary, gate);
    if (
      sourceMember !== DOBBY_MEMBER ||
      verdict === undefined ||
      verdict.choice === "escalate" ||
      gate.rules.get(verdict.rule) === "red" ||
      gate.request.choices[verdict.choice] === undefined
    ) {
      await this.escalate(gate, summary ?? "Dobby did not provide a valid gate verdict.");
      return undefined;
    }
    const selectedChoice = gate.request.choices[verdict.choice];
    if (selectedChoice?.input !== undefined) {
      await this.escalate(
        gate,
        `Dobby selected ${verdict.choice}, which requires ${selectedChoice.input.name} text input.`,
      );
      return undefined;
    }
    gate.status = "answered";
    return {
      request: gate.request,
      response: { choice: verdict.choice },
      actorId: DOBBY_ACTOR,
      chatId: this.options.roomId,
      eventId: gate.taskId,
      idempotencyKey: `fleet-gate:dobby:task:${gate.taskId}`,
      cursor,
    };
  }

  private async pollDiscord(
    gate: GateState,
    cursor: number,
  ): Promise<FleetGateVerifiedAnswer | undefined> {
    if (gate.cardId === undefined) return undefined;
    const answer = await this.readGateAnswer(gate);
    if (answer === undefined) return undefined;
    const choices = Object.keys(gate.request.choices);
    const choice = choices[answer.choiceIndex];
    if (choice === undefined) {
      this.log(`fleet-gate ignored invalid answer for ${gate.gateId}: choiceIndex out of range`);
      return undefined;
    }
    const actorId = `discord:${answer.userId}`;
    if (this.options.actors[actorId] !== "human") {
      this.log(`fleet-gate ignored invalid answer for ${gate.gateId}: user is not a human actor`);
      return undefined;
    }
    const definition = gate.request.choices[choice];
    if (definition?.input !== undefined) {
      this.log(`fleet-gate ignored invalid answer for ${gate.gateId}: choice requires text input`);
      return undefined;
    }
    gate.status = "answered";
    return {
      request: gate.request,
      response: { choice },
      actorId,
      chatId: this.options.roomId,
      eventId: answer.interactionId,
      idempotencyKey: `fleet-gate:dobby:discord:${answer.interactionId}`,
      cursor,
    };
  }

  private async escalate(gate: GateState, reason: string): Promise<void> {
    if (gate.status === "escalated") return;
    gate.status = "escalated";
    const existing = await this.findCard(gate.gateId);
    gate.cardId = existing ?? (await this.postCard(gate, reason));
  }

  private async findCard(gateId: string): Promise<string | undefined> {
    const messages = asArray(
      await this.discord("GET", `/channels/${this.options.roomId}/messages?limit=50`),
    );
    const found = messages.find((message) =>
      textField(message, "content")?.includes(this.cardMarker(gateId)),
    );
    return found === undefined ? undefined : textField(found, "id");
  }

  private async postCard(gate: GateState, reason: string): Promise<string> {
    const choices = Object.entries(gate.request.choices);
    const choiceText = choices
      .map(([choice, definition], index) => {
        return `${CHOICE_TEXT_MARKERS[index] ?? `${index + 1}.`} ${choice}: ${definition.label}`;
      })
      .join("\n");
    const components = buttonComponents(gate.gateId, choices);
    const posted = await this.discord("POST", `/channels/${this.options.roomId}/messages`, {
      content: `${this.cardMarker(gate.gateId)}\n<@${YIM_DISCORD_USER}>\n${renderDecisionText(
        gate.request,
      )}\n\nDobby reason (AI):\n${reason}\n\n${choiceText}`,
      components,
    });
    const cardId = textField(posted, "id");
    if (cardId === undefined) throw new Error("Discord card response did not include an id");
    return cardId;
  }

  private async readTask(taskId: string): Promise<Record<string, unknown> | undefined> {
    const read = this.options.fleetTasks.readTask ?? this.options.fleetTasks.getTask;
    if (read === undefined) return undefined;
    const task = await read(this.options.psiRoot, taskId);
    return asRecord(task) ?? undefined;
  }

  private async gateForSettlement(
    message: TelegramMessageReference,
    request: HumanDecisionChannelRequest | undefined,
  ): Promise<GateState | undefined> {
    const existing = [...this.gates.values()].find(
      (candidate) => candidate.taskId === message.messageId,
    );
    if (existing !== undefined) return existing;
    if (request === undefined) return undefined;
    const gate = await this.rehydrateGate(request, [message]);
    if (gate !== undefined) this.gates.set(request.decisionId, gate);
    return gate;
  }

  private async markSettlementUnknown(
    gate: GateState,
    errorCode: string,
  ): Promise<FleetGateSettlementResult> {
    gate.status = "settled";
    gate.settlementErrorCode = errorCode;
    await this.editUnknownSettlementCard(gate, errorCode);
    this.log(`fleet-gate settlement not confirmed for ${gate.gateId}: ${errorCode}`);
    return { state: "unknown", errorCode };
  }

  private async editUnknownSettlementCard(gate: GateState, errorCode: string): Promise<void> {
    const cardId = gate.cardId ?? (await this.findCard(gate.gateId));
    if (cardId === undefined) return;
    gate.cardId = cardId;
    await this.discord("PATCH", `/channels/${this.options.roomId}/messages/${cardId}`, {
      content: `${this.cardMarker(gate.gateId)}\nDecision settlement not confirmed (${errorCode}).`,
    });
  }

  private async logLateSettledVerdict(gate: GateState): Promise<void> {
    if (gate.lateVerdictLogged === true) return;
    const task = await this.readTask(gate.taskId);
    if (taskStatus(task) !== "done" || textField(task, "source_member") !== DOBBY_MEMBER) return;
    const summary = textField(task, "summary");
    if (summary === undefined || parseVerdict(summary, gate) === undefined) return;
    gate.lateVerdictLogged = true;
    this.log(`fleet-gate ignored late Dobby verdict for settled gate ${gate.gateId}`);
  }

  private log(message: string): void {
    if (this.options.logFn !== undefined) {
      this.options.logFn(message);
      return;
    }
    process.stderr.write(`${message}\n`);
  }

  private async readGateAnswer(gate: GateState): Promise<
    | {
        choiceIndex: number;
        userId: string;
        interactionId: string;
      }
    | undefined
  > {
    if (gate.cardId === undefined) return undefined;
    const file = path.join(
      this.options.answerDir ?? DEFAULT_GATE_ANSWER_DIR,
      `${gate.gateId}.json`,
    );
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      this.log(`fleet-gate ignored invalid answer for ${gate.gateId}: cannot read answer file`);
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.log(`fleet-gate ignored invalid answer for ${gate.gateId}: answer file is not JSON`);
      return undefined;
    }
    const answer = parseGateAnswer(parsed);
    if (answer === undefined) {
      this.log(`fleet-gate ignored invalid answer for ${gate.gateId}: answer schema is invalid`);
      return undefined;
    }
    if (answer.gateId !== gate.gateId) {
      this.log(`fleet-gate ignored invalid answer for ${gate.gateId}: gateId mismatch`);
      return undefined;
    }
    if (answer.messageId !== gate.cardId) {
      this.log(`fleet-gate ignored invalid answer for ${gate.gateId}: messageId mismatch`);
      return undefined;
    }
    if (answer.channelId !== this.options.roomId) {
      this.log(`fleet-gate ignored invalid answer for ${gate.gateId}: channelId mismatch`);
      return undefined;
    }
    const hmacKey = this.options.hmacKey ?? process.env.ORACLE_FLEET_HMAC_KEY;
    if (hmacKey === undefined || hmacKey.length === 0) {
      this.log(`fleet-gate ignored invalid answer for ${gate.gateId}: HMAC key is unavailable`);
      return undefined;
    }
    if (!verifyGateAnswerSignature(answer, hmacKey)) {
      this.log(`fleet-gate ignored invalid answer for ${gate.gateId}: signature mismatch`);
      return undefined;
    }
    return {
      choiceIndex: answer.choiceIndex,
      userId: answer.userId,
      interactionId: answer.interactionId,
    };
  }

  private async discord(method: string, route: string, body?: unknown): Promise<unknown> {
    const response = await this.request(
      `${this.options.apiBase ?? DEFAULT_DISCORD_API_BASE}${route}`,
      {
        method,
        headers: {
          authorization: `Bot ${this.options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok)
      throw new Error(`Discord ${method} ${route} failed with HTTP ${response.status}`);
    if (method === "PUT") return {};
    return await response.json();
  }

  private gateId(request: HumanDecisionChannelRequest): string {
    return createHash("sha256")
      .update(`${this.options.profile}\0${request.decisionId}\0${request.requestDigest}`)
      .digest("hex")
      .slice(0, 16);
  }

  private cardMarker(gateId: string): string {
    return `PIW-GATE-CARD ${gateId}`;
  }

  private async rehydrateGate(
    request: HumanDecisionChannelRequest,
    messages: readonly TelegramMessageReference[],
  ): Promise<GateState | undefined> {
    const charter = await fs.readFile(this.options.dobbyCharter, "utf8");
    const gateId = this.gateId(request);
    const body = renderTaskBody(request, gateId, charter);
    const message = messages.find(
      (candidate) =>
        candidate.chatId === this.options.roomId &&
        candidate.contentDigest === digestCanonical(body),
    );
    if (message === undefined) return undefined;
    return {
      gateId,
      request,
      taskId: message.messageId,
      taskCreatedAt: Date.now(),
      body,
      rules: parseRuleTable(charter),
      status: "open",
    };
  }
}

function pollRequestParts(value: HumanDecisionChannelRequest | ChannelPollRequest): {
  request: HumanDecisionChannelRequest;
  messages: TelegramMessageReference[];
} {
  const { messages, ...request } = value as HumanDecisionChannelRequest & {
    messages?: TelegramMessageReference[];
  };
  return {
    request,
    messages: Array.isArray(messages) ? messages : [],
  };
}

function renderTaskBody(
  request: HumanDecisionChannelRequest,
  gateId: string,
  charter: string,
): string {
  const choices = Object.keys(request.choices).join("|");
  return [
    renderDecisionText(request),
    "Dobby gate rules:",
    charter.trim(),
    "Verdict grammar:",
    `PIW-GATE v1 ${gateId} <${choices}|escalate> rule=<1-16>`,
  ].join("\n\n");
}

function buttonComponents(
  gateId: string,
  choices: Array<[string, HumanDecisionChannelRequest["choices"][string]]>,
): Array<{
  type: 1;
  components: Array<{ type: 2; style: 2; label: string; custom_id: string }>;
}> {
  const capacity = DISCORD_ACTION_ROW_LIMIT * DISCORD_BUTTONS_PER_ROW_LIMIT;
  if (choices.length > capacity) {
    throw new Error(`Fleet gate choices exceed Discord button capacity (${capacity})`);
  }
  const rows: Array<{
    type: 1;
    components: Array<{ type: 2; style: 2; label: string; custom_id: string }>;
  }> = [];
  for (const [index, [, definition]] of choices.entries()) {
    const customId = `piwgate:v1:${gateId}:${index}`;
    if (customId.length > DISCORD_BUTTON_CUSTOM_ID_LIMIT) {
      throw new Error("Fleet gate button custom_id exceeds Discord limit");
    }
    if (definition.label.length === 0 || definition.label.length > DISCORD_BUTTON_LABEL_LIMIT) {
      throw new Error("Fleet gate button label exceeds Discord limit");
    }
    const rowIndex = Math.floor(index / DISCORD_BUTTONS_PER_ROW_LIMIT);
    let row = rows[rowIndex];
    if (row === undefined) {
      row = { type: 1, components: [] };
      rows[rowIndex] = row;
    }
    row.components.push({
      type: 2,
      style: 2,
      label: definition.label,
      custom_id: customId,
    });
  }
  return rows;
}

function parseGateAnswer(value: unknown): GateAnswerFile | undefined {
  const answer = asRecord(value);
  if (
    answer?.schema !== "piw-gate-answer.v1" ||
    !Number.isSafeInteger(answer.choiceIndex) ||
    (answer.choiceIndex as number) < 0 ||
    typeof answer.gateId !== "string" ||
    typeof answer.userId !== "string" ||
    typeof answer.messageId !== "string" ||
    typeof answer.channelId !== "string" ||
    typeof answer.interactionId !== "string" ||
    typeof answer.at !== "string" ||
    typeof answer.sig !== "string" ||
    !/^[0-9a-f]{64}$/u.test(answer.sig)
  ) {
    return undefined;
  }
  return {
    schema: "piw-gate-answer.v1",
    gateId: answer.gateId,
    choiceIndex: answer.choiceIndex as number,
    userId: answer.userId,
    messageId: answer.messageId,
    channelId: answer.channelId,
    interactionId: answer.interactionId,
    at: answer.at,
    sig: answer.sig,
  };
}

function verifyGateAnswerSignature(answer: GateAnswerFile, hmacKey: string): boolean {
  const signedPayload = JSON.stringify([
    answer.schema,
    answer.gateId,
    answer.choiceIndex,
    answer.userId,
    answer.messageId,
    answer.channelId,
    answer.interactionId,
    answer.at,
  ]);
  const expected = createHmac("sha256", hmacKey).update(signedPayload).digest("hex");
  const actualBuffer = Buffer.from(answer.sig, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

// Parses the gate_policy block of Dobby's charter as it is actually written (fleet/dobby.yaml): the tier
// emoji sits on a SECTION HEADER line and the rules below it are plain "N. ..." lines. The first version
// required number and emoji on the same line, matched nothing in the real charter, and threw on every
// gate (found live 2026-10-08: pilot run stuck, delivery effect ambiguous). Only the gate_policy block is
// read, because the rest of the charter also uses 🟩🟨🟥 for other things.
function parseRuleTable(charter: string): Map<number, "green" | "yellow" | "red"> {
  const rules = new Map<number, "green" | "yellow" | "red">();
  const lines = charter.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^\s*gate_policy:\s*\|/u.test(line));
  if (start < 0) throw new Error("Dobby charter has no gate_policy block");
  const indent = (lines[start]?.match(/^\s*/u)?.[0].length ?? 0) + 1;
  let tier: "green" | "yellow" | "red" | undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && (line.match(/^\s*/u)?.[0].length ?? 0) < indent) break;
    const header = /^\s*(🟩|🟨|🟥)/u.exec(line)?.[1];
    if (header !== undefined) {
      tier = header === "🟩" ? "green" : header === "🟨" ? "yellow" : "red";
      continue;
    }
    const number = /^\s*([1-9]|1[0-6])\.\s/u.exec(line)?.[1];
    if (number !== undefined && tier !== undefined) rules.set(Number(number), tier);
  }
  for (let rule = 1; rule <= 16; rule += 1) {
    const expected = rule <= 6 ? "green" : rule <= 9 ? "yellow" : "red";
    if (rules.get(rule) !== expected) throw new Error("Dobby charter rule table is invalid");
  }
  return rules;
}

export { parseRuleTable as parseRuleTableForTest };

function parseVerdict(
  summary: string | undefined,
  gate: GateState,
): { choice: string; rule: number } | undefined {
  if (summary === undefined) return undefined;
  const lines = summary.split(/\r?\n/u);
  const matches = summary.match(/^PIW-GATE v1 \S+ \S+ rule=(?:[1-9]|1[0-6])$/gmu) ?? [];
  if (matches.length !== 1) return undefined;
  const match = lines[0]?.match(
    new RegExp(
      `^PIW-GATE v1 ${escapeRegExp(gate.gateId)} ([A-Za-z_][A-Za-z0-9_-]*|escalate) rule=([1-9]|1[0-6])$`,
      "u",
    ),
  );
  if (match === null || match === undefined) return undefined;
  return { choice: match[1] as string, rule: Number(match[2]) };
}

function taskIdFrom(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  const id = textField(record, "id") ?? textField(record, "task_id") ?? textField(record, "taskId");
  if (id === undefined) throw new Error("Fleet task creation did not return a task id");
  return id;
}

function taskStatus(value: Record<string, unknown> | undefined): string | undefined {
  return textField(value, "status");
}

function textField(value: unknown, field: string): string | undefined {
  const record = asRecord(value);
  return typeof record?.[field] === "string" ? (record[field] as string) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
