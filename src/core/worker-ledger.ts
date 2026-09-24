import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { readHandoff, type HandoffNote } from "./handoff";
import { STALE_MS } from "./types";

/** The recent-workers ledger: a bounded, derived view of who is around and
 *  what territory they know.
 *
 *  Nothing here is authored. Every field is derived from durable artifacts
 *  the worker already produced — `state.json` (identity, presence, session
 *  handle) and its session JSONL (the files it actually touched) — so a
 *  worker whose pane was killed out of existence still shows up. That is the
 *  whole point: the workers most worth reviving are the ones that never got
 *  to write anything down.
 *
 *  The ledger exists so the coordinator can *notice* a resumable worker at
 *  dispatch time instead of always reaching for `spawn_worker`. It narrows
 *  attention, not capability: eviction here does not make a picode
 *  unrevivable, it just stops advertising it. */

/** Today's default digest size. Bounded on purpose — this rides in the
 *  coordinator's system prompt, so it must stay small enough to be free. */
export const DEFAULT_LEDGER_LIMIT = 8;

/** Session files above this size are skipped rather than scanned. A worker
 *  with a session that large has its area covered by the other rows; reading
 *  it every run is not worth the wall clock. */
const MAX_SESSION_BYTES = 32 * 1024 * 1024;

/** How long a cached HEAD-commit lookup stays valid. The freshness check
 *  shells out to git, and `before_agent_start` fires per run — a short TTL
 *  keeps that to roughly one subprocess per burst of runs. */
const HEAD_TTL_MS = 15_000;

export interface LedgerRow {
  id: string;
  role: string;
  /** True when the picode is still running with a fresh heartbeat. A live
   *  worker is reachable with `picode_send` — strictly cheaper and safer
   *  than a revival, so the coordinator should see it in the same row. */
  live: boolean;
  /** Top directories the worker touched, most-touched first. Empty when no
   *  session file was found or it contained no file-touching tool calls. */
  area: string[];
  /** Last recorded picode state (`working`, `idle`, `done`, `stopped`, …).
   *  `done` means it finished a run; `stopped`/`idle` means it was cut off. */
  lastState: string;
  /** Last heartbeat before the worker stopped, ISO. */
  closedAt: string;
  contextAgeMinutes: number;
  /** Whether a commit landed after the worker last ran — i.e. whether its
   *  view of the tree can be trusted. `null` when git can't answer (no repo,
   *  no commits, git missing). Uncommitted changes are invisible to this. */
  headMovedSinceExit: boolean | null;
  handoff: HandoffNote | null;
}

interface RawState {
  id?: unknown;
  role?: unknown;
  sessionFile?: unknown;
  state?: unknown;
  lastSeen?: unknown;
  status?: unknown;
  pid?: unknown;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true; // EPERM or other — the process exists, we just can't signal it
  }
}

function readStateFile(path: string): RawState | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? (value as RawState) : null;
  } catch {
    return null;
  }
}

// ── Area derivation ─────────────────────────────────────────────────

/** Argument keys pi's file-touching tools use for their target path.
 *  Bash calls carry no path at all — accepted noise, since a worker's file
 *  reads and edits describe its territory far better than its shell history. */
const TOOL_PATH_KEYS = ["path", "file_path", "filePath"] as const;

const areaCache = new Map<string, { mtimeMs: number; area: string[] }>();

/** Normalise a tool-call path to a repo-relative directory bucket.
 *  Paths outside `cwd` are dropped — they describe someone else's territory. */
function areaBucket(toolPath: string, cwd: string): string | null {
  const absolute = isAbsolute(toolPath) ? toolPath : join(cwd, toolPath);
  const rel = relative(cwd, absolute);
  if (!rel || rel.startsWith("..")) return null;
  const dir = dirname(rel);
  return dir === "." || dir === "" ? "(root)" : dir;
}

/** Derive the directories a worker has touched, most-touched first, by
 *  streaming its session JSONL for assistant tool calls. Because `--session`
 *  appends, a revived worker's area accumulates across its whole life — a
 *  worker that has been revived once is a *better* candidate next time. */
export function deriveArea(sessionFile: string, cwd: string, maxDirs = 3): string[] {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  let raw: string;
  try {
    if (statSync(sessionFile).size > MAX_SESSION_BYTES) return [];
    raw = readFileSync(sessionFile, "utf8");
  } catch {
    return [];
  }

  const tally = new Map<string, number>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // one malformed line must not void the whole derivation
    }
    const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;

    for (const part of message.content) {
      const call = part as { type?: unknown; arguments?: Record<string, unknown> };
      if (call?.type !== "toolCall" || !call.arguments) continue;
      for (const key of TOOL_PATH_KEYS) {
        const value = call.arguments[key];
        if (typeof value !== "string" || !value) continue;
        const bucket = areaBucket(value, cwd);
        if (bucket) tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
        break;
      }
    }
  }

  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxDirs)
    .map(([dir]) => dir);
}

/** `deriveArea` memoised on the session file's mtime, so repeated digest
 *  builds in one coordinator lifetime scan each worker's session once. */
export function deriveAreaCached(sessionFile: string, cwd: string): string[] {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  let mtimeMs: number;
  try {
    mtimeMs = statSync(sessionFile).mtimeMs;
  } catch {
    return [];
  }
  const hit = areaCache.get(sessionFile);
  if (hit && hit.mtimeMs === mtimeMs) return hit.area;
  const area = deriveArea(sessionFile, cwd);
  areaCache.set(sessionFile, { mtimeMs, area });
  return area;
}

/** Test seam — the cache is module-level and must not leak between tests. */
export function clearAreaCache(): void {
  areaCache.clear();
}

// ── Freshness ───────────────────────────────────────────────────────

