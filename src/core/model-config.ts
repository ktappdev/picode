import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ModelConfig = Record<string, string>;
export type ModelConfigScope = "global" | "project";
export type ModelConfigPaths = { global: string; project: string };

/** Built-in fallback values used when neither config scope pins a value. */
export const DEFAULT_MODELS: Readonly<ModelConfig> = Object.freeze({
  builder: "deepseek/deepseek-v4-pro",
  reviewer: "deepseek/deepseek-v4-pro",
  tester: "deepseek/deepseek-v4-pro",
  designer: "deepseek/deepseek-v4-pro",
  visionary: "opencode-go/mimo-v2.5",
  "bug-hunter": "deepseek/deepseek-v4-pro",
  scout: "deepseek/deepseek-v4-flash",
  default: "deepseek/deepseek-v4-flash",
  journal: "deepseek/deepseek-v4-flash",
  "journal-cadence": "done",
});

const PROJECT_CONFIG_DIR = ".picode";
const MODELS_FILENAME = "models.json";

function projectRoot(cwd: string): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root || cwd;
  } catch {
    return cwd;
  }
}

export function globalModelsPath(agentDir = getAgentDir()): string {
  return join(agentDir, PROJECT_CONFIG_DIR, MODELS_FILENAME);
}

export function modelsConfigPaths(cwd = process.cwd(), agentDir = getAgentDir()): ModelConfigPaths {
  return {
    global: globalModelsPath(agentDir),
    project: join(projectRoot(cwd), PROJECT_CONFIG_DIR, MODELS_FILENAME),
  };
}

/** Read one config file. Missing files mean no overrides; malformed files throw. */
export function readModelsConfig(modelsPath: string): ModelConfig {
  if (!existsSync(modelsPath)) return {};

  const parsed: unknown = JSON.parse(readFileSync(modelsPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${modelsPath} must contain a JSON object`);
  }

  const config: ModelConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`${modelsPath} value for "${key}" must be a string`);
    }
    config[key] = value;
  }
  return config;
}

/** Write one config file, creating its parent directory when needed. */
export function writeModelsConfig(modelsPath: string, config: ModelConfig): void {
  mkdirSync(dirname(modelsPath), { recursive: true });
  writeFileSync(modelsPath, JSON.stringify(config, null, 2) + "\n");
}

function readOverrides(modelsPath: string): ModelConfig {
  try {
    return readModelsConfig(modelsPath);
  } catch {
    // Model resolution must fall back safely; slash commands still surface
    // malformed JSON through readModelsConfig instead of overwriting it.
    return {};
  }
}

export function mergeModelsConfig(globalPath: string, projectPath: string): ModelConfig {
  return {
    ...DEFAULT_MODELS,
    ...readOverrides(globalPath),
    ...readOverrides(projectPath),
  };
}

/** Exact role, then longest hyphen-prefix role, then configured default. */
export function resolveConfiguredModel(config: ModelConfig, role: string): string {
  if (config[role]) return config[role];
  const prefix = Object.keys(config)
    .filter(key => role.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];
  return (prefix && config[prefix]) || config.default || "";
}

/** Resolve role from each scope before moving to the next scope. */
export function resolveModelFromConfigs(
  role: string,
  projectConfig: ModelConfig,
  globalConfig: ModelConfig,
): string {
  return (
    resolveConfiguredModel(projectConfig, role) ||
    resolveConfiguredModel(globalConfig, role) ||
    resolveConfiguredModel(DEFAULT_MODELS, role)
  );
}

export function resolveModelForRole(
  role: string,
  cwd = process.cwd(),
  agentDir = getAgentDir(),
): string {
  const paths = modelsConfigPaths(cwd, agentDir);
  return resolveModelFromConfigs(role, readOverrides(paths.project), readOverrides(paths.global));
}

/** Resolve effective settings: project override → global override → built-in. */
export function loadModelsConfig(cwd = process.cwd(), agentDir = getAgentDir()): ModelConfig {
  const paths = modelsConfigPaths(cwd, agentDir);
  const globalConfig = readOverrides(paths.global);
  const projectConfig = readOverrides(paths.project);
  const config = { ...DEFAULT_MODELS, ...globalConfig, ...projectConfig };
  for (const role of Object.keys(config)) {
    if (
      role === "theme" ||
      role === "coordinator" ||
      role === "journal" ||
      role.startsWith("journal-")
    ) {
      continue;
    }
    config[role] = resolveModelFromConfigs(role, projectConfig, globalConfig);
  }
  return config;
}
