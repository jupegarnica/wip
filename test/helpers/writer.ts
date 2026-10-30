// Child process for the concurrency test: `n` separate write transactions, each in its own connection.
import { iso } from "../../src/clock.ts";
import { openDb } from "../../src/db.ts";

export interface IWriterError {
  index: number;
  code: string | number | null;
  message: string;
}

export interface IWriterResult {
  failures: number;
  errors: IWriterError[];
}

const [dbPath = "", n = "0", tag = "w"] = process.argv.slice(2);
const errors: IWriterError[] = [];
for (let i = 0; i < Number(n); i++) {
  try {
    const db = openDb(dbPath);
    db.transaction(() => {
      db.query("INSERT INTO events (ts, kind, actor, text) VALUES (?, 'note', ?, ?)").run(
        iso(),
        tag,
        `${tag}-${i}`,
      );
    }).immediate();
    db.close();
  } catch (err) {
    const { code, message } = err as { code?: string | number; message: string };
    errors.push({ index: i, code: code ?? null, message });
  }
}
const result: IWriterResult = { failures: errors.length, errors };
console.log(JSON.stringify(result));
