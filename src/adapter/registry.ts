import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalFsAdapter } from "./local-fs";
import type { PicodeAdapter } from "./types";
import { createRestateAdapter } from "../restate/adapter";

export interface AdapterOptions {
  /** Backend-specific connection target, e.g. a Restate ingress URL. */
  url?: string;
}

export type AdapterFactory = (opts: AdapterOptions) => PicodeAdapter;

/** Backend registry — the pluggability point for picode's storage
 *  layer. Adding a new backend (Temporal, etc.) means writing one factory
 *  and registering it here; nothing else in src/ needs to change. */
export const adapterRegistry: Record<string, AdapterFactory> = {
  local: () => createLocalFsAdapter(),
  restate: opts => createRestateAdapter(opts),
};

/** Resolve the configured backend from CLI flags: `--picode-storage
 *  <name>` (default "local") and `--picode-storage-url <url>`. */
export function createConfiguredAdapter(pi: ExtensionAPI): PicodeAdapter {
  const name = pi.getFlag("picode-storage");
  const backend = typeof name === "string" && name ? name : "local";
  const factory = adapterRegistry[backend];
  if (!factory) {
    const known = Object.keys(adapterRegistry).join(", ");
    throw new Error(`Unknown --picode-storage "${backend}". Known backends: ${known}.`);
  }
  const url = pi.getFlag("picode-storage-url");
  return factory({ url: typeof url === "string" && url ? url : undefined });
}
