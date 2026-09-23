import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  appendCacheDiagnostic,
  assessCacheUsage,
  changedPayloadSegments,
  changedPromptComponents,
  findPreviousCacheRequest,
  findPreviousPromptSnapshot,
  hashCacheSessionId,
  snapshotCachePayload,
  snapshotCachePrompt,
} from "../src/core/cache-diagnostics";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "picode-cache-diagnostics-"));
  tempDirs.push(dir);
  return dir;
}

function assistantEntry(options: {
  timestamp: number;
  input: number;
  cacheRead?: number;
  cacheWrite?: number;
}) {
  return {
    type: "message",
    message: {
      role: "assistant",
      provider: "openai-codex",
      model: "gpt-6-luna",
      timestamp: options.timestamp,
      usage: {
        input: options.input,
        cacheRead: options.cacheRead ?? 0,
        cacheWrite: options.cacheWrite ?? 0,
      },
    },
  };
}

describe("cache diagnostics", () => {
  it("fingerprints prompts without retaining their text and identifies changed components", () => {
    const previous = snapshotCachePrompt(
      "system secret",
      "rules\n\nworkers A",
      "workers A",
      1,
      "section A",
    );
    const current = snapshotCachePrompt(
      "system secret",
      "rules\n\nworkers B",
      "workers B",
      1,
      "section B",
    );

    assert.notEqual(previous.fullPromptHash, current.fullPromptHash);
    assert.deepEqual(changedPromptComponents(previous, current), ["Picode worker digest"]);
    assert.equal(JSON.stringify(previous).includes("system secret"), false);
    assert.equal(JSON.stringify(previous).includes("workers A"), false);
  });

  it("measures the full prompt as the base plus Picode's rendered contribution", () => {
    const base = "base prompt";
    const picode = "thread rules";
    const section = snapshotCachePrompt(base, picode, "", 0, `<picode>\n${picode}\n</picode>`);
    const legacy = snapshotCachePrompt(base, picode, "", 0, picode);

    // Same rules, two transport shapes: the section wrapper is part of what the
    // model sees, so the two fingerprints must differ.
    assert.equal(section.picodePromptHash, legacy.picodePromptHash);
    assert.notEqual(section.fullPromptHash, legacy.fullPromptHash);
    assert.equal(section.fullPromptChars, `${base}\n\n<picode>\n${picode}\n</picode>`.length);

    // An unchanged base and rules must not be reported as a Picode change even
    // though the wrapper participates in the full-prompt fingerprint.
    assert.deepEqual(changedPromptComponents(section, legacy), []);
  });

  it("finds previous usage and resets the baseline at a compaction boundary", () => {
    const previous = findPreviousCacheRequest([
      assistantEntry({ timestamp: 1_000, input: 2_000, cacheRead: 8_000 }),
      { type: "compaction", timestamp: "2026-09-23T00:00:00.000Z" },
    ]);

    assert.equal(previous, undefined);
  });

  it("keeps cache-warmer usage distinct from assistant requests", () => {
    assert.deepEqual(
      findPreviousCacheRequest([
        {
          type: "usage",
          kind: "cache_warm",
          provider: "openai-codex",
          model: "gpt-6-luna",
          timestamp: "1970-01-01T00:00:01.000Z",
          usage: {
            input: 500,
            cacheRead: 4_500,
            cacheWrite: 0,
            cost: { total: 0.005 },
          },
        },
      ]),
      {
        promptTokens: 5_000,
        cacheRead: 4_500,
        modelKey: "openai-codex/gpt-6-luna",
        timestamp: 1_000,
        reportedCache: true,
        source: "cache_warm",
        cost: 0.005,
      },
    );
  });

  it("detects a large miss after the provider has reported cache activity", () => {
    const previous = findPreviousCacheRequest([
      assistantEntry({ timestamp: 1_000, input: 2_000, cacheRead: 48_000 }),
    ]);
    assert.ok(previous);

    assert.deepEqual(
      assessCacheUsage(previous, {
        provider: "openai-codex",
        model: "gpt-6-luna",
        timestamp: 2_000,
        input: 50_000,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.05,
      }),
      {
        status: "miss",
        missedTokens: 50_000,
        reBilledTokens: 50_000,
        newTokens: 0,
        cacheReadAdvanced: false,
        idleMs: 1_000,
        modelChanged: false,
      },
    );
  });

  it("does not call unsupported-cache usage a miss and ignores breakpoint noise", () => {
    const noCacheBaseline = findPreviousCacheRequest([
      assistantEntry({ timestamp: 1_000, input: 50_000 }),
    ]);
    assert.ok(noCacheBaseline);
    assert.equal(
      assessCacheUsage(noCacheBaseline, {
        provider: "other",
        model: "uncached-model",
        timestamp: 2_000,
        input: 50_000,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      }).status,
      "cache-unreported",
    );

    const cachedBaseline = { ...noCacheBaseline, reportedCache: true };
    assert.deepEqual(
      assessCacheUsage(cachedBaseline, {
        provider: "openai-codex",
        model: "gpt-6-luna",
        timestamp: 2_000,
        input: 50_000,
        cacheRead: 49_500,
        cacheWrite: 0,
        cost: 0.01,
      }),
      {
        status: "within-noise-floor",
        missedTokens: 500,
        reBilledTokens: 500,
        newTokens: 49_500,
        cacheReadAdvanced: true,
      },
    );
  });

  it("separates re-billed tokens from new tokens when the cached prefix is frozen", () => {
    // The live shape that started this investigation: a workerless coordinator whose
    // cached prefix stops at the static prompt while the conversation keeps growing.
    const frozen = {
      promptTokens: 25_166,
      cacheRead: 24_064,
      modelKey: "openai-codex/gpt-5.6-luna",
      timestamp: 1_790_125_864_158,
      reportedCache: true,
      source: "assistant" as const,
    };

    assert.deepEqual(
      assessCacheUsage(frozen, {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        timestamp: 1_790_125_892_382,
        input: 1_158,
        cacheRead: 24_064,
        cacheWrite: 0,
        cost: 0.00147848,
      }),
      {
        status: "miss",
        missedTokens: 1_102,
        reBilledTokens: 1_102,
        newTokens: 56,
        cacheReadAdvanced: false,
        idleMs: 28_224,
        modelChanged: false,
      },
    );
  });

  it("does not call pure conversation growth a miss", () => {
    // Every token is either the new tail or a cache read, so nothing was re-billed
    // even though the prompt is larger than the previous one.
    assert.deepEqual(
      assessCacheUsage(
        {
          promptTokens: 10_000,
          cacheRead: 9_984,
          modelKey: "openai-codex/gpt-5.6-luna",
          timestamp: 1_000,
          reportedCache: true,
          source: "assistant",
        },
        {
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          timestamp: 2_000,
          input: 400,
          cacheRead: 10_368,
          cacheWrite: 0,
          cost: 0.001,
        },
      ),
      {
        status: "within-noise-floor",
        missedTokens: 0,
        reBilledTokens: 0,
        newTokens: 400,
        cacheReadAdvanced: true,
      },
    );
  });

  it("fingerprints the request body without retaining instructions, tools, or messages", () => {
    const snapshot = snapshotCachePayload({
      model: "gpt-5.6-luna",
      instructions: "private coordinator rules",
      prompt_cache_key: "session-secret-id",
      tools: [{ name: "bash", description: "private tool description" }],
      input: [
        { role: "developer", content: "private section patch" },
        { role: "user", content: [{ type: "input_text", text: "private operator prompt" }] },
      ],
    });

    assert.ok(snapshot);
    assert.equal(snapshot.toolsCount, 1);
    assert.equal(snapshot.segmentCount, 2);
    assert.deepEqual(
      snapshot.segments.map(s => [s.index, s.role]),
      [
        [0, "developer"],
        [1, "user"],
      ],
    );
    assert.equal(snapshot.instructionsChars, "private coordinator rules".length);

    const serialized = JSON.stringify(snapshot);
    for (const secret of [
      "private coordinator rules",
      "session-secret-id",
      "private tool description",
      "private section patch",
      "private operator prompt",
    ]) {
      assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
    }
  });

  it("names where the request prefix diverged, and stays quiet when it did not", () => {
    const base = {
      instructions: "rules",
      tools: [{ name: "bash" }],
      prompt_cache_key: "s",
      input: [
        { role: "developer", content: "patch" },
        { role: "user", content: "question" },
      ],
    };
    const before = snapshotCachePayload(base);
    assert.ok(before);

    assert.deepEqual(changedPayloadSegments(before, snapshotCachePayload(base)), []);
    assert.equal(changedPayloadSegments(undefined, before), null);

    const newSession = snapshotCachePayload({ ...base, prompt_cache_key: "other" });
    assert.deepEqual(changedPayloadSegments(before, newSession), [
      "provider cache key (session identity changed)",
    ]);

    const changedTail = snapshotCachePayload({
      ...base,
      input: [
        { role: "developer", content: "patch" },
        { role: "user", content: "different question" },
      ],
    });
    assert.deepEqual(changedPayloadSegments(before, changedTail), [
      "request message 1 (user)—the cached prefix ends here",
    ]);

    const changedHead = snapshotCachePayload({
      ...base,
      input: [
        { role: "developer", content: "different patch" },
        { role: "user", content: "question" },
      ],
    });
    assert.deepEqual(changedPayloadSegments(before, changedHead), [
      "request message 0 (developer)—the cached prefix ends here",
    ]);
  });

  it("persists only fingerprints and recovers the previous response fingerprint", () => {
    const cwd = tempDir();
    const snapshot = snapshotCachePrompt(
      "private system prompt",
      "private Picode prompt",
      "",
      0,
      "rendered private system prompt",
    );
    const tracePath = appendCacheDiagnostic(cwd, "../../unsafe-id", {
      kind: "response",
      timestamp: new Date(2_000).toISOString(),
      messageTimestamp: 2_000,
      sessionHash: hashCacheSessionId("session-1"),
      role: "coordinator",
      provider: "openai-codex",
      model: "gpt-6-luna",
      input: 1_000,
      cacheRead: 5_000,
      cacheWrite: 0,
      promptTokens: 6_000,
      cost: 0.01,
      previousRequest: null,
      assessment: { status: "no-baseline" },
      promptChanges: null,
      payloadChanges: null,
      snapshot,
    });
    const content = readFileSync(tracePath, "utf8");

    assert.ok(tracePath.startsWith(join(cwd, ".picode", "cache-diagnostics")));
    assert.equal(content.includes("private system prompt"), false);
    assert.equal(content.includes("private Picode prompt"), false);
    assert.equal(content.includes("session-1"), false);
    assert.deepEqual(
      findPreviousPromptSnapshot(cwd, "../../unsafe-id", "session-1", 2_000),
      snapshot,
    );
  });
});
