export interface Issue {
  id: string;
  title: string;
  solved: boolean;
  area: string;
  reports: number;
  reportedAt: string;
  markdown: string;
  start: number;
  end: number;
}
export interface IssueReport {
  title: string;
  area: string;
  problem: string;
  impact: string;
  workaround?: string;
  help?: string;
}
export interface IssueFilter {
  status?: "open" | "solved" | "all";
  compact?: boolean;
  tail?: number;
  id?: string;
  lookbackMinutes?: number;
}
export function issueJournalPath(cwd: string): string;
export function readIssues(cwd: string): Issue[];
export function issueSummary(cwd: string): string;
export function reportIssue(
  cwd: string,
  report: IssueReport,
  reporter: string,
  signal?: AbortSignal,
): Promise<{ id: string; repeated: boolean }>;
export function solveIssue(
  cwd: string,
  id: string,
  note?: string,
): Promise<{ id: string; alreadySolved: boolean }>;
export function formatIssues(issues: Issue[], filter?: IssueFilter): string;
