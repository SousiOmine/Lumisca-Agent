import katex from "katex";
import type {
  MarkedExtension,
  TokenizerAndRendererExtension,
  Tokens,
} from "marked";

/**
 * LaTeX in a message.
 *
 * The model writes formulas the way a paper does: `$x$` in running text,
 * `$$…$$` for a formula on its own line, and often `\(…\)` / `\[…\]`
 * instead. `marked` knows none of them, so without this module the text
 * arrives as dollars and backslashes.
 *
 * The formulas are typeset here, during lexing, rather than after the HTML is
 * built: a `$`-delimited run contains the characters markdown itself reacts
 * to (`_`, `*`, `\\`), and by the time the HTML exists they would already be
 * emphasis or escapes. The tokenizer takes the run out of the text first, so
 * the contents reach KaTeX as written.
 */

/** A formula the model wrote. */
export interface MathToken extends Tokens.Generic {
  type: "math";
  /** The source as it appeared, delimiters included. */
  raw: string;
  /** The formula without its delimiters. */
  text: string;
  /** A formula on its own line (`$$…$$`, `\[…\]`) rather than inline. */
  display: boolean;
}

/** Longest formula KaTeX is asked to typeset. A typesetter lays out every
 * atom it is given, and a model that emits a megabyte of `\frac`
 * would freeze the frame that draws it; past this length the source is shown
 * as code, which is still readable. */
const MAX_SOURCE = 4000;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The environments a model writes that KaTeX does not know, mapped to the
 * ones it does.
 *
 * A paper writes \begin{align}; KaTeX knows only \begin{aligned} and refuses
 * the rest with "No such environment". The alignment markers and the row
 * breaks are the same, so renaming the environment keeps the formula whole.
 * The equation environment only marks display math, which the delimiter
 * already said, so it is dropped.
 */
function knownEnvironments(tex: string): string {
  return tex
    .replace(
      /\\begin\{(?:align|flalign|alignat|eqnarray)\*?\}/g,
      "\\begin{aligned}",
    )
    .replace(
      /\\end\{(?:align|flalign|alignat|eqnarray)\*?\}/g,
      "\\end{aligned}",
    )
    .replace(/\\begin\{gather\*?\}/g, "\\begin{gathered}")
    .replace(/\\end\{gather\*?\}/g, "\\end{gathered}")
    .replace(/\\(?:begin|end)\{equation\*?\}/g, "");
}

/** Typeset one formula to HTML. KaTeX is called with `throwOnError: false`
 * so a formula it cannot parse renders as its own source in the error style
 * instead of failing the whole message; `trust: false` keeps the commands
 * that would load a URL or add a class out of the output (the result is
 * inserted into the document as markup). */
export function renderMath(source: string, display: boolean): string {
  const tex = knownEnvironments(source.trim());
  if (tex === "") return "";
  if (tex.length > MAX_SOURCE) return mathSource(tex);
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml",
      maxExpand: 1000,
    });
  } catch {
    // KaTeX throws when the input is not a string, and its own renderer can
    // fail on a construct it did not classify; showing the source keeps the
    // text visible either way.
    return mathSource(tex);
  }
}

/** The formula as its own source, for what KaTeX cannot take. */
function mathSource(tex: string): string {
  return `<pre class="math-source"><code>${escapeHtml(tex)}</code></pre>`;
}

function mathToken(raw: string, text: string, display: boolean): MathToken {
  return { type: "math", raw, text, display };
}

/** A formula that starts at the beginning of a line and closes at the end of
 * one: `$$` or `\[` opens, the matching `$$` / `\]` on a line of its own
 * (or, when the formula fits on one line, at that line's end) closes. */
function blockMath(src: string): MathToken | undefined {
  const open = /^ {0,3}(?:\$\$|\\\[)/.exec(src);
  if (open === null) return undefined;
  const body = src.slice(open[0].length);
  // Everything up to the closing delimiter, which must be the last thing on
  // its line: a run like "costs $$5 and $$6" is prose with dollars in it, not
  // a block formula.
  const oneLine = /^([^\n]*?)(?:\$\$|\\\])[ \t]*(?:\n|$)/.exec(body);
  if (oneLine !== null) {
    return mathToken(open[0] + oneLine[0], oneLine[1] ?? "", true);
  }
  // The delimiter alone ends the line, so the formula spans lines.
  const many = /^\n([\s\S]*?)\n {0,3}(?:\$\$|\\\])[ \t]*(?:\n+|$)/.exec(body);
  if (many !== null) return mathToken(open[0] + many[0], many[1] ?? "", true);
  return undefined;
}

/** A formula that starts at the current position of an inline run. Alongside
 * the delimiters, the rules are the ones every markdown-with-math dialect
 * uses: a single `$` opens only before a non-space, and closes only after a
 * non-space, so "prices are $5 and $10" stays prose. */
function inlineMath(src: string): MathToken | undefined {
  const display = /^\$\$([^\n$]+?)\$\$/.exec(src);
  if (display !== null) return mathToken(display[0], display[1] ?? "", true);
  const paren = /^\\\(([\s\S]*?)\\\)/.exec(src);
  if (paren !== null) return mathToken(paren[0], paren[1] ?? "", false);
  const bracket = /^\\\[([\s\S]*?)\\\]/.exec(src);
  if (bracket !== null) return mathToken(bracket[0], bracket[1] ?? "", true);
  const single = /^\$(?![\s$])([^$\n]*?)(?<![\s\\])\$(?!\d)/.exec(src);
  if (single !== null) return mathToken(single[0], single[1] ?? "", false);
  return undefined;
}

/** The token as the markup the message shows. A formula on its own line is
 * wrapped in a block of its own so a long one scrolls sideways inside the
 * message column instead of widening it. */
function renderMathToken(token: Tokens.Generic): string {
  const math = token as MathToken;
  const html = renderMath(math.text, math.display);
  if (html === "" || !math.display) return html;
  return `<span class="math-block">${html}</span>`;
}

/** The `marked` extension `markdown.ts` registers.
 *
 * `start` is what makes a delimiter visible at all: the lexer asks it where
 * the next formula could begin, so the text token stops there instead of
 * swallowing the run whole. Both levels share one name because the parser
 * looks the renderer up by token type. */
export const mathExtensions: TokenizerAndRendererExtension[] = [
  {
    name: "math",
    level: "block",
    start(src: string): number | undefined {
      return /^ {0,3}(?:\$\$|\\\[)/m.exec(src)?.index;
    },
    tokenizer(src: string): MathToken | undefined {
      return blockMath(src);
    },
    renderer: renderMathToken,
  },
  {
    name: "math",
    level: "inline",
    start(src: string): number | undefined {
      return /\$|\\[([]/.exec(src)?.index;
    },
    tokenizer(src: string): MathToken | undefined {
      return inlineMath(src);
    },
    renderer: renderMathToken,
  },
];

/** The extension list as `MarkedOptions` wants it. */
export const markedMath: MarkedExtension = { extensions: mathExtensions };
