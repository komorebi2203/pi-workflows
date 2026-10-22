import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRepos, repoName } from "../src/autocode/repos.js";

describe("repository allowlist", () => {
  function config(value: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), "piw-repos-")), "repos.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
  }
  it("loads a valid non-empty config", () => {
    const path = config({
      schema: "piw.repos.v1",
      repos: {
        "komorebi2203/autocode-sandbox": {
          verify: ["npm", "test"],
          base: "main",
        },
      },
    });
    expect(loadRepos(path)["komorebi2203/autocode-sandbox"]?.base).toBe("main");
  });
  it("allows safe npm installs and rejects lifecycle-enabled npm installs", () => {
    const safe = config({
      schema: "piw.repos.v1",
      repos: {
        "komorebi2203/fleet-gateway": {
          verify: ["npm", "test"],
          install: ["npm", "ci", "--ignore-scripts"],
          base: "main",
        },
      },
    });
    expect(loadRepos(safe)["komorebi2203/fleet-gateway"]?.install).toEqual([
      "npm",
      "ci",
      "--ignore-scripts",
    ]);
    expect(() =>
      loadRepos(
        config({
          schema: "piw.repos.v1",
          repos: {
            "komorebi2203/fleet-gateway": {
              verify: ["npm", "test"],
              install: ["npm", "ci"],
              base: "main",
            },
          },
        }),
      ),
    ).toThrow("repo-install-scripts-enabled");
    expect(() =>
      loadRepos(
        config({
          schema: "piw.repos.v1",
          repos: {
            "komorebi2203/fleet-gateway": {
              verify: ["npm", "test"],
              install: ["npm", "ci", "--ignore-scripts=false"],
              base: "main",
            },
          },
        }),
      ),
    ).toThrow("repo-install-scripts-enabled");
  });
  it("fails closed for missing, malformed, foreign, traversal, and empty configs", () => {
    expect(() => loadRepos("/definitely/missing/repos.json")).toThrow();
    const bad = join(mkdtempSync(join(tmpdir(), "piw-repos-")), "bad.json");
    writeFileSync(bad, "{");
    expect(() => loadRepos(bad)).toThrow();
    for (const slug of ["evil/autocode-sandbox", "komorebi2203/../x"])
      expect(() =>
        loadRepos(
          config({
            schema: "piw.repos.v1",
            repos: { [slug]: { verify: ["true"], base: "main" } },
          }),
        ),
      ).toThrow();
    expect(() => loadRepos(config({ schema: "piw.repos.v1", repos: {} }))).toThrow(
      "repos-config-empty",
    );
    expect(() => repoName("komorebi2203/../x")).toThrow();
  });
});
