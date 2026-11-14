import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

let logPath = "";

export function initDiagnostics(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, "runtime.log");
  } catch {
    logPath = "";
  }
}

/**
 * Synchronous, bounded diagnostics. Used around potentially huge allocations
 * so the last line in runtime.log survives a blocked or dying main process.
 */
export function trace(event: string, data?: unknown): void {
  if (!logPath) return;
  try {
    if (statSync(logPath, { throwIfNoEntry: false })?.size && statSync(logPath).size > 8 * 1024 * 1024) {
      appendFileSync(logPath, `${new Date().toISOString()} log-rotated\n`, "utf8");
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    const suffix = data === undefined ? "" : ` ${safeJson(data)}`;
    appendFileSync(logPath, `${new Date().toISOString()} ${event}${suffix}\n`, "utf8");
  } catch {
    /* diagnostics must never throw or block */
  }
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  } catch {
    return String(value);
  }
}
