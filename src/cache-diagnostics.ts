import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PicodeStore } from "./core/types";
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
  type CachePromptSnapshot,
  type PayloadSnapshot,
  type PicodePromptTransport,
} from "./core/cache-diagnostics";

/** Explain a miss from what Picode can actually see, preferring request facts
 *  over prompt facts: the prompt is only part of the request body. */
function explainMiss(options: {
  modelChanged: boolean;
  promptChanges: string[] | null;
  payloadChanges: string[] | null;
  cacheRead: number;
  cacheReadAdvanced: boolean;
}): string {
  const reasons: string[] = [];

  if (options.modelChanged) reasons.push("the provider or model changed");

  if (options.payloadChanges === null && options.promptChanges === null) {
    reasons.push("no earlier snapshot is available for comparison");
  } else if (options.payloadChanges?.length) {
    reasons.push(`the request body changed at ${options.payloadChanges.join(", ")}`);
  }

  if (options.promptChanges?.length) {
    reasons.push(`the Picode prompt changed at ${options.promptChanges.join(", ")}`);
  }

  if (reasons.length === 0) {
    reasons.push("the Picode prompt and the request body were unchanged");
  }

  if (options.cacheRead > 0 && !options.cacheReadAdvanced) {
    reasons.push(
      `the cached prefix did not advance (still ${options.cacheRead.toLocaleString()} tokens)`,
    );
  } else if (options.cacheRead === 0) {
    reasons.push("the provider read nothing from cache");
  }

  return `${reasons.join("; ")}.`;
}

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
    transport: PicodePromptTransport,
  ): void;
} {
  let currentPrompt: CachePromptSnapshot | undefined;
  let previousResponsePrompt: CachePromptSnapshot | undefined;
  // The body of the most recent provider request, and the one that produced the
  // previous assistant message. `before_provider_request` fires only for real
  // agent requests — Pi's cache warmer calls the model runtime directly — so
  // these stay paired with responses instead of being polluted by warm ups.
  let currentPayload: PayloadSnapshot | undefined;
  let previousResponsePayload: PayloadSnapshot | undefined;

  pi.on("before_provider_request", (event, ctx) => {
    if (!isActive()) return;
    const snapshot = snapshotCachePayload(event.payload);
    if (!snapshot) return;
    currentPayload = snapshot;
    appendCacheDiagnostic(ctx.cwd, store.picodeId, {
      kind: "payload",
      timestamp: new Date().toISOString(),
      sessionHash: hashCacheSessionId(ctx.sessionManager.getSessionId()),
      role: store.role,
      snapshot,
    });
  });

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
    const payloadChanges = changedPayloadSegments(previousResponsePayload, currentPayload);
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
      payloadChanges,
      snapshot: currentPrompt ?? null,
    });

    if (assessment.status === "miss") {
      const explanation = explainMiss({
        modelChanged: assessment.modelChanged,
        promptChanges,
        payloadChanges,
        cacheRead: usage.cacheRead,
        cacheReadAdvanced: assessment.cacheReadAdvanced,
      });
      const warmerContext =
        previous?.source === "cache_warm"
          ? ` The preceding request was Pi's cache warmer (${previous.promptTokens.toLocaleString()} tokens${
              previous.cost === undefined ? "" : `, $${previous.cost.toFixed(4)}`
            }).`
          : "";
      ctx.ui.notify(
        `Picode cache diagnostic: ${assessment.reBilledTokens.toLocaleString()} previously-sent tokens were re-billed, plus ${assessment.newTokens.toLocaleString()} new. ${explanation}${warmerContext} Trace: ${tracePath}`,
        "warning",
      );
    }

    if (assessment.status !== "no-prompt") {
      previousResponsePrompt = currentPrompt;
      previousResponsePayload = currentPayload;
    }
  });

  return {
    reset() {
      currentPrompt = undefined;
      previousResponsePrompt = undefined;
      currentPayload = undefined;
      previousResponsePayload = undefined;
    },
    recordPrompt(ctx, basePrompt, picodePrompt, workerDigest, workerCount, transport) {
      currentPrompt = snapshotCachePrompt(
        basePrompt,
        picodePrompt,
        workerDigest,
        workerCount,
        transport,
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
