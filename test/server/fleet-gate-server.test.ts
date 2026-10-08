import { describe, expect, it } from "vitest";
import type { DecisionChannelConfig } from "../../src/channels/config.js";
import type {
  ChannelAdapterLaunch,
  ChannelAdapterMessage,
  ChannelAdapterResponse,
} from "../../src/channels/protocol.js";
import { WorkflowServer } from "../../src/server/server.js";
import { ServerStateStore } from "../../src/server/state.js";
import { resourceIdFor } from "../../src/state/mutation.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { HumanDecisionStore } from "../../src/workflows/human-decision.js";
import {
  choice,
  compute,
  defineHumanChoices,
  defineWorkflow,
  humanDecision,
  humanDecisionEdge,
} from "../../src/workflows/index.js";
import type { HumanDecisionRequest } from "../../src/workflows/types.js";
import { ScriptedExecutor, makeStateDatabasePath } from "../helpers.js";

const ROOM = "1516161412873982136";
const EPOCH = "fleet-gate-test-epoch";

type MutableServer = {
  claim: unknown;
  decisionChannelConfig: DecisionChannelConfig | null;
  activeChannels: Map<string, unknown>;
  serverState: ServerStateStore;
  ensureChannelResource(channelId: string, profile: string, resourceId: string): void;
  handleChannelMessage(
    channelId: string,
    message: ChannelAdapterMessage,
  ): Promise<ChannelAdapterResponse>;
};

const choices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  stop: choice({ label: "Stop" }),
});

describe("fleet gate server authorization", () => {
  it("discord:999 answer rejected: not authorized by the server profile", async () => {
    const test = await serverFixture("fleet-gate", true);
    try {
      const response = await sendAnswer(test, { actorId: "discord:999" });
      expect(response).toMatchObject({
        outcome: "rejected",
        error: expect.stringContaining("not authorized"),
      });
      expect(readResolutionProvenance(test.databasePath)).toBeUndefined();
    } finally {
      await test.server.stop();
    }
  });

  it("old requestDigest rejected: request digest is stale", async () => {
    const test = await serverFixture("fleet-gate", true);
    try {
      const response = await sendAnswer(test, {
        actorId: "discord:722419769147654221",
        requestDigest: `sha256:${"f".repeat(64)}`,
      });
      expect(response).toMatchObject({
        outcome: "rejected",
        error: expect.stringContaining("request digest is stale"),
      });
      expect(readResolutionProvenance(test.databasePath)).toBeUndefined();
    } finally {
      await test.server.stop();
    }
  });

  it("fleet:dobby on audience owner rejected: delegate not permitted", async () => {
    const test = await serverFixture("owner", false);
    try {
      const response = await sendAnswer(test, { actorId: "fleet:dobby" });
      expect(response).toMatchObject({
        outcome: "rejected",
        error: expect.stringContaining("delegate answer is not permitted"),
      });
      expect(readResolutionProvenance(test.databasePath)).toBeUndefined();
    } finally {
      await test.server.stop();
    }
  });

  it("fleet:dobby accepted -> provenance delegate (never human)", async () => {
    const test = await serverFixture("fleet-gate", true);
    try {
      const response = await sendAnswer(test, { actorId: "fleet:dobby" });
      expect(response.outcome).toBe("accepted");
      expect(readResolutionProvenance(test.databasePath)).toBe("delegate");
    } finally {
      await test.server.stop();
    }
  });

  it("discord:722419769147654221 -> provenance human", async () => {
    const test = await serverFixture("fleet-gate", true);
    try {
      const response = await sendAnswer(test, { actorId: "discord:722419769147654221" });
      expect(response.outcome).toBe("accepted");
      expect(readResolutionProvenance(test.databasePath)).toBe("human");
    } finally {
      await test.server.stop();
    }
  });

  it("poll commands include confirmed delivery messages for adapter restart recovery", async () => {
    const test = await serverFixture("fleet-gate", true);
    try {
      const mutable = test.server as unknown as MutableServer;
      const ready = await mutable.handleChannelMessage(test.channelId, {
        schema: "pi-workflows.channel-adapter.v1",
        adapterEpoch: EPOCH,
        profile: "dobby",
        sequence: 1,
        expectedRevision: 0,
        stableMessageId: "ready-for-delivery",
        kind: "channel.ready",
        cursor: 0,
      });
      if (ready.command?.kind !== "channel.present") {
        throw new Error("expected presentation command");
      }
      const delivery = {
        chatId: ROOM,
        messageId: "task-1",
        recipientIndex: 0,
        partIndex: 0,
        contentDigest: "sha256:task-body",
      };
      const presented = await mutable.handleChannelMessage(test.channelId, {
        schema: "pi-workflows.channel-adapter.v1",
        adapterEpoch: EPOCH,
        profile: "dobby",
        sequence: 2,
        expectedRevision: ready.revision,
        stableMessageId: ready.command.stableMessageId,
        kind: "channel.present",
        decisionId: test.request.decisionId,
        requestDigest: test.request.requestDigest,
        attemptId: ready.command.attemptId,
        state: "confirmed",
        messages: [delivery],
      });
      expect(presented.command).toMatchObject({
        kind: "channel.poll",
        requests: [
          {
            decisionId: test.request.decisionId,
            requestDigest: test.request.requestDigest,
            messages: [delivery],
          },
        ],
      });
    } finally {
      await test.server.stop();
    }
  });
});

