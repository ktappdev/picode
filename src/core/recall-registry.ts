import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface RecallParticipant {
  id: string;
  role: string;
  sessionFile: string;
  cwd: string;
  updatedAt: string;
}

type RecallCatalog = Record<string, RecallParticipant>;

function catalogPath(cwd: string): string {
  return join(cwd, ".picode", "recall-sessions.json");
}

function isParticipant(value: unknown): value is RecallParticipant {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["id", "role", "sessionFile", "cwd", "updatedAt"].every(
    key => typeof record[key] === "string" && record[key].length > 0,
  );
}

function readCatalog(cwd: string): RecallCatalog {
  try {
    const value: unknown = JSON.parse(readFileSync(catalogPath(cwd), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, RecallParticipant] =>
        isParticipant(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export function loadRecallParticipant(cwd: string, id: string): RecallParticipant | undefined {
  const participant = readCatalog(cwd)[id];
  return participant?.id === id ? participant : undefined;
}

export function saveRecallParticipant(cwd: string, participant: RecallParticipant): void {
  const dir = join(cwd, ".picode");
  mkdirSync(dir, { recursive: true });
  const path = catalogPath(cwd);
  const next = { ...readCatalog(cwd), [participant.id]: participant };
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2));
  renameSync(temp, path);
}
