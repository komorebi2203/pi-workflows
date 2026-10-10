import { readFileSync } from "node:fs";

export const DEFAULT_REPO = "komorebi2203/autocode-sandbox";
export type RepoConfig = {
  verify: [string, ...string[]];
  install?: [string, ...string[]];
  base: string;
};

export function loadRepos(
  path = process.env.PIW_REPOS_CONFIG ?? "/etc/piw-relay/repos.json",
): Record<string, RepoConfig> {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (
    !value ||
    typeof value !== "object" ||
    (value as { schema?: unknown }).schema !== "piw.repos.v1"
  )
    throw new Error("repos-config-invalid");
  const repos = (value as { repos?: unknown }).repos;
  if (
    !repos ||
    typeof repos !== "object" ||
    Array.isArray(repos) ||
    Object.keys(repos).length === 0
  )
    throw new Error("repos-config-empty");
  for (const [slug, raw] of Object.entries(repos)) {
    if (slug.includes("..") || !/^komorebi2203\/[A-Za-z0-9._-]+$/u.test(slug))
      throw new Error(`repo-slug-invalid:${slug}`);
    const config = raw as Partial<RepoConfig>;
    const validArgv = (argv: unknown): argv is [string, ...string[]] =>
      Array.isArray(argv) &&
      argv.length > 0 &&
      argv.every((part) => typeof part === "string" && part.length > 0);
    if (
      !config ||
      !validArgv(config.verify) ||
      (config.install !== undefined && !validArgv(config.install)) ||
      typeof config.base !== "string" ||
      !/^[A-Za-z0-9._/-]+$/u.test(config.base) ||
      config.base.includes("..")
    )
      throw new Error(`repo-config-invalid:${slug}`);
    if (
      config.install?.[0] === "npm" &&
      !config.install.some(
        (part) => part === "--ignore-scripts" || part === "--ignore-scripts=true",
      )
    )
      throw new Error(`repo-install-scripts-enabled:${slug}`);
  }
  return repos as Record<string, RepoConfig>;
}

export function repoName(slug: string): string {
  if (slug.includes("..") || !/^komorebi2203\/[A-Za-z0-9._-]+$/u.test(slug))
    throw new Error(`repo-slug-invalid:${slug}`);
  return slug.slice(slug.indexOf("/") + 1);
}

export function requireRepo(repos: Record<string, RepoConfig>, slug: string): RepoConfig {
  repoName(slug);
  const config = repos[slug];
  if (!config) throw new Error("repo-not-allowed");
  return config;
}

export function gatePath(slug: string, pr: string | number): string {
  return `${process.env.PIW_GATE_ROOT ?? "/srv/piw/state/gates"}/${repoName(slug)}/pr-${pr}.json`;
}
