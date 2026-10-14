// Shared by the Pi extension, monitoring CLI, and MCP server. Markdown is
// the only source of truth; the log intentionally lives outside picode dirs
// and outside the coordination backend so purging workers cannot erase it.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const HEADER =
  "# Picode papercuts\n\nTool, harness, and setup friction. Check an issue's Solved box to close it.\n";
const ISSUE_HEADING = /^## (PC-\d+) — (.+)$/gm;

export function issueJournalPath(cwd) {
  return path.join(cwd, ".picode", "issues.md");
}

function readContent(cwd) {
  try {
    return fs.readFileSync(issueJournalPath(cwd), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function parseIssues(content) {
  const headings = [...content.matchAll(ISSUE_HEADING)];
  if ((content.match(/^## PC-/gm) ?? []).length !== headings.length) {
    throw new Error(
      "Invalid issue heading in .picode/issues.md; preserve the '## PC-001 — Title' format.",
    );
  }
  const ids = new Set();
  return headings.map((heading, index) => {
    const start = heading.index;
    const end = headings[index + 1]?.index ?? content.length;
    const markdown = content.slice(start, end).trimEnd();
    const status = markdown.match(/^- \[([ xX])\] Solved[ \t]*$/m);
    if (!status || ids.has(heading[1])) {
      throw new Error(
        `Invalid or duplicate issue ${heading[1]} in .picode/issues.md; fix its heading and Solved checkbox before reporting.`,
      );
    }
    ids.add(heading[1]);
    return {
      id: heading[1],
      title: heading[2],
      solved: status[1].toLowerCase() === "x",
      area: markdown.match(/^- Area: (.*)$/m)?.[1] ?? "",
      reports: Number(markdown.match(/^- Reports: (\d+)$/m)?.[1] ?? 1),
      reportedAt: markdown.match(/^- Reported: (\S+)/m)?.[1] ?? "",
      markdown,
      start,
      end,
    };
  });
}

export function readIssues(cwd) {
  return parseIssues(readContent(cwd));
}

// A damaged optional log must not hide obligations or owed replies in status.
export function issueSummary(cwd) {
  try {
    const issues = readIssues(cwd);
    const open = issues.filter(issue => !issue.solved).length;
    return `Papercuts: ${open} open, ${issues.length - open} solved.`;
  } catch (error) {
    return `Papercut journal unavailable: ${error.message ?? String(error)}`;
  }
}

function field(value, name, required = false, max = 2000) {
  if (value === undefined && !required) return "none";
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be non-empty text.`);
  const text = value.replace(/[\r\n\s]+/g, " ").trim();
  if (text.length > max) throw new Error(`${name} must be at most ${max} characters.`);
  return text;
}

function normalized(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

// The exclusive file lock covers the entire read-modify-write transaction,
// including ID allocation. Never steal a lock merely because it is old:
// another still-live worker may own it. A dead owner's lock is recoverable.
async function mutate(cwd, update, signal) {
  const target = issueJournalPath(cwd);
  const lock = target + ".lock";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + 12_000;
  while (true) {
    signal?.throwIfAborted();
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const raw = fs.readFileSync(lock, "utf8");
        let dead = false;
        try {
          const owner = JSON.parse(raw);
          if (Number.isInteger(owner.pid) && owner.pid > 0) {
            try {
              process.kill(owner.pid, 0);
            } catch (pidError) {
              dead = pidError.code === "ESRCH";
            }
          }
        } catch {
          // A crash between exclusive open and writing the owner leaves an
          // empty lock. Give a live creator time to finish before recovery.
          dead = Date.now() - fs.statSync(lock).mtimeMs > 30_000;
        }
        if (dead && fs.readFileSync(lock, "utf8") === raw) fs.unlinkSync(lock);
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      if (Date.now() >= deadline)
        throw new Error(`Issue journal is busy: ${lock}. Try again shortly.`);
      await delay(25, undefined, { signal });
    }
  }
  const tmp = `${target}.${token}.tmp`;
  try {
    signal?.throwIfAborted();
    const content = readContent(cwd);
    const result = update(content, parseIssues(content));
    // A manual edit does not participate in our lock. Refuse to overwrite
    // an edit observed during this transaction (edit while agents are idle).
    if (readContent(cwd) !== content)
      throw new Error("Issue journal changed while reporting; try again.");
    fs.writeFileSync(tmp, result.content, { mode: 0o600 });
    fs.renameSync(tmp, target);
    return result.value;
  } finally {
    fs.rmSync(tmp, { force: true });
    if (JSON.parse(fs.readFileSync(lock, "utf8")).token === token) fs.unlinkSync(lock);
  }
}

export async function reportIssue(cwd, report, reporter, signal) {
  const title = field(report.title, "title", true, 200);
  const area = field(report.area, "area", true, 100);
  const problem = field(report.problem, "problem", true);
  const impact = field(report.impact, "impact", true);
  const workaround = field(report.workaround, "workaround");
  const help = field(report.help, "help");
  const source = field(reporter, "reporter", true, 200);
  return mutate(
    cwd,
    (content, issues) => {
      const timestamp = new Date().toISOString();
      const existing = issues.find(
        issue =>
          !issue.solved &&
          normalized(issue.title) === normalized(title) &&
          normalized(issue.area) === normalized(area),
      );
      if (existing) {
        const repeat = `- Seen again: ${timestamp} · ${source} — ${problem} Impact: ${impact} Workaround: ${workaround} Help needed: ${help}`;
        let markdown = existing.markdown;
        if (/^- Reports: \d+$/m.test(markdown)) {
          markdown = markdown.replace(/^- Reports: \d+$/m, `- Reports: ${existing.reports + 1}`);
        } else {
          markdown += `\n- Reports: ${existing.reports + 1}`;
        }
        markdown += `\n${repeat}\n\n`;
        return {
          content: content.slice(0, existing.start) + markdown + content.slice(existing.end),
          value: { id: existing.id, repeated: true },
        };
      }
      const next = issues.reduce((max, issue) => Math.max(max, Number(issue.id.slice(3))), 0) + 1;
      const id = `PC-${String(next).padStart(3, "0")}`;
      const markdown = `## ${id} — ${title}\n- [ ] Solved\n- Reported: ${timestamp} · ${source}\n- Area: ${area}\n- Reports: 1\n- Problem: ${problem}\n- Impact: ${impact}\n- Workaround: ${workaround}\n- Help needed: ${help}\n`;
      return {
        content: (content || HEADER).trimEnd() + "\n\n" + markdown,
        value: { id, repeated: false },
      };
    },
    signal,
  );
}

// Only human-facing commands call this. Agents can report, not declare a fix.
export async function solveIssue(cwd, id, note) {
  if (!/^PC-\d+$/.test(id)) throw new Error("Use an issue id such as PC-001.");
  const resolution =
    note === undefined || note === "" ? "Marked solved by operator." : field(note, "resolution");
  return mutate(cwd, (content, issues) => {
    const issue = issues.find(item => item.id === id);
    if (!issue) throw new Error(`No issue ${id} found.`);
    if (issue.solved) return { content, value: { id, alreadySolved: true } };
    const markdown =
      issue.markdown.replace(/^- \[ \] Solved[ \t]*$/m, "- [x] Solved") +
      `\n- Resolution: ${new Date().toISOString()} — ${resolution}\n\n`;
    return {
      content: content.slice(0, issue.start) + markdown + content.slice(issue.end),
      value: { id, alreadySolved: false },
    };
  });
}

export function formatIssues(
  issues,
  { status = "open", compact = true, tail = 15, id, lookbackMinutes } = {},
) {
  if (!["open", "solved", "all"].includes(status))
    throw new Error("status must be open, solved, or all.");
  if (!Number.isInteger(tail) || tail < 0) throw new Error("tail must be a non-negative integer.");
  if (lookbackMinutes !== undefined && (!Number.isFinite(lookbackMinutes) || lookbackMinutes <= 0))
    throw new Error("lookbackMinutes must be positive.");
  const filtered = issues.filter(
    issue =>
      (!id || issue.id === id) &&
      (status === "all" || issue.solved === (status === "solved")) &&
      (!lookbackMinutes ||
        !issue.reportedAt ||
        Date.parse(issue.reportedAt) >= Date.now() - lookbackMinutes * 60_000),
  );
  const selected = tail ? filtered.slice(-tail) : filtered;
  const body = selected
    .map(issue =>
      compact
        ? `${issue.solved ? "[x]" : "[ ]"} ${issue.id} — ${issue.title} (${issue.reports} report${issue.reports === 1 ? "" : "s"})`
        : issue.markdown,
    )
    .join("\n\n");
  const prefix =
    selected.length < filtered.length
      ? `Showing ${selected.length} of ${filtered.length} matching issues.\n\n`
      : "";
  const output = prefix + (body || "(no matching issues)");
  return output.length > 24_000
    ? output.slice(0, 24_000) + "\n…truncated; read .picode/issues.md for the full log."
    : output;
}
