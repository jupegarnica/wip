import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { iso } from "../clock.ts";
import type { IRoot } from "../env.ts";

export const WEB_LOG_MAX_BYTES = 1024 * 1024;

export type TLogLevel = "info" | "warn" | "error";

export type TWebLog = (level: TLogLevel, message: string) => void;

export function webLogPath(root: IRoot): string {
  return join(root.wip, "logs", "web.log");
}

/** One previous generation only: past the cap the file moves to `web.log.1`, replacing the older one. */
export function rotateIfNeeded(path: string, incoming: number, max = WEB_LOG_MAX_BYTES): void {
  if (!existsSync(path)) return;
  if (statSync(path).size + incoming > max) renameSync(path, `${path}.1`);
}

export function fileLog(path: string, max = WEB_LOG_MAX_BYTES): TWebLog {
  return (level, message) => {
    const line = `${iso()} ${level.padEnd(5)} ${message.replace(/[\r\n]+/g, " ")}\n`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      rotateIfNeeded(path, Buffer.byteLength(line), max);
      appendFileSync(path, line);
    } catch {
      // the log never stops the server; stdout still carries the addresses
    }
  };
}

export function logLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function tailLog(path: string, count: number): string[] {
  return logLines(readFileSync(path, "utf8")).slice(-count);
}
