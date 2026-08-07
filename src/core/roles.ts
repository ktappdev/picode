/** Map of role name to a single emoji used as a visual identifier in the
 *  TUI footer status and terminal title. The fallback is for generic workers
 *  and unknown roles — never blank, so a missing mapping still renders
 *  something recognizable. */
export const WORKER_ROLES = [
  "builder",
  "reviewer",
  "scout",
  "designer",
  "tester",
  "bug-hunter",
  "planner",
  "runner",
] as const;

/** Explorer is a legacy alias for scout. Keep one canonical runtime role. */
export function detectWorkerRole(id: string): string {
  const normalized = id.toLowerCase();
  const role = WORKER_ROLES.find(
    candidate =>
      normalized === candidate ||
      normalized.startsWith(`${candidate}-`) ||
      normalized.startsWith(`${candidate}_`) ||
      normalized.startsWith(`${candidate}.`),
  );
  if (role) return role;
  if (
    normalized === "explorer" ||
    normalized.startsWith("explorer-") ||
    normalized.startsWith("explorer_") ||
    normalized.startsWith("explorer.")
  ) {
    return "scout";
  }
  return "worker";
}

export const ROLE_EMOJI: Record<string, string> = {
  coordinator: "⚪",
  builder: "🔴",
  reviewer: "🔵",
  scout: "🟡",
  designer: "🟣",
  tester: "🟢",
  "bug-hunter": "🟠",
  planner: "🟤",
  runner: "⚫",
};

export function roleEmoji(role: string | null | undefined): string {
  if (!role) return "👷";
  return ROLE_EMOJI[role] ?? "👷";
}
