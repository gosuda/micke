// audit — one grep-friendly line per MCP tool call, appended to
// <stateDir>/audit.log. It answers "what did the agent actually run" after
// the fact (counts of shell calls, waits, screenshots, status checks)
// without logging output bodies. Auditing must never break the call it
// observes: every failure here is swallowed.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function auditPath(stateDir: string): string {
  return join(stateDir, "audit.log");
}

/** Collapse one shell command to a single ≤400-char token: the audit log
 * records what ran, not full transcripts. */
export function flatCmd(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const flat = v.replace(/\s+/g, " ").trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}…(+${flat.length - 400})` : flat;
}

/** k=v tokens stay one token even if a value carries whitespace. */
function token(v: unknown): string {
  return String(v).replace(/\s+/g, " ").trim();
}

/** Append one line; a full disk or a read-only state dir must not fail the
 * tool call being audited. */
function appendLine(stateDir: string, line: string): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(auditPath(stateDir), `${line}\n`);
  } catch {
    /* the audited call matters more than the audit */
  }
}

/**
 * The MCP dispatch's single audit entry point. One line per tool call:
 * `<ISO> <tool> [k=v …] took=<ms>ms ok|err=<CODE>`
 */
export function auditToolCall(
  stateDir: string,
  tool: string,
  detail: Record<string, unknown>,
  startedMs: number,
  outcome: "ok" | `err=${string}`,
): void {
  const kv = Object.entries(detail)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${token(v)}`)
    .join(" ");
  appendLine(
    stateDir,
    [new Date().toISOString(), token(tool), kv, `took=${Date.now() - startedMs}ms`, outcome]
      .filter(Boolean)
      .join(" "),
  );
}
