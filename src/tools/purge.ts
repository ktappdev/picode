import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rmSync, readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const STALE_MS = 60_000;

function findProjectRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

interface StateFile {
  id: string;
  status: "running" | "stopped";
  state: string;
  lastSeen: string;
  obligations: unknown[];
  owed: unknown[];
}

function readStateJson(dirPath: string): StateFile | null {
  const p = join(dirPath, "state.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as StateFile;
  } catch {
    return null;
  }
}

function isStale(s: StateFile): boolean {
  return s.status === "stopped" || Date.now() - new Date(s.lastSeen).getTime() > STALE_MS;
}

function effectiveStatus(s: StateFile): string {
  const stale = s.lastSeen && Date.now() - new Date(s.lastSeen).getTime() > STALE_MS;
  if (stale && s.status !== "stopped") return "stopped*";
  return s.status || "unknown";
}

/** Purge stale picode data directories. Returns { purged, skipped, count }. */
export function purgeStalePcodes(
  root: string,
  currentThreadId: string | undefined,
  force: boolean,
): { purged: string[]; skipped: { id: string; reason: string }[]; count: number } {
  const threadsDir = join(root, ".picode", "picodes");

  if (!existsSync(threadsDir)) {
    return { purged: [], skipped: [], count: 0 };
  }

  let entries: string[];
  try {
    entries = readdirSync(threadsDir).filter(e => existsSync(join(threadsDir, e, "state.json")));
  } catch {
    entries = [];
  }

  const purged: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const id of entries) {
    const dirPath = join(threadsDir, id);
    const state = readStateJson(dirPath);

    if (!state) {
      skipped.push({ id, reason: "no state.json" });
      continue;
    }

    if (currentThreadId && id === currentThreadId) {
      skipped.push({ id, reason: "current picode" });
      continue;
    }

    if (!isStale(state)) {
      skipped.push({ id, reason: `active (${effectiveStatus(state)})` });
      continue;
    }

    const hasDebts = (state.obligations?.length ?? 0) > 0 || (state.owed?.length ?? 0) > 0;
    if (hasDebts && !force) {
      skipped.push({
        id,
        reason: `has pending debts (obligations: ${state.obligations?.length ?? 0}, owed: ${state.owed?.length ?? 0})`,
      });
      continue;
    }

    try {
      rmSync(dirPath, { recursive: true, force: true });
      purged.push(id);
    } catch (e) {
      skipped.push({ id, reason: `delete failed: ${String(e)}` });
    }
  }

  return { purged, skipped, count: purged.length };
}

export function registerPurgeTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "picode_purge",
    label: "Picode Purge",
    description:
      "Delete stale/dead picode data directories. Only removes threads with status 'stopped' or stale lastSeen (>60s) and no pending debts. Safe to run at end of session.",
    parameters: Type.Object({
      force: Type.Optional(
        Type.Boolean({
          description:
            "If true, also delete threads with pending obligations or owed replies (default: false)",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const currentThreadId = pi.getFlag("picode-id") as string | undefined;
      const root = findProjectRoot();
      const result = purgeStalePcodes(root, currentThreadId, params.force ?? false);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, ...result }),
          },
        ],
        details: { ok: true, ...result },
      };
    },
  });
}
