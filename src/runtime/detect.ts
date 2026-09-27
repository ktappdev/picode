export type RuntimeKind = "herdr" | "tuios" | "none";

/** The selector is deliberately pure: no sockets or timers are opened while Pi
 * loads extensions (including print mode and resource discovery). */
export function detectRuntime(env: NodeJS.ProcessEnv = process.env): RuntimeKind {
  const choice = env.PICODE_RUNTIME || "auto";
  if (choice !== "auto" && choice !== "herdr" && choice !== "tuios") {
    throw new Error(`Invalid PICODE_RUNTIME=${JSON.stringify(choice)}; use auto, herdr or tuios.`);
  }
  const herdr = env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID;
  const tuios = !!env.TUIOS_SOCKET && !!env.TUIOS_SESSION && !!env.TUIOS_PANE_ID;
  if (choice === "herdr") {
    if (!herdr) throw new Error("PICODE_RUNTIME=herdr needs HERDR_ENV=1 and HERDR_PANE_ID.");
    return "herdr";
  }
  if (choice === "tuios") {
    if (!tuios) {
      throw new Error("PICODE_RUNTIME=tuios needs TUIOS_SOCKET, TUIOS_SESSION and TUIOS_PANE_ID.");
    }
    return "tuios";
  }
  if (herdr && tuios) {
    // TUIOS exports a Herdr *input-only* socket to certain harnesses. It is
    // not a second multiplexer; never send Herdr control calls to that socket.
    if (
      env.HERDR_SOCKET_PATH === `${env.TUIOS_SOCKET}.herdr` &&
      env.HERDR_PANE_ID === env.TUIOS_PANE_ID
    ) {
      return "tuios";
    }
    throw new Error(
      "Both Herdr and TUIOS identities are present; set PICODE_RUNTIME=herdr or tuios.",
    );
  }
  return tuios ? "tuios" : herdr ? "herdr" : "none";
}
