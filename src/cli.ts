import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;

export interface IOutput {
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE = `wip ${VERSION}

Usage:
  wip --version    Print the version
  wip --help       Show this help
`;

const defaultOutput: IOutput = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

export function run(argv: readonly string[], output: IOutput = defaultOutput): number {
  const [command] = argv;
  if (command === "--version" || command === "-v" || command === "version") {
    output.out(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    output.out(USAGE);
    return EXIT_OK;
  }
  output.err(`wip: unknown command '${command}'\n\n${USAGE}`);
  return EXIT_USAGE;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
