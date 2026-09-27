import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PicodeStore } from "../core/types";
import type { Inbox } from "../inbox";
import { registerIntrospectionTools } from "./introspection";
import { registerMessagingTools } from "./messaging";
import { registerControlTools } from "./control";
import { registerSpawnTool } from "./spawn";
import { registerTabCreateTool } from "./tab-create";
import { registerTabCloseTool } from "./tab-close";
import { registerPurgeTool } from "./purge";
import { registerCleanupPanesTool } from "./cleanup-panes";
import { registerPanesTool } from "./panes";
import { registerPaneReadTool } from "./pane-read";
import { registerRunTool } from "./run";
import { registerRoundTableTools } from "./round-table";
import { registerFinishTool } from "./finish";
import { registerReviveTool } from "./revive";
import { registerTuiosTools } from "./tuios-tools";
import { registerTuiosReviveTool } from "./tuios-revive";
import { registerTuiosRunTool } from "./tuios-run";
import { TuiosRuntime } from "../runtime/tuios";
import { detectRuntime } from "../runtime/detect";
import { trackTuiosPane, untrackTuiosPane } from "../runtime/tuios-listener";

/** The model-facing picode_* tools: the five protocol tools (§14 — send,
 *  wait, status, list, journal) plus the two client-local on-hold controls
 *  (suspend/resume, Layer-2 only). */

export function registerTools(pi: ExtensionAPI, store: PicodeStore, inbox: Inbox) {
  registerIntrospectionTools(pi, store);
  registerMessagingTools(pi, store, inbox);
  registerControlTools(pi, store, inbox);
  // Registration is synchronous; validate the daemon later at session_start.
  // An invalid/ambiguous identity is rejected by lifecycle before any tool
  // can run, not by throwing during extension discovery for unrelated Pi uses.
  let kind: ReturnType<typeof detectRuntime> = "none";
  try {
    kind = detectRuntime();
  } catch {
    /* lifecycle reports the actionable error */
  }
  if (kind === "tuios") {
    const runtime = new TuiosRuntime();
    registerTuiosTools(pi, store, runtime, {
      trackPane: trackTuiosPane,
      untrackPane: untrackTuiosPane,
    });
    registerTuiosRunTool(pi, runtime);
    registerTuiosReviveTool(pi, store, inbox, runtime);
    // Round-table's disposable session runner still speaks Herdr; don't
    // offer it in a TUIOS session until its control plane is ported.
  } else {
    registerSpawnTool(pi, store);
    registerTabCreateTool(pi, store);
    registerTabCloseTool(pi, store);
    registerCleanupPanesTool(pi, store);
    registerPanesTool(pi);
    registerPaneReadTool(pi);
    registerRunTool(pi);
    registerRoundTableTools(pi, store, inbox);
    registerReviveTool(pi, store, inbox);
  }
  registerPurgeTool(pi, store);
  registerFinishTool(pi, store, inbox);
}
