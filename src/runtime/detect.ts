export type RuntimeKind = "herdr" | "none";

/** The selector is deliberately pure: no sockets or timers are opened while Pi
 *  loads extensions (including print mode and resource discovery). */
export function detectRuntime(env: NodeJS.ProcessEnv = process.env): RuntimeKind {
  const choice = env.PICODE_RUNTIME || "auto";
  if (choice !== "auto" && choice !== "herdr") {
    throw new Error(`Invalid PICODE_RUNTIME=${JSON.stringify(choice)}; use auto or herdr.`);
  }
  const herdr = env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID;
  if (choice === "herdr" && !herdr) {
    throw new Error("PICODE_RUNTIME=herdr needs HERDR_ENV=1 and HERDR_PANE_ID.");
  }
  return herdr ? "herdr" : "none";
}
