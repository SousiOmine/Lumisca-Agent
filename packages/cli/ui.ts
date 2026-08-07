/** ANSI helpers for the terminal UI. */

const ENABLE_COLOR = Deno.stdout.isTerminal();

export type PromptFn = (message?: string) => string | null;

let promptFn: PromptFn = (message) => prompt(message);

/** Override the prompt implementation (used by tests). */
export function setPromptFn(fn: PromptFn): void {
  promptFn = fn;
}

export function getPromptFn(): PromptFn {
  return promptFn;
}

function wrap(code: string, text: string): string {
  if (!ENABLE_COLOR) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export const color = {
  dim: (t: string) => wrap("2", t),
  faint: (t: string) => wrap("90", t),
  red: (t: string) => wrap("31", t),
  green: (t: string) => wrap("32", t),
  yellow: (t: string) => wrap("33", t),
  blue: (t: string) => wrap("34", t),
  cyan: (t: string) => wrap("36", t),
  bold: (t: string) => wrap("1", t),
};

export function header(text: string): void {
  console.log(color.bold(color.cyan(`── ${text} ──`)));
}

export function info(text: string): void {
  console.log(color.faint(text));
}

export function success(text: string): void {
  console.log(color.green(text));
}

export function error(text: string): void {
  // Errors go to stderr so they stay separable from streamed agent output.
  console.error(color.red(text));
}

export function userLine(text: string): void {
  console.log(color.green(`❯ ${text}`));
}

export function assistantLine(text: string): void {
  console.log(color.cyan(`◈ ${text}`));
}
