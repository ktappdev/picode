import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { projectRoot } from "./model-config";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThinkingConfig = Record<string, ThinkingLevel>;
export type ThinkingScope = "global" | "project";
export type ThinkingConfigPaths = { global: string; project: string };

/** Built-in thinking levels retained from the original worker-role defaults. */
export const DEFAULT_THINKING: Readonly<ThinkingConfig> = Object.freeze({
  builder: "high",
  reviewer: "high",
  "bug-hunter": "high",
  planner: "max",
  designer: "max",
  scout: "medium",
  explorer: "medium",
  visionary: "medium",
  gauntlet: "max",
  tester: "low",
  runner: "low",
});

const CONFIG_DIR = ".picode";
const FILENAME = "thinking.json";

export function thinkingConfigPaths(
  cwd = process.cwd(),
  agentDir = getAgentDir(),
): ThinkingConfigPaths {
  return {
    global: join(agentDir, CONFIG_DIR, FILENAME),
    project: join(projectRoot(cwd), CONFIG_DIR, FILENAME),
  };
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Missing config means no overrides; malformed values are surfaced to callers. */
export function readThinkingConfig(path: string): ThinkingConfig {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }

  const config: ThinkingConfig = {};
  for (const [role, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || !isThinkingLevel(value)) {
      throw new Error(`${path} value for "${role}" must be a valid thinking level`);
    }
    config[role] = value;
  }
  return config;
}

export function writeThinkingConfig(path: string, config: ThinkingConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

export function resetThinkingConfig(path: string, scope: ThinkingScope): void {
  if (scope === "global") {
    // Keep a valid empty global file, matching /picode-models reset behavior.
    writeThinkingConfig(path, {});
  } else if (existsSync(path)) {
    unlinkSync(path);
  }
}

function resolveFromConfig(config: ThinkingConfig, role: string): ThinkingLevel | undefined {
  if (config[role]) return config[role];
  const prefix = Object.keys(config)
    .filter(key => role.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? config[prefix] : undefined;
}

/** Project role/prefix override → global role/prefix override → built-in role default. */
export function resolveThinkingFromConfigs(
  role: string,
  project: ThinkingConfig,
  global: ThinkingConfig,
): ThinkingLevel | undefined {
  return (
    resolveFromConfig(project, role) ??
    resolveFromConfig(global, role) ??
    resolveFromConfig(DEFAULT_THINKING, role)
  );
}

/** Runtime resolution fails safely to built-in defaults if a config is malformed. */
export function loadThinkingConfig(
  cwd = process.cwd(),
  agentDir = getAgentDir(),
): { project: ThinkingConfig; global: ThinkingConfig } {
  const paths = thinkingConfigPaths(cwd, agentDir);
  let project: ThinkingConfig = {};
  let global: ThinkingConfig = {};
  try {
    project = readThinkingConfig(paths.project);
  } catch {
    // A broken project override should not prevent workers from launching.
  }
  try {
    global = readThinkingConfig(paths.global);
  } catch {
    // A broken global override should fall back to built-in defaults.
  }
  return { project, global };
}
