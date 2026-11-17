import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry } from "../shared/types";

export type { AuditEntry };

let auditPath: string | null = null;

export function initAudit(baseDir: string): void {
  auditPath = join(baseDir, "audit.log");
}

export function audit(tag: string, detail: unknown): void {
  if (!auditPath) return;
  try {
    appendFileSync(auditPath, `${JSON.stringify({ at: Date.now(), tag, detail })}\n`, "utf8");
  } catch {
    /* audit must never break the app */
  }
}

export function readAudit(limit = 200): AuditEntry[] {
  if (!auditPath || !existsSync(auditPath)) return [];
  try {
    const lines = readFileSync(auditPath, "utf8").trim().split(/\r?\n/).slice(-Math.max(1, Math.min(1000, limit)));
    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is AuditEntry => !!entry)
      .reverse();
  } catch {
    return [];
  }
}

export function auditPathForDisplay(): string {
  return auditPath ?? "";
}