async function serverFixture(audience: string, delegates: boolean) {
  const databasePath = await makeStateDatabasePath("fleet-gate-server");
  const workflow = defineWorkflow({
    name: "fleet-gate-server-test",
    startAt: "approve",
    nodes: {
      approve: humanDecision({
        audience,
        choices,
        request: () => ({
          title: "Continue?",
          subject: { change: "safe" },
          presentation: {
            schema: "pi-workflows.decision-presentation.v1",
            summary: "Approve the safe change.",
            blocks: [],
          },
        }),
      }),
      continued: compute({ run: () => "continued" }),
      stopped: compute({ run: () => "stopped" }),
    },
    edges: [
      humanDecisionEdge({
        from: "approve",
        choices,
        cases: { continue: "continued", stop: "stopped" },
      }),
    ],
  });
  await new WorkflowEngine({
    databasePath,
    executor: new ScriptedExecutor(),
  }).run(workflow, {});
  const decisionStore = new HumanDecisionStore(databasePath);
  const request = (await decisionStore.listRequests())[0];
  decisionStore.close();
  if (request === undefined) throw new Error("decision request missing");

  const server = new WorkflowServer({ databasePath, runnerId: "fleet-gate-server-test" });
  const mutable = server as unknown as MutableServer;
  mutable.claim = mutable.serverState.acquireServer({
    serverId: "fleet-gate-server-test",
    pid: process.pid,
    processStartIdentity: "test-process",
    leaseMs: 60_000,
  });
  mutable.decisionChannelConfig = config(audience, delegates);
  const channelId = "fleet-gate:dobby";
  const resourceId = resourceIdFor("channel", channelId);
  mutable.ensureChannelResource(channelId, "dobby", resourceId);
  const launch: ChannelAdapterLaunch = {
    schema: "pi-workflows.channel-adapter-launch.v1",
    adapterType: "fleet-gate",
    adapterEpoch: EPOCH,
    profile: "dobby",
    token: "fixture-token",
    psiRoot: "/tmp/psi",
    fleetCoreDir: "/tmp/fleet-core",
    dobbyCharter: "/tmp/dobby.yaml",
    roomId: ROOM,
    actors: {
      "fleet:dobby": "delegate",
      "discord:722419769147654221": "human",
    },
    pickupMs: 1000,
    answerMs: 2000,
  };
  mutable.activeChannels.set(channelId, {
    profile: "dobby",
    adapterType: "fleet-gate",
    channelId,
    resourceId,
    launch,
    supervisor: { stop: async () => undefined },
    inFlight: new Set<string>(),
    stopping: false,
  });
  return { databasePath, server, request, channelId };
}

async function sendAnswer(
  test: {
    server: WorkflowServer;
    request: HumanDecisionRequest;
    channelId: string;
  },
  options: { actorId: string; requestDigest?: string },
): Promise<ChannelAdapterResponse> {
  const mutable = test.server as unknown as MutableServer;
  return await mutable.handleChannelMessage(test.channelId, {
    schema: "pi-workflows.channel-adapter.v1",
    adapterEpoch: EPOCH,
    profile: "dobby",
    sequence: 1,
    expectedRevision: 1,
    stableMessageId: `answer-${options.actorId}`,
    kind: "channel.answer",
    decisionId: test.request.decisionId,
    requestDigest: options.requestDigest ?? test.request.requestDigest,
    response: { choice: "continue" },
    actorId: options.actorId,
    chatId: ROOM,
    eventId: "event-1",
    idempotencyKey: `fleet-gate:test:${options.actorId}`,
    cursor: 1,
  });
}

function config(audience: string, delegates: boolean): DecisionChannelConfig {
  return {
    schema: "pi-workflows.channels.v1",
    audiences: {
      [audience]: {
        channels: ["fleet-gate:dobby"],
        accept: "first-valid-answer",
        ...(delegates ? { delegates: true } : {}),
      },
    },
    fleetGateProfiles: {
      dobby: {
        credential: "dobby",
        psiRoot: "/tmp/psi",
        fleetCoreDir: "/tmp/fleet-core",
        dobbyCharter: "/tmp/dobby.yaml",
        roomId: ROOM,
        actors: {
          "fleet:dobby": "delegate",
          "discord:722419769147654221": "human",
        },
        pickupMs: 1000,
        answerMs: 2000,
      },
    },
  };
}

function readResolutionProvenance(databasePath: string): string | undefined {
  const state = new ServerStateStore(databasePath, { readOnly: true });
  try {
    return (
      state.state.connection
        .prepare("SELECT provenance FROM human_decision_resolutions LIMIT 1")
        .get() as { provenance: string } | undefined
    )?.provenance;
  } finally {
    state.close();
  }
}
