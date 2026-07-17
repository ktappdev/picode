import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThreadStore } from "../core/types";
import type { Inbox } from "../inbox";
import { registerIntrospectionTools } from "./introspection";
import { registerMessagingTools } from "./messaging";
import { registerControlTools } from "./control";
import { registerSpawnTool } from "./spawn";
import { registerPurgeTool } from "./purge";
import { registerCleanupPanesTool } from "./cleanup-panes";

/** The model-facing thread_* tools: the five protocol tools (§14 — send,
 *  wait, status, list, journal) plus the two client-local on-hold controls
 *  (suspend/resume, Layer-2 only). */

export function registerTools(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
  registerIntrospectionTools(pi, store);
  registerMessagingTools(pi, store, inbox);
  registerControlTools(pi, store, inbox);
  registerSpawnTool(pi);
  registerPurgeTool(pi);
  registerCleanupPanesTool(pi);
}
