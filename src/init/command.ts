/** Words of a command line, with single and double quotes and backslash escapes only; no expansion of any kind. */
export function splitCommand(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote !== null) throw new Error(`unclosed ${quote} in the command`);
  if (started) words.push(word);
  return words;
}

/** The inverse for display: an argument with a space or a quote is shown quoted. */
export function joinCommand(words: readonly string[]): string {
  return words.map((w) => (/[\s"'\\]/.test(w) ? JSON.stringify(w) : w)).join(" ");
}
