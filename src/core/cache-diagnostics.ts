import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Pi ignores cache misses at or below this prefix granularity. */
export const CACHE_MISS_NOISE_FLOOR_TOKENS = 1_024;
const MAX_TRACE_BYTES = 1_000_000;

export interface CachePromptSnapshot {
  fullPromptHash: string;
  basePromptHash: string;
  picodePromptHash: string;
  picodeWithoutWorkersHash: string;
  workerDigestHash: string;
  fullPromptChars: number;
  workerCount: number;
}

export interface CacheUsageSample {
  provider: string;
  model: string;
  timestamp: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface PreviousCacheRequest {
  promptTokens: number;
  cacheRead: number;
  modelKey: string;
  timestamp: number;
  reportedCache: boolean;
  source: "assistant" | "cache_warm";
  cost?: number;
}

/** Segments of the real provider request, in the order the provider sees them. */
export interface PayloadSegment {
  index: number;
  role: string;
  type: string;
  hash: string;
  chars: number;
}

/** Fingerprint of the actual request body, so a prefix break can name its cause. */
export interface PayloadSnapshot {
  payloadHash: string;
  instructionsHash: string | null;
  instructionsChars: number | null;
  toolsHash: string | null;
  toolsCount: number | null;
  /** Null when the adapter sent no cache key, i.e. provider caching was off. */
  cacheKeyHash: string | null;
  segmentCount: number;
  segments: PayloadSegment[];
}

/** How many leading request segments to fingerprint. The prefix break shows up
 *  at the head, so a handful is enough to localise it. */
const PAYLOAD_SEGMENTS_KEPT = 8;

export type CacheAssessment =
  | { status: "no-baseline" }
  | { status: "no-prompt" }
  | { status: "cache-unreported" }
  | {
      status: "within-noise-floor";
      missedTokens: number;
      reBilledTokens: number;
      newTokens: number;
      cacheReadAdvanced: boolean;
    }
  | {
      status: "miss";
      missedTokens: number;
      reBilledTokens: number;
      newTokens: number;
      cacheReadAdvanced: boolean;
      idleMs: number;
      modelChanged: boolean;
    };

export type CacheDiagnosticRecord =
  | {
      kind: "prompt";
      timestamp: string;
      sessionHash: string;
      role: string;
      snapshot: CachePromptSnapshot;
    }
  | {
      kind: "payload";
      timestamp: string;
      sessionHash: string;
      role: string;
      snapshot: PayloadSnapshot;
    }
  | {
      kind: "response";
      timestamp: string;
      messageTimestamp: number;
      sessionHash: string;
      role: string;
      provider: string;
      model: string;
      input: number;
      cacheRead: number;
      cacheWrite: number;
      promptTokens: number;
      cost: number;
      previousRequest: PreviousCacheRequest | null;
      assessment: CacheAssessment;
      promptChanges: string[] | null;
      payloadChanges: string[] | null;
      snapshot: CachePromptSnapshot | null;
    };

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Avoid persisting Pi's session identifier in the local diagnostic trace. */
export function hashCacheSessionId(sessionId: string): string {
  return fingerprint(sessionId);
}

/** Hash prompt components only; never persist prompt text or worker notes.
 *
 * `picodeSection` is how Picode's content appears appended to Pi's rendered
 * prompt: the plain text on the legacy `systemPrompt` override path, or Pi's
 * `<picode>...</picode>` wrapper when the content travels as a structured
 * section. `fullPromptHash` is therefore a synthetic reconstruction of the
 * components Picode can see, in Pi's render order — a stable change detector,
 * not the literal provider payload (other extensions may append after us).
 */
export function snapshotCachePrompt(
  basePrompt: string,
  picodePrompt: string,
  workerDigest: string,
  workerCount: number,
  picodeSection: string,
): CachePromptSnapshot {
  const workerSuffix = workerDigest ? `\n\n${workerDigest}` : "";
  const picodeWithoutWorkers =
    workerSuffix && picodePrompt.endsWith(workerSuffix)
      ? picodePrompt.slice(0, -workerSuffix.length)
      : picodePrompt;
  const rendered = `${basePrompt}\n\n${picodeSection}`;
  return {
    fullPromptHash: fingerprint(rendered),
    basePromptHash: fingerprint(basePrompt),
    picodePromptHash: fingerprint(picodePrompt),
    picodeWithoutWorkersHash: fingerprint(picodeWithoutWorkers),
    workerDigestHash: fingerprint(workerDigest),
    fullPromptChars: rendered.length,
    workerCount,
  };
}

/** Describe which Picode/Pi prompt components changed since the last request. */
export function changedPromptComponents(
  previous: CachePromptSnapshot | undefined,
  current: CachePromptSnapshot | undefined,
): string[] | null {
  if (!previous || !current) return null;

  const changes: string[] = [];
  if (previous.basePromptHash !== current.basePromptHash) {
    changes.push("Pi or preceding-extension system prompt");
  }
  if (previous.workerDigestHash !== current.workerDigestHash) {
    changes.push("Picode worker digest");
  }
  if (previous.picodeWithoutWorkersHash !== current.picodeWithoutWorkersHash) {
    changes.push("Picode rules, override, or revival notice");
  }
  return changes;
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function promptTokens(usage: Record<string, unknown>): number {
  return (
    (finiteNumber(usage.input) ?? 0) +
    (finiteNumber(usage.cacheRead) ?? 0) +
    (finiteNumber(usage.cacheWrite) ?? 0)
  );
}

function totalCost(usage: Record<string, unknown>): number | undefined {
  const cost = object(usage.cost);
  return cost ? finiteNumber(cost.total) : undefined;
}

/** Find the previous cacheable request from Pi's current session branch. */
export function findPreviousCacheRequest(
  entries: readonly unknown[],
): PreviousCacheRequest | undefined {
  let previous: PreviousCacheRequest | undefined;

  for (const entryValue of entries) {
    const entry = object(entryValue);
    if (!entry) continue;

    if (entry.type === "compaction" || entry.type === "branch_summary") {
      previous = undefined;
      continue;
    }

    if (entry.type === "usage" && entry.kind === "cache_warm") {
      const usage = object(entry.usage);
      const tokens = usage ? promptTokens(usage) : 0;
      const timestamp = timestampMs(entry.timestamp);
      if (tokens > 0 && timestamp !== undefined) {
        previous = {
          promptTokens: tokens,
          cacheRead: usage ? (finiteNumber(usage.cacheRead) ?? 0) : 0,
          modelKey: `${String(entry.provider ?? "")}/${String(entry.model ?? "")}`,
          timestamp,
          reportedCache: true,
          source: "cache_warm",
          cost: usage ? totalCost(usage) : undefined,
        };
      }
      continue;
    }

    if (entry.type !== "message") continue;
    const message = object(entry.message);
    if (!message || message.role !== "assistant") continue;
    const usage = object(message.usage);
    if (!usage) continue;

    const tokens = promptTokens(usage);
    if (tokens <= 0) continue;
    const timestamp = timestampMs(message.timestamp);
    if (timestamp === undefined) continue;
    previous = {
      promptTokens: tokens,
      cacheRead: finiteNumber(usage.cacheRead) ?? 0,
      modelKey: `${String(message.provider ?? "")}/${String(message.model ?? "")}`,
      timestamp,
      reportedCache:
        (previous?.reportedCache ?? false) ||
        (finiteNumber(usage.cacheRead) ?? 0) + (finiteNumber(usage.cacheWrite) ?? 0) > 0,
      source: "assistant",
      cost: totalCost(usage),
    };
  }

  return previous;
}

/** Compare provider usage with the previous prompt, following Pi's cache-miss threshold. */
export function assessCacheUsage(
  previous: PreviousCacheRequest | undefined,
  current: CacheUsageSample,
): CacheAssessment {
  const currentPromptTokens = current.input + current.cacheRead + current.cacheWrite;
  if (currentPromptTokens <= 0) return { status: "no-prompt" };
  if (!previous) return { status: "no-baseline" };
  if (current.cacheRead + current.cacheWrite === 0 && !previous.reportedCache) {
    return { status: "cache-unreported" };
  }

  const missedTokens = Math.max(
    0,
    Math.min(previous.promptTokens, currentPromptTokens) - current.cacheRead,
  );
  // A request is billed as two buckets. Tokens the provider had already seen are
  // waste when they are not cache-read; tokens beyond the largest prompt the
  // provider has seen (or the cached prefix) are new content and always cost
  // full price. Conflating the two makes a growing conversation look like a
  // prefix break, which is the misreading this split exists to prevent.
  const frontier = Math.max(previous.promptTokens, current.cacheRead);
  const newTokens = Math.max(0, currentPromptTokens - frontier);
  const reBilledTokens = Math.max(0, currentPromptTokens - current.cacheRead - newTokens);
  const cacheReadAdvanced = current.cacheRead > previous.cacheRead;

  if (missedTokens <= CACHE_MISS_NOISE_FLOOR_TOKENS) {
    return {
      status: "within-noise-floor",
      missedTokens,
      reBilledTokens,
      newTokens,
      cacheReadAdvanced,
    };
  }

  return {
    status: "miss",
    missedTokens,
    reBilledTokens,
    newTokens,
    cacheReadAdvanced,
    idleMs: Math.max(0, current.timestamp - previous.timestamp),
    modelChanged: `${current.provider}/${current.model}` !== previous.modelKey,
  };
}

function segment(value: unknown, index: number): PayloadSegment {
  const item = object(value);
  if (!item) {
    const text = typeof value === "string" ? value : safeJson(value);
    return { index, role: "?", type: typeof value, hash: fingerprint(text), chars: text.length };
  }
  const role = typeof item.role === "string" ? item.role : "?";
  const type = typeof item.type === "string" ? item.type : "?";
  const content = item.content ?? item.text ?? item;
  const text = typeof content === "string" ? content : safeJson(content);
  return { index, role, type, hash: fingerprint(text), chars: text.length };
}

/** Never throw on a cyclic or exotic payload; hashing must not break a request. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function payloadItems(body: Record<string, unknown>): unknown[] {
  // Responses-style bodies carry `input`; chat-style bodies carry `messages`.
  for (const key of ["input", "messages"]) {
    const value = body[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** Fingerprint the real request body so a prefix break can name its own cause.
 *
 * Only hashes and lengths are kept — never request content. The provider caches
 * a prefix in the order it receives it (instructions, then tools, then input
 * messages), so each segment is hashed separately and the first difference names
 * where the prefix was lost.
 */
export function snapshotCachePayload(payload: unknown): PayloadSnapshot | undefined {
  const body = object(payload);
  if (!body) return undefined;

  const instructions =
    typeof body.instructions === "string"
      ? body.instructions
      : typeof body.system === "string"
        ? body.system
        : undefined;
  const tools = Array.isArray(body.tools) ? body.tools : undefined;
  const cacheKey = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined;
  const items = payloadItems(body);

  return {
    payloadHash: fingerprint(safeJson({ instructions, tools, items })),
    instructionsHash: instructions === undefined ? null : fingerprint(instructions),
    instructionsChars: instructions?.length ?? null,
    toolsHash: tools === undefined ? null : fingerprint(safeJson(tools)),
    toolsCount: tools?.length ?? null,
    cacheKeyHash: cacheKey === undefined ? null : fingerprint(cacheKey),
    segmentCount: items.length,
    segments: items.slice(0, PAYLOAD_SEGMENTS_KEPT).map(segment),
  };
}

/** Name the first part of the request that differs from the previous one. */
export function changedPayloadSegments(
  previous: PayloadSnapshot | undefined,
  current: PayloadSnapshot | undefined,
): string[] | null {
  if (!previous || !current) return null;

  const changes: string[] = [];
  if (previous.instructionsHash !== current.instructionsHash) {
    changes.push("provider instructions");
  }
  if (previous.toolsHash !== current.toolsHash) {
    changes.push(
      `tool definitions (${previous.toolsCount ?? "?"} -> ${current.toolsCount ?? "?"})`,
    );
  }
  if (previous.cacheKeyHash !== current.cacheKeyHash) {
    changes.push("provider cache key (session identity changed)");
  }

  const shared = Math.min(previous.segments.length, current.segments.length);
  for (let index = 0; index < shared; index++) {
    const before = previous.segments[index];
    const after = current.segments[index];
    if (before.hash !== after.hash || before.role !== after.role) {
      changes.push(`request message ${index} (${after.role})—the cached prefix ends here`);
      break;
    }
  }

  return changes;
}

function tracePath(cwd: string, picodeId: string): string {
  // Hash the user-controlled id so it cannot become a path segment.
  const idHash = fingerprint(picodeId).slice(0, 16);
  return join(cwd, ".picode", "cache-diagnostics", `${idHash}.jsonl`);
}

function trimTrace(path: string): void {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const kept: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const lineBytes = Buffer.byteLength(lines[index]) + 1;
    if (bytes + lineBytes > Math.floor(MAX_TRACE_BYTES / 2)) break;
    kept.unshift(lines[index]);
    bytes += lineBytes;
  }
  writeFileSync(path, kept.length ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
}

/** Append a bounded, local-only trace containing fingerprints and usage counters. */
export function appendCacheDiagnostic(
  cwd: string,
  picodeId: string,
  record: CacheDiagnosticRecord,
): string {
  const path = tracePath(cwd, picodeId);
  try {
    mkdirSync(join(cwd, ".picode", "cache-diagnostics"), { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > MAX_TRACE_BYTES) {
      trimTrace(path);
    }
    appendFileSync(path, line, { mode: 0o600 });
  } catch (error) {
    console.error("[picode] cache diagnostic write failed:", error);
  }
  return path;
}

/** Recover the prompt fingerprint paired with the previous request after a session resume. */
export function findPreviousPromptSnapshot(
  cwd: string,
  picodeId: string,
  sessionId: string,
  atOrBefore: number,
): CachePromptSnapshot | undefined {
  const path = tracePath(cwd, picodeId);
  if (!existsSync(path)) return undefined;

  try {
    const lines = readFileSync(path, "utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      if (!lines[index]) continue;
      let value: unknown;
      try {
        value = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      const record = object(value);
      if (
        record?.kind !== "response" ||
        record.sessionHash !== hashCacheSessionId(sessionId) ||
        (finiteNumber(record.messageTimestamp) ?? Number.POSITIVE_INFINITY) > atOrBefore
      ) {
        continue;
      }
      const snapshot = object(record.snapshot);
      const fullPromptHash = snapshot?.fullPromptHash;
      const basePromptHash = snapshot?.basePromptHash;
      const picodePromptHash = snapshot?.picodePromptHash;
      const picodeWithoutWorkersHash = snapshot?.picodeWithoutWorkersHash;
      const workerDigestHash = snapshot?.workerDigestHash;
      const fullPromptChars = snapshot?.fullPromptChars;
      const workerCount = snapshot?.workerCount;
      if (
        typeof fullPromptHash !== "string" ||
        typeof basePromptHash !== "string" ||
        typeof picodePromptHash !== "string" ||
        typeof picodeWithoutWorkersHash !== "string" ||
        typeof workerDigestHash !== "string" ||
        typeof fullPromptChars !== "number" ||
        typeof workerCount !== "number"
      ) {
        return undefined;
      }
      return {
        fullPromptHash,
        basePromptHash,
        picodePromptHash,
        picodeWithoutWorkersHash,
        workerDigestHash,
        fullPromptChars,
        workerCount,
      };
    }
  } catch (error) {
    console.error("[picode] cache diagnostic read failed:", error);
  }
  return undefined;
}
