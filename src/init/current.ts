import { readStart } from "../config.ts";

/** The saved `start`, or null when there is none or it is invalid. */
export function savedStart(project: string): string[] | null {
  try {
    return readStart(project);
  } catch {
    return null;
  }
}
