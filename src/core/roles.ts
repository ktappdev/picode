/** Map of role name to a single emoji used as a visual identifier in the
 *  TUI footer status and terminal title. The fallback is for generic workers
 *  and unknown roles — never blank, so a missing mapping still renders
 *  something recognizable. */
export const ROLE_EMOJI: Record<string, string> = {
  coordinator: "🧭",
  builder: "🔨",
  reviewer: "🛡️",
  scout: "🔍",
  explorer: "🔍",
  designer: "🎨",
  tester: "🧪",
  "bug-hunter": "🐛",
};

export function roleEmoji(role: string | null | undefined): string {
  if (!role) return "👷";
  return ROLE_EMOJI[role] ?? "👷";
}
