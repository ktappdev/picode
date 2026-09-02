import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rmSync, readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { quietToolResult } from "./shared";
import type { PicodeStore } from "../core/types";

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

export interface PurgeCleanup {
  clearedObligations: string[];
  clearedOwed: string[];
  updatedBarriers: string[];
  cancelledBarriers: string[];
}

function emptyPurgeCleanup(): PurgeCleanup {
  return {
    clearedObligations: [],
    clearedOwed: [],
    updatedBarriers: [],
    cancelledBarriers: [],
  };
}

type LedgerStore = Pick<PicodeStore, "obligations" | "owed" | "barriers">;

export function referencedPicodeIds(store: LedgerStore): Set<string> {
  return new Set([
    ...store.obligations.map(obligation => obligation.to),
    ...store.owed.map(owed => owed.from),
  ]);
}

/** Remove this picode's local ledger references to workers that were forgotten. */
export function reconcilePurgedPcodes(
  store: LedgerStore,
  purgedIds: readonly string[],
): PurgeCleanup {
  const purged = new Set(purgedIds);
  const clearedObligations = store.obligations
    .filter(obligation => purged.has(obligation.to))
    .map(obligation => obligation.id);
  const clearedObligationIds = new Set(clearedObligations);
  const clearedOwed = store.owed.filter(owed => purged.has(owed.from)).map(owed => owed.id);

  if (clearedObligations.length > 0) {
    store.obligations = store.obligations.filter(obligation => !purged.has(obligation.to));
  }
  if (clearedOwed.length > 0) {
    store.owed = store.owed.filter(owed => !purged.has(owed.from));
  }

  const updatedBarriers: string[] = [];
  const cancelledBarriers: string[] = [];
  const liveBarriers: typeof store.barriers = [];
  for (const barrier of store.barriers) {
    const pending = barrier.pending.filter(id => !clearedObligationIds.has(id));
    if (pending.length === barrier.pending.length) {
      liveBarriers.push(barrier);
      continue;
    }
    if (pending.length === 0) {
      cancelledBarriers.push(barrier.id);
      continue;
    }
    updatedBarriers.push(barrier.id);
    liveBarriers.push({ ...barrier, pending });
  }
  store.barriers = liveBarriers;

  return {
    clearedObligations,
    clearedOwed,
    updatedBarriers,
    cancelledBarriers,
  };
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
  protectedIds: ReadonlySet<string> = new Set(),
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

    if (!force && protectedIds.has(id)) {
      skipped.push({ id, reason: "referenced by current picode" });
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

export function registerPurgeTool(pi: ExtensionAPI, store: PicodeStore) {
  pi.registerTool({
    name: "picode_purge",
    label: "Picode Purge",
    description:
      "Delete stale/dead picode data directories. Default skips threads with pending local debts or references from this picode. force=true deletes them and reconciles this picode's obligations, owed replies, and barriers.",
    promptSnippet:
      "Delete stale/dead picode data; force=true forgets purged workers in coordinator ledgers.",
    parameters: Type.Object({
      force: Type.Optional(
        Type.Boolean({
          description:
            "If true, delete threads with pending debts and reconcile their coordinator ledger references (default: false)",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (store.role !== "coordinator") {
        return {
          content: [{ type: "text" as const, text: "picode_purge is coordinator-only." }],
          details: { ok: false },
        };
      }

      const currentThreadId = pi.getFlag("picode-id") as string | undefined;
      const force = params.force ?? false;
      const root = findProjectRoot();
      const result = purgeStalePcodes(
        root,
        currentThreadId,
        force,
        force ? new Set() : referencedPicodeIds(store),
      );
      const cleanup = force ? reconcilePurgedPcodes(store, result.purged) : emptyPurgeCleanup();
      if (
        cleanup.clearedObligations.length > 0 ||
        cleanup.clearedOwed.length > 0 ||
        cleanup.updatedBarriers.length > 0 ||
        cleanup.cancelledBarriers.length > 0
      ) {
        await store.persist();
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, ...result, cleanup }),
          },
        ],
        details: { ok: true, ...result, cleanup },
      };
    },
    renderResult: quietToolResult,
  });
}
