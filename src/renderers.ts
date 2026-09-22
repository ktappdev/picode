import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { isQuietTui } from "./core/quiet-tui";

/** CustomMessage content is a string or content parts; the model sees the
 *  same text either way, so collapse to plain text for rendering. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text")
    .map(c => c.text)
    .join("\n");
}

/** Worker→coordinator envelope batches, hidden from the operator's screen.
 *  Collapsed → one-line header per batch (sender + id, "+N more" if batched,
 *  ⚠ when any part was high urgency). Expanded → the full rendered envelope
 *  text, so the operator can still inspect a message on demand. The full
 *  content always reaches the model regardless of what this renders. */
export const envelopeMessageRenderer: MessageRenderer = (message, { expanded }, theme) => {
  const content = messageText(message.content);
  const details = message.details as { count?: number; highUrgency?: boolean } | undefined;
  const count = details?.count ?? 1;

  // Quiet mode: a collapsed low-urgency batch renders as an empty Text — zero
  // lines under the component's Spacer. The empty component MUST stay truthy:
  // CustomMessageComponent falls back to DEFAULT rendering (full content) when
  // a renderer returns nothing. High-urgency batches keep their ⚠ line so
  // escalations still surface, and expanded still shows everything — expand
  // is the in-place escape hatch while quiet.
  if (!expanded && isQuietTui() && !details?.highUrgency) return new Text("", 0, 0);

  // First envelope header line looks like "[kind from <id> #<eid> re #<rid>]".
  const firstHeader = /^\[([^\]]+)\]/.exec(content)?.[1] ?? "incoming envelope";
  const more = count > 1 ? theme.fg("dim", `  (+${count - 1} more)`) : "";
  const marker = details?.highUrgency ? theme.fg("warning", "⚠ ") : "";
  const collapsed = `${marker}${theme.fg("customMessageLabel", "📨 ")}${theme.fg("dim", firstHeader)}${more}`;

  return systemBox(
    theme,
    expanded,
    collapsed,
    theme.fg("customMessageLabel", "📨 incoming envelopes"),
    content,
  );
};

/** Coordinator-internal system prompts (sit-rep timer, startup resume, owed
 *  reminder) — machine traffic the operator doesn't act on. Collapsed → one
 *  line naming the traffic; expanded → the full prompt text. */
export const systemMessageRenderer: MessageRenderer = (message, { expanded }, theme) => {
  const content = messageText(message.content);
  // Quiet mode: same truthy-empty rule as the envelope renderer above.
  if (!expanded && isQuietTui()) return new Text("", 0, 0);
  const firstLine = content.split("\n", 1)[0] ?? "";
  const summary = firstLine.replace(/^\[picode-system\]\s*/, "").slice(0, 72);
  const collapsed = `${theme.fg("customMessageLabel", "⚙ ")}${theme.fg("dim", summary)}`;
  return systemBox(
    theme,
    expanded,
    collapsed,
    theme.fg("customMessageLabel", "⚙ picode system"),
    content,
  );
};

function systemBox(
  theme: Theme,
  expanded: boolean,
  collapsedLine: string,
  expandedLabel: string,
  content: string,
): Component {
  const box = new Box(1, 1, t => theme.bg("customMessageBg", t));
  if (expanded) {
    box.addChild(new Text(expandedLabel, 0, 0));
    box.addChild(new Text(theme.fg("customMessageText", content), 0, 0));
  } else {
    box.addChild(new Text(collapsedLine, 0, 0));
  }
  return box;
}
