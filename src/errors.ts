export const EXIT = {
  OK: 0,
  FINDINGS: 1,
  USAGE: 2,
  REJECTED: 3,
  NOT_FOUND: 4,
  DB: 10,
} as const;

export type TExitCode = (typeof EXIT)[keyof typeof EXIT];

export class WipError extends Error {
  constructor(
    public readonly code: TExitCode,
    message: string,
  ) {
    super(message);
  }
}

export const usage = (message: string): WipError => new WipError(EXIT.USAGE, message);
export const rejected = (message: string): WipError => new WipError(EXIT.REJECTED, message);
export const notFound = (message: string): WipError => new WipError(EXIT.NOT_FOUND, message);
export const dbError = (message: string): WipError => new WipError(EXIT.DB, message);
