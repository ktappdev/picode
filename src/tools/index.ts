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

/** The model-facing picode_* tools: the five protocol tools (§14 — send,
 *  wait, status, list, journal) plus the two client-local on-hold controls
 *  (suspend/resume, Layer-2 only). */

export function registerTools(pi: ExtensionAPI, store: PicodeStore, inbox: Inbox) {
  registerIntrospectionTools(pi, store);
  registerMessagingTools(pi, store, inbox);
  registerControlTools(pi, store, inbox);
  registerSpawnTool(pi, store);
  registerTabCreateTool(pi, store);
  registerTabCloseTool(pi, store);
  registerPurgeTool(pi, store);
  registerCleanupPanesTool(pi, store);
  registerPanesTool(pi);
  registerPaneReadTool(pi);
  registerRunTool(pi);
  registerRoundTableTools(pi, store, inbox);
}
