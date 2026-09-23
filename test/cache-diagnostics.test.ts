import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  appendCacheDiagnostic,
  assessCacheUsage,
  changedPromptComponents,
  findPreviousCacheRequest,
  findPreviousPromptSnapshot,
  hashCacheSessionId,
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
      { status: "miss", missedTokens: 50_000, idleMs: 1_000, modelChanged: false },
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
      { status: "within-noise-floor", missedTokens: 500 },
    );
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
