import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audienceChannels,
  decisionConfigDir,
  loadDecisionChannelConfig,
  verifyTelegramTokenFile,
  writeDecisionChannelProfile,
  type DecisionChannelConfig,
  type TelegramFetch,
} from "../src/channels/config.js";
import { makeTempDir } from "./helpers.js";

async function privateJson(filePath: string, value: unknown, mode = 0o600) {
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, { mode });
}

function piOnly(): DecisionChannelConfig {
  return {
    schema: "pi-workflows.channels.v1",
    audiences: { operator: { channels: ["pi"], accept: "first-valid-answer" } },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("decision channel configuration", () => {
  it("uses the configured directory or the private home default", () => {
    expect(decisionConfigDir({ PI_WORKFLOWS_CONFIG_DIR: "/configured" })).toBe("/configured");
    expect(decisionConfigDir({})).toBe(path.join(os.homedir(), ".config", "pi-workflows"));
  });

  it("resolves default and configured named audiences", () => {
    expect(audienceChannels(null, "operator")).toEqual(["pi"]);
    expect(audienceChannels(piOnly(), "operator")).toEqual(["pi"]);
    expect(audienceChannels(piOnly(), "missing")).toEqual(["pi"]);
  });

  it("returns null without configuration and loads Pi-only configuration", async () => {
    const configDir = await makeTempDir("decision-config-empty");
    expect(await loadDecisionChannelConfig(configDir)).toBeNull();
    await privateJson(path.join(configDir, "channels.json"), piOnly());
    expect(await loadDecisionChannelConfig(configDir)).toEqual({
      channels: piOnly(),
      credentials: {},
      configDir,
    });
  });

  it("rejects public, malformed, and inconsistent private profiles", async () => {
    const configDir = await makeTempDir("decision-config-invalid");
    const channelPath = path.join(configDir, "channels.json");
    await privateJson(channelPath, piOnly(), 0o644);
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/0600/);
    await fs.chmod(channelPath, 0o600);
    await privateJson(channelPath, { ...piOnly(), schema: "wrong" });
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/schema/);
    await privateJson(channelPath, {
      schema: "pi-workflows.channels.v1",
      audiences: {
        operator: { channels: ["telegram:missing"], accept: "first-valid-answer" },
      },
    });
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/unknown channel/);
  });

  it("rejects malformed audience and profile fields", async () => {
    const configDir = await makeTempDir("decision-config-malformed");
    const channelPath = path.join(configDir, "channels.json");
    await fs.writeFile(channelPath, "{", { mode: 0o600 });
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow();
    const invalid = [
      null,
      { schema: "pi-workflows.channels.v1", audiences: [] },
      { schema: "pi-workflows.channels.v1", audiences: {}, telegramProfiles: [] },
      {
        schema: "pi-workflows.channels.v1",
        audiences: {},
        telegramProfiles: { "bad/name": {} },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: {},
        telegramProfiles: { approval: null },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: {},
        telegramProfiles: {
          approval: { credential: "approval", allowedUserIds: "100", allowedChatIds: ["-200"] },
        },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: {},
        telegramProfiles: {
          approval: { credential: "approval", allowedUserIds: [], allowedChatIds: ["-200"] },
        },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: {},
        telegramProfiles: {
          approval: { credential: "approval", allowedUserIds: ["100"], allowedChatIds: ["bad"] },
        },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: {},
        telegramProfiles: {
          approval: { credential: "bad/name", allowedUserIds: ["100"], allowedChatIds: ["-200"] },
        },
      },
      { schema: "pi-workflows.channels.v1", audiences: { "bad/name": {} } },
      { schema: "pi-workflows.channels.v1", audiences: { operator: null } },
      {
        schema: "pi-workflows.channels.v1",
        audiences: { operator: { channels: ["pi"], accept: "last-answer" } },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: { operator: { channels: "pi", accept: "first-valid-answer" } },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: { operator: { channels: [], accept: "first-valid-answer" } },
      },
    ];
    for (const value of invalid) {
      await privateJson(channelPath, value);
      await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow();
    }
  });

  it("rejects malformed credential profile fields", async () => {
    const configDir = await makeTempDir("decision-credentials-malformed");
    await privateJson(path.join(configDir, "channels.json"), {
      schema: "pi-workflows.channels.v1",
      audiences: {
        operator: { channels: ["telegram:approval"], accept: "first-valid-answer" },
      },
      telegramProfiles: {
        approval: {
          credential: "approval",
          allowedUserIds: ["100"],
          allowedChatIds: ["-200"],
        },
      },
    });
    const credentialPath = path.join(configDir, "credentials.json");
    const invalid = [
      { schema: "wrong", telegram: {} },
      { schema: "pi-workflows.credentials.v1", telegram: [] },
      { schema: "pi-workflows.credentials.v1", fleetGate: [] },
      { schema: "pi-workflows.credentials.v1", telegram: { "bad/name": {} } },
      { schema: "pi-workflows.credentials.v1", telegram: { approval: null } },
      { schema: "pi-workflows.credentials.v1", telegram: { approval: {} } },
    ];
    for (const value of invalid) {
      await privateJson(credentialPath, value);
      await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow();
    }
  });

  it("rejects invalid credential references and token files", async () => {
    const configDir = await makeTempDir("decision-credential-invalid");
    const channelPath = path.join(configDir, "channels.json");
    const credentialPath = path.join(configDir, "credentials.json");
    await privateJson(channelPath, {
      schema: "pi-workflows.channels.v1",
      audiences: {
        operator: { channels: ["telegram:approval"], accept: "first-valid-answer" },
      },
      telegramProfiles: {
        approval: {
          credential: "approval",
          allowedUserIds: ["100"],
          allowedChatIds: ["-200"],
        },
      },
    });
    await privateJson(credentialPath, {
      schema: "pi-workflows.credentials.v1",
      telegram: { approval: { tokenFile: "relative" } },
    });
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/absolute/);
    await privateJson(credentialPath, {
      schema: "pi-workflows.credentials.v1",
      telegram: { approval: { tokenFile: configDir } },
    });
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/must be a file/);
    const tokenFile = path.join(configDir, "token");
    await fs.writeFile(tokenFile, "", { mode: 0o600 });
    await privateJson(credentialPath, {
      schema: "pi-workflows.credentials.v1",
      telegram: { approval: { tokenFile } },
    });
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/empty/);
    await fs.writeFile(tokenFile, "fixture");
    await fs.chmod(tokenFile, 0o644);
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/0600/);
  });

  it("reports every bounded Telegram verification failure", async () => {
    const configDir = await makeTempDir("decision-verify-invalid");
    const tokenFile = path.join(configDir, "token");
    await fs.writeFile(tokenFile, "fixture", { mode: 0o600 });
    await expect(verifyTelegramTokenFile("relative", async () => neverResponse())).rejects.toThrow(
      /absolute/,
    );
    await fs.writeFile(tokenFile, "");
    await expect(verifyTelegramTokenFile(tokenFile, async () => neverResponse())).rejects.toThrow(
      /empty/,
    );
    await fs.writeFile(tokenFile, "fixture");
    const throwing: TelegramFetch = async () => {
      throw new Error("offline");
    };
    await expect(verifyTelegramTokenFile(tokenFile, throwing)).rejects.toThrow(/did not return/);
    await expect(
      verifyTelegramTokenFile(tokenFile, async () => ({
        ok: false,
        status: 401,
        async json() {
          return {};
        },
      })),
    ).rejects.toThrow(/401/);
    await expect(
      verifyTelegramTokenFile(tokenFile, async () => ({
        ok: true,
        status: 200,
        async json() {
          return { ok: false };
        },
      })),
    ).rejects.toThrow(/rejected/);
  });

  it("writes a first private channel and credential profile", async () => {
    const configDir = await makeTempDir("decision-setup-first");
    const tokenFile = path.join(configDir, "token");
    await fs.writeFile(tokenFile, "fixture", { mode: 0o600 });
    await writeDecisionChannelProfile({
      configDir,
      audience: "operator",
      profile: "approval",
      credential: "approval",
      tokenFile,
      allowedUserIds: ["100"],
      allowedChatIds: ["-200"],
    });
    const loaded = await loadDecisionChannelConfig(configDir);
    expect(loaded?.channels.audiences.operator?.channels).toEqual(["pi", "telegram:approval"]);
    expect(loaded?.credentials.approval).toBe("fixture");
  });

  it("preserves delegate authority when adding Telegram to an existing audience", async () => {
    const configDir = await makeTempDir("decision-setup-delegates");
    const tokenFile = path.join(configDir, "token");
    const envFile = path.join(configDir, "discord.env");
    await fs.writeFile(tokenFile, "fixture", { mode: 0o600 });
    await fs.writeFile(envFile, "DISCORD_VOICE_TOKEN=fleet-token\n", { mode: 0o600 });
    await privateJson(path.join(configDir, "channels.json"), {
      schema: "pi-workflows.channels.v1",
      audiences: {
        operator: {
          channels: ["fleet-gate:dobby"],
          accept: "first-valid-answer",
          delegates: true,
        },
      },
      fleetGateProfiles: {
        dobby: {
          credential: "dobby",
          psiRoot: "/tmp/psi",
          fleetCoreDir: "/tmp/fleet-core",
          dobbyCharter: "/tmp/dobby.yaml",
          roomId: "1516161412873982136",
          actors: {
            "fleet:dobby": "delegate",
            "discord:722419769147654221": "human",
          },
          pickupMs: 1000,
          answerMs: 2000,
        },
      },
    });
    await privateJson(path.join(configDir, "credentials.json"), {
      schema: "pi-workflows.credentials.v1",
      telegram: {},
      fleetGate: { dobby: { envFile, variable: "DISCORD_VOICE_TOKEN" } },
    });
    await writeDecisionChannelProfile({
      configDir,
      audience: "operator",
      profile: "approval",
      credential: "approval",
      tokenFile,
      allowedUserIds: ["100"],
      allowedChatIds: ["-200"],
    });
    const loaded = await loadDecisionChannelConfig(configDir);
    expect(loaded?.channels.audiences.operator).toMatchObject({
      channels: ["fleet-gate:dobby", "telegram:approval"],
      delegates: true,
    });
  });

  it("loads a fleet gate profile with a token from an env file", async () => {
    const configDir = await makeTempDir("decision-fleet-gate");
    const envFile = path.join(configDir, "discord.env");
    await fs.writeFile(envFile, "DISCORD_VOICE_TOKEN=fixture-discord-token\n", { mode: 0o600 });
    await privateJson(path.join(configDir, "channels.json"), {
      schema: "pi-workflows.channels.v1",
      audiences: {
        operator: {
          channels: ["fleet-gate:dobby"],
          accept: "first-valid-answer",
          delegates: true,
        },
      },
      fleetGateProfiles: {
        dobby: {
          credential: "dobby",
          psiRoot: "/tmp/psi",
          fleetCoreDir: "/tmp/fleet-core",
          dobbyCharter: "/tmp/dobby.yaml",
          roomId: "1516161412873982136",
          actors: {
            "fleet:dobby": "delegate",
            "discord:722419769147654221": "human",
          },
          pickupMs: 1000,
          answerMs: 2000,
        },
      },
    });
    await privateJson(path.join(configDir, "credentials.json"), {
      schema: "pi-workflows.credentials.v1",
      fleetGate: { dobby: { envFile, variable: "DISCORD_VOICE_TOKEN" } },
    });
    const loaded = await loadDecisionChannelConfig(configDir);
    expect(loaded?.credentials.dobby).toBe("fixture-discord-token");
    expect(loaded?.channels.audiences.operator?.delegates).toBe(true);
    expect(loaded?.channels.fleetGateProfiles?.dobby?.actors["fleet:dobby"]).toBe("delegate");
  });

  it("loads a fleet gate HMAC credential for the adapter launch", async () => {
    const configDir = await makeTempDir("decision-fleet-gate-hmac");
    const tokenFile = path.join(configDir, "discord.env");
    const hmacFile = path.join(configDir, "hmac.env");
    await fs.writeFile(tokenFile, "DISCORD_TOKEN=fixture-discord-token\n", { mode: 0o600 });
    await fs.writeFile(hmacFile, "ORACLE_FLEET_HMAC_KEY=fixture-hmac-key\n", { mode: 0o600 });
    await privateJson(path.join(configDir, "channels.json"), fleetGateConfig("fleet-hmac"));
    await privateJson(path.join(configDir, "credentials.json"), {
      schema: "pi-workflows.credentials.v1",
      fleetGate: {
        dobby: { envFile: tokenFile, variable: "DISCORD_TOKEN" },
        "fleet-hmac": { envFile: hmacFile, variable: "ORACLE_FLEET_HMAC_KEY" },
      },
    });

    const loaded = await loadDecisionChannelConfig(configDir);
    expect(loaded?.channels.fleetGateProfiles?.dobby?.hmacCredential).toBe("fleet-hmac");
    expect(loaded?.credentials["fleet-hmac"]).toBe("fixture-hmac-key");
  });

  it.each([
    ["missing file", "missing", 0o600, "ORACLE_FLEET_HMAC_KEY=secret-never-report\n"],
    ["public file", "present", 0o644, "ORACLE_FLEET_HMAC_KEY=secret-never-report\n"],
    ["missing variable", "present", 0o600, "OTHER=secret-never-report\n"],
  ])("fails closed for a fleet gate HMAC credential with a %s", async (_case, file, mode, body) => {
    const configDir = await makeTempDir("decision-fleet-gate-hmac-invalid");
    const tokenFile = path.join(configDir, "discord.env");
    const hmacFile = path.join(configDir, "hmac.env");
    await fs.writeFile(tokenFile, "DISCORD_TOKEN=fixture-discord-token\n", { mode: 0o600 });
    if (file === "present") await fs.writeFile(hmacFile, body, { mode });
    await privateJson(path.join(configDir, "channels.json"), fleetGateConfig("fleet-hmac"));
    await privateJson(path.join(configDir, "credentials.json"), {
      schema: "pi-workflows.credentials.v1",
      fleetGate: {
        dobby: { envFile: tokenFile, variable: "DISCORD_TOKEN" },
        "fleet-hmac": { envFile: hmacFile, variable: "ORACLE_FLEET_HMAC_KEY" },
      },
    });

    const error = await loadDecisionChannelConfig(configDir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("secret-never-report");
  });

  it("rejects a credential id reused across Telegram and fleet gate profiles", async () => {
    const configDir = await makeTempDir("decision-credential-cross-type");
    const tokenFile = path.join(configDir, "telegram-token");
    const envFile = path.join(configDir, "discord.env");
    await fs.writeFile(tokenFile, "telegram-token", { mode: 0o600 });
    await fs.writeFile(envFile, "DISCORD_VOICE_TOKEN=fleet-token\n", { mode: 0o600 });
    await privateJson(path.join(configDir, "channels.json"), {
      schema: "pi-workflows.channels.v1",
      audiences: {
        operator: {
          channels: ["telegram:approval", "fleet-gate:dobby"],
          accept: "first-valid-answer",
          delegates: true,
        },
      },
      telegramProfiles: {
        approval: {
          credential: "shared",
          allowedUserIds: ["100"],
          allowedChatIds: ["-200"],
        },
      },
      fleetGateProfiles: {
        dobby: {
          credential: "shared",
          psiRoot: "/tmp/psi",
          fleetCoreDir: "/tmp/fleet-core",
          dobbyCharter: "/tmp/dobby.yaml",
          roomId: "1516161412873982136",
          actors: {
            "fleet:dobby": "delegate",
            "discord:722419769147654221": "human",
          },
          pickupMs: 1000,
          answerMs: 2000,
        },
      },
    });
    await privateJson(path.join(configDir, "credentials.json"), {
      schema: "pi-workflows.credentials.v1",
      telegram: { shared: { tokenFile } },
      fleetGate: { shared: { envFile, variable: "DISCORD_VOICE_TOKEN" } },
    });
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(
      /both telegram and fleet-gate/,
    );
  });

  it("rejects invalid setup values", async () => {
    const configDir = await makeTempDir("decision-setup-invalid");
    const tokenFile = path.join(configDir, "token");
    await fs.writeFile(tokenFile, "fixture", { mode: 0o600 });
    await expect(
      writeDecisionChannelProfile({
        configDir,
        audience: "operator",
        profile: "approval",
        credential: "approval",
        tokenFile,
        allowedUserIds: ["not-numeric"],
        allowedChatIds: ["-200"],
      }),
    ).rejects.toThrow(/numeric/);
    await expect(
      writeDecisionChannelProfile({
        configDir,
        audience: "operator",
        profile: "approval",
        credential: "approval",
        tokenFile: "relative-token-file",
        allowedUserIds: ["100"],
        allowedChatIds: ["-200"],
      }),
    ).rejects.toThrow(/absolute/);
  });
});

function fleetGateConfig(hmacCredential: string) {
  return {
    schema: "pi-workflows.channels.v1",
    audiences: {
      operator: {
        channels: ["fleet-gate:dobby"],
        accept: "first-valid-answer",
        delegates: true,
      },
    },
    fleetGateProfiles: {
      dobby: {
        credential: "dobby",
        hmacCredential,
        psiRoot: "/tmp/psi",
        fleetCoreDir: "/tmp/fleet-core",
        dobbyCharter: "/tmp/dobby.yaml",
        roomId: "1516161412873982136",
        actors: { "fleet:dobby": "delegate" },
        pickupMs: 1000,
        answerMs: 2000,
      },
    },
  };
}

function neverResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, result: {} };
    },
  };
}