const headCache = new Map<string, { at: number; commitMs: number | null }>();

/** Timestamp of the newest commit on HEAD, or null when git can't answer.
 *  Comparing this against a worker's last heartbeat answers "has the tree
 *  moved since this worker last looked?" without storing a base commit. */
function headCommitMs(cwd: string): number | null {
  const cached = headCache.get(cwd);
  if (cached && Date.now() - cached.at < HEAD_TTL_MS) return cached.commitMs;

  let commitMs: number | null = null;
  try {
    const out = execSync("git log -1 --format=%ct", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    const seconds = Number(out);
    if (Number.isFinite(seconds) && seconds > 0) commitMs = seconds * 1000;
  } catch {
    commitMs = null;
  }
  headCache.set(cwd, { at: Date.now(), commitMs });
  return commitMs;
}

/** Test seam — see `clearAreaCache`. */
export function clearHeadCache(): void {
  headCache.clear();
}

/** True when a commit landed after `since`, false when HEAD is older, null
 *  when git can't tell us. Unknown is reported as unknown rather than
 *  guessed — a false "fresh" would invite a stale revival. */
export function headMovedSince(cwd: string, since: string): boolean | null {
  const commitMs = headCommitMs(cwd);
  if (commitMs === null) return null;
  const at = new Date(since).getTime();
  if (!Number.isFinite(at)) return null;
  return commitMs > at;
}

// ── Ledger ──────────────────────────────────────────────────────────

/** Build one row from a picode's on-disk record. Returns null when the
 *  record is unreadable, has no heartbeat, or belongs to the coordinator
 *  (which is a peer, not a resumable worker). */
function buildRow(picodesRootDir: string, id: string, cwd: string, now: number): LedgerRow | null {
  const picodeDir = join(picodesRootDir, id);
  const state = readStateFile(join(picodeDir, "state.json"));
  if (!state) return null;

  const lastSeen = str(state.lastSeen);
  if (!lastSeen) return null;
  const role = str(state.role) ?? "worker";
  if (role === "coordinator" || id === "coordinator") return null;

  const at = new Date(lastSeen).getTime();
  if (!Number.isFinite(at)) return null;
  const stale = now - at > STALE_MS;

  // Presence follows the one normative rule (§8.2): a stale heartbeat
  // overrides the stored status, so a hard-killed process reads as stopped
  // even though its state file still says "running".
  const pid = typeof state.pid === "number" ? state.pid : null;
  const live = !stale && state.status === "running" && (pid === null || isPidAlive(pid));

  const sessionFile = str(state.sessionFile);
  return {
    id,
    role,
    live,
    area: sessionFile ? deriveAreaCached(sessionFile, cwd) : [],
    lastState: str(state.state) ?? "unknown",
    closedAt: lastSeen,
    contextAgeMinutes: Math.max(0, Math.round((now - at) / 60_000)),
    headMovedSinceExit: headMovedSince(cwd, lastSeen),
    handoff: readHandoff(picodeDir),
  };
}

/** The most recent workers in this workspace, newest heartbeat first. */
export function recentWorkers(cwd: string, limit: number = DEFAULT_LEDGER_LIMIT): LedgerRow[] {
  const picodesRootDir = join(cwd, ".picode", "picodes");
  let ids: string[];
  try {
    ids = readdirSync(picodesRootDir);
  } catch {
    return []; // no workspace yet — not an error
  }

  const now = Date.now();
  const rows: LedgerRow[] = [];
  for (const id of ids) {
    const row = buildRow(picodesRootDir, id, cwd, now);
    if (row) rows.push(row);
  }
  rows.sort(
    (a, b) =>
      new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime() || a.id.localeCompare(b.id),
  );
  return rows.slice(0, Math.max(0, limit));
}

// ── Digest rendering ────────────────────────────────────────────────

/** Preserve age signal while preventing the coordinator prompt from changing every minute. */
function humanAge(minutes: number): string {
  if (minutes < 1) return "<1m";
  if (minutes < 5) return "<5m";
  if (minutes < 15) return "<15m";
  if (minutes < 60) return "<1h";
  if (minutes < 360) return "<6h";
  if (minutes < 1_440) return "<1d";
  return "1d+";
}

function clamp(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Stable roster stub for on-demand lookup. Liveness, age, area, handoff,
 *  and HEAD changes must not churn the coordinator's prompt prefix. */
export function formatWorkerStub(rows: readonly LedgerRow[]): string {
  if (rows.length === 0) return "(none)";
  return [...rows]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(row => `${row.id} (${row.role})`)
    .join("\n");
}

/** One line per worker: who, where they've worked, whether they're still
 *  live, and what they left unverified. Deliberately terse — this block is
 *  prepended to the coordinator's context on every run. */
export function formatWorkerDigest(rows: readonly LedgerRow[]): string {
  if (rows.length === 0) return "";

  const lines = rows.map(row => {
    const parts = [`${row.live ? "▶" : "·"} ${row.id} (${row.role})`];
    if (row.area.length > 0) parts.push(row.area.join(", "));
    parts.push(row.live ? "live" : `stopped ${humanAge(row.contextAgeMinutes)}`);
    if (!row.live && row.headMovedSinceExit === true) parts.push("HEAD moved since");
    if (row.handoff?.leftUnverified)
      parts.push(`left unverified: ${clamp(row.handoff.leftUnverified, 80)}`);
    return `- ${clamp(parts.join(" — "), 180)}`;
  });

  return [
    "### Recent workers (▶ live, · stopped)",
    "",
    "Areas are derived from the files each worker actually touched. A live worker is reachable with `picode_send`; a stopped one can be resumed with `revive_closed_session`, which restores its session.",
    "",
    ...lines,
  ].join("\n");
}
