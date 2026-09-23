import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PicodeStore } from "./core/types";
import {
  appendCacheDiagnostic,
  assessCacheUsage,
  changedPromptComponents,
  findPreviousCacheRequest,
  hashCacheSessionId,
  findPreviousPromptSnapshot,
  snapshotCachePrompt,
  type CachePromptSnapshot,
} from "./core/cache-diagnostics";

export function registerCacheDiagnostics(
  pi: ExtensionAPI,
  store: PicodeStore,
  isActive: () => boolean,
): {
  reset(): void;
  recordPrompt(
    ctx: ExtensionContext,
    basePrompt: string,
    picodePrompt: string,
    workerDigest: string,
    workerCount: number,
    picodeSection: string,
  ): void;
} {
  let currentPrompt: CachePromptSnapshot | undefined;
  let previousResponsePrompt: CachePromptSnapshot | undefined;

  pi.on("message_end", (event, ctx) => {
    if (!isActive() || event.message.role !== "assistant") return;

    const { message } = event;
    const { usage } = message;
    const previous = findPreviousCacheRequest(ctx.sessionManager.getEntries());
    const assessment = assessCacheUsage(previous, {
      provider: message.provider,
      model: message.model,
      timestamp: message.timestamp,
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: usage.cost.total,
    });
    const sessionId = ctx.sessionManager.getSessionId();
    const previousPrompt =
      previousResponsePrompt ??
      (previous
        ? findPreviousPromptSnapshot(ctx.cwd, store.picodeId, sessionId, previous.timestamp)
        : undefined);
    const promptChanges = changedPromptComponents(previousPrompt, currentPrompt);
    const tracePath = appendCacheDiagnostic(ctx.cwd, store.picodeId, {
      kind: "response",
      timestamp: new Date().toISOString(),
      messageTimestamp: message.timestamp,
      sessionHash: hashCacheSessionId(sessionId),
      role: store.role,
      provider: message.provider,
      model: message.model,
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      cost: usage.cost.total,
      previousRequest: previous ?? null,
      assessment,
      promptChanges,
      snapshot: currentPrompt ?? null,
    });

    if (assessment.status === "miss") {
      const likelyCause = assessment.modelChanged
        ? "The provider/model changed since the prior request."
        : promptChanges === null
          ? "No earlier Picode prompt fingerprint is available for comparison."
          : promptChanges.length > 0
            ? `Picode prompt changed: ${promptChanges.join(", ")}.`
            : "Picode prompt was unchanged; investigate provider/cache retention, session changes, or other extensions.";
      const warmerContext =
        previous?.source === "cache_warm"
          ? ` The preceding request was Pi's cache warmer (${previous.promptTokens.toLocaleString()} tokens${
              previous.cost === undefined ? "" : `, $${previous.cost.toFixed(4)}`
            }).`
          : "";
      ctx.ui.notify(
        `Picode cache diagnostic: about ${assessment.missedTokens.toLocaleString()} prior input tokens were not read from cache. ${likelyCause}${warmerContext} Trace: ${tracePath}`,
        "warning",
      );
    }

    if (assessment.status !== "no-prompt") previousResponsePrompt = currentPrompt;
  });

  return {
    reset() {
      currentPrompt = undefined;
      previousResponsePrompt = undefined;
    },
    recordPrompt(ctx, basePrompt, picodePrompt, workerDigest, workerCount, picodeSection) {
      currentPrompt = snapshotCachePrompt(
        basePrompt,
        picodePrompt,
        workerDigest,
        workerCount,
        picodeSection,
      );
      appendCacheDiagnostic(ctx.cwd, store.picodeId, {
        kind: "prompt",
        timestamp: new Date().toISOString(),
        sessionHash: hashCacheSessionId(ctx.sessionManager.getSessionId()),
        role: store.role,
        snapshot: currentPrompt,
      });
    },
  };
}
