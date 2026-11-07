import { main } from "./cli.ts";

// The entry of `bun src/main.ts` (`bun run dev`) and of the compiled binary. The npm package has its own,
// `bin/wip.mjs`, which prepares Node first and then calls the same `main`.
process.exit(await main(process.argv.slice(2)));
