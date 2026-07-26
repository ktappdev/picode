/** Uniform tool-error payload: message for the model, ok:false for callers. */
export function err(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { ok: false },
  };
}

/** Strip emoji prefix from label to get the role name.
 *  Labels may have emoji prefix like "🔨 builder" — take the last word. */
export function extractRole(label: string): string {
  const parts = label.trim().split(/\s+/);
  return parts[parts.length - 1] || "";
}

/** Herdr pane IDs are workspace-local opaque IDs such as w1:p2. Keep shell
 * arguments constrained even though Herdr normally generates this format. */
export function isValidPaneId(paneId: string): boolean {
  return /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(paneId);
}
