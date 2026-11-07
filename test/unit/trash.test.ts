import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { trashCommand } from "../../src/trash.ts";

const has =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe("trashCommand", () => {
  test("WIP_TRASH_CMD wins and is not replaced by another when it does not exist", () => {
    expect(trashCommand({ WIP_TRASH_CMD: "/x/t" }, "linux", has("/x/t", "/usr/bin/trash"))).toEqual(
      { argv: ["/x/t"], viaEnv: false },
    );
    expect(trashCommand({ WIP_TRASH_CMD: "/x/t" }, "darwin", has("/usr/bin/trash"))).toBeNull();
  });

  test("macOS uses /usr/bin/trash", () => {
    expect(trashCommand({}, "darwin", has("/usr/bin/trash"))?.argv).toEqual(["/usr/bin/trash"]);
    expect(trashCommand({}, "darwin", has())).toBeNull();
  });

  test("Linux prefers gio, then trash-put, from PATH", () => {
    const env = { PATH: "/a:/b" };
    expect(trashCommand(env, "linux", has("/b/gio", "/a/trash-put"))?.argv).toEqual([
      "/b/gio",
      "trash",
    ]);
    expect(trashCommand(env, "linux", has("/a/trash-put"))?.argv).toEqual(["/a/trash-put"]);
    expect(trashCommand(env, "linux", has())).toBeNull();
    expect(trashCommand({}, "linux", has("/a/gio"))).toBeNull();
  });

  test("Windows runs powershell with the recycle-bin call and the folder in WIP_TRASH_DIR", () => {
    const cmd = trashCommand({ PATH: "C:\\ps" }, "win32", has(join("C:\\ps", "powershell.exe")));
    expect(cmd?.viaEnv).toBe(true);
    expect(cmd?.argv.at(-1)).toContain("SendToRecycleBin");
    expect(cmd?.argv.at(-1)).toContain("$env:WIP_TRASH_DIR");
    expect(trashCommand({ PATH: "C:\\ps" }, "win32", has())).toBeNull();
  });
});
