import {
  MAX_VISUAL_SVG_BYTES,
  parseVisualRef,
  type Translator,
} from "@lumisca/core/shared";
import { Marked, Renderer, type RendererObject, type Tokens } from "marked";
import { withToken } from "./api-client.ts";
import { markedMath } from "./math.ts";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SAFE_PROTOCOLS = /^(https?:|mailto:)/;

/** Images trigger real network requests from untrusted model output: allow
 * only http(s), and never the local machine itself (SSRF to other local
 * services). data: URIs and protocol-relative //host URLs never render.
 * `visual:` references are the one exception, and they are not URLs: they
 * name an asset of the session being rendered, resolved against the base
 * the caller supplies (see MarkdownOptions). */
function safeImageHref(href: string): string {
  const match = href.match(/^https?:\/\/([^/]+)/i);
  if (!match) return "";
  const host = match[1]!.toLowerCase();
  if (host === "localhost" || host.startsWith("127.") || host === "[::1]") {
    return "";
  }
  return href;
}

/** Fence language of an agent-authored diagram. A fence tagged `svg` is a
 * picture, not code: the model writes the SVG element, the reply shows it. */
const SVG_FENCE = "svg";

/** What one render call needs beyond the text. */
export interface MarkdownOptions {
  /** URL base of the rendered session's visual assets, ending with "/"
   * (`/api/sessions/<id>/visual/`, or the federated form for a session a
   * peer owns). A message's `visual:` links resolve against it. */
  visualBase: string;
  /** Message lookup of the app language: a diagram that cannot be shown is
   * explained in words rather than dropped silently. */
  t: Translator;
}

/** The renderer of one call. Built per call (not once for the module)
 * because a message belongs to a session: the base its visual links resolve
 * against, and the language its cards are written in, differ per call. */
function rendererFor(options: MarkdownOptions): RendererObject {
  const { visualBase, t } = options;
  return {
    // Raw HTML from the model is shown as escaped text, never executed.
    html(token: Tokens.HTML | Tokens.Tag) {
      return `<p>${escapeHtml(token.text)}</p>`;
    },
    link(token: Tokens.Link) {
      const href = SAFE_PROTOCOLS.test(token.href) ? token.href : "#";
      return `<a href="${escapeHtml(
        href,
      )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        token.text,
      )}</a>`;
    },
    image(token: Tokens.Image) {
      const name = parseVisualRef(token.href);
      // A published visual is drawn from its downscaled preview by default
      // (the route produces one when the picture is big); the click opens the
      // original through the lightbox, which asks for `preview=0`.
      const href =
        name === undefined
          ? safeImageHref(token.href)
          : withToken(`${visualBase}${name}`);
      if (!href) return "";
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(
        token.text,
      )}" />`;
    },
    code(token: Tokens.Code) {
      // A fence that is still streaming is not a diagram yet: rendering one
      // per delta would decode the same incomplete picture over and over, and
      // the picture appears the moment the closing fence arrives.
      if (token.lang === SVG_FENCE && isClosedFence(token.raw)) {
        return svgVisual(token.text, t);
      }
      return codeBlock(token.text, token.lang ?? "", t);
    },
    table(token: Tokens.Table) {
      const html = Renderer.prototype.table.call(this, token).trim();
      return `<div class="md-table-wrap">${html}</div>\n`;
    },
  };
}

/** A fenced code block with a header carrying the language name and a copy
 * control. Keeping the markup plain HTML lets MarkdownBlock answer clicks
 * through one delegated listener without mounting per-block components. */
function codeBlock(source: string, rawLang: string, t: Translator): string {
  const lang = rawLang.trim().split(/\s+/)[0] ?? "";
  const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  const copyLabel = escapeHtml(t("chat.message.copy"));
  return (
    `<div class="md-code-block">` +
    `<div class="md-code-header">` +
    `<span class="md-code-lang">${escapeHtml(lang)}</span>` +
    `<button type="button" class="md-code-copy" data-code-copy aria-label="${copyLabel}" title="${copyLabel}">${copyLabel}</button>` +
    `</div>` +
    `<pre><code${langAttr}>${escapeHtml(source)}</code></pre>` +
    `</div>`
  );
}

/** True when a fenced block's source ends with its closing fence row. */
function isClosedFence(raw: string): boolean {
  const lines = raw.replace(/\n$/, "").split("\n");
  return /^\s*(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1] ?? "");
}

/** A diagram the agent wrote in a `svg` fence: shown as an image.
 *
 * The SVG is embedded as a data: URL in an `<img>`, never as markup in the
 * document. An image context runs no script and loads no external resource,
 * which is what makes model-authored SVG safe to show (a script in the
 * document's own DOM would not be). A diagram that cannot be shown that way
 * renders the reason and its source instead, so the text is never lost. */
function svgVisual(source: string, t: Translator): string {
  const svg = source.trim();
  if (!/^<svg[\s>]/i.test(svg)) {
    return visualError(t("chat.visual.error.root"), svg, t);
  }
  if (/<script[\s>]/i.test(svg)) {
    return visualError(t("chat.visual.error.script"), svg, t);
  }
  if (new TextEncoder().encode(svg).byteLength > MAX_VISUAL_SVG_BYTES) {
    const limit = `${Math.floor(MAX_VISUAL_SVG_BYTES / 1024)} KB`;
    return visualError(t("chat.visual.error.size", { limit }), svg, t);
  }
  // The SVG's own title names the picture for assistive technology; an SVG
  // without one is embedded without alt text.
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(svg)?.[1] ?? "";
  return `<img class="visual-svg" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    svg,
  )}" alt="${escapeHtml(title.trim())}" />`;
}

/** The card a visual that cannot be shown renders. */
function visualError(reason: string, source: string, t: Translator): string {
  return (
    `<figure class="visual-error">` +
    `<figcaption class="visual-error-title">${escapeHtml(
      t("chat.visual.error.title"),
    )}</figcaption>` +
    `<p class="visual-error-reason">${escapeHtml(reason)}</p>` +
    `<details class="visual-error-source"><summary>${escapeHtml(
      t("chat.visual.error.source"),
    )}</summary><pre>${escapeHtml(source)}</pre></details>` +
    `</figure>`
  );
}

/** The parser of the last call, with the options it was built for. A parser
 * binds the renderer of its call (see rendererFor): the base a visual link
 * resolves against and the language its cards are written in hold for a whole
 * conversation, not for one token, so a streamed reply must not build a new
 * one per frame. Rebuilt when either of those changes.
 *
 * One slot is enough for the hot path: a streamed token re-renders the
 * streaming block, whose `t` is memoized per component instance (see
 * web/src/i18n.ts) and therefore identical across its renders. A commit that
 * draws several blocks with different instances (a language switch, a window
 * that just loaded) rebuilds once per block, which is what it did before. */
let last: { visualBase: string; t: Translator; marked: Marked } | null = null;

function markedFor(options: MarkdownOptions): Marked {
  if (
    last !== null &&
    last.visualBase === options.visualBase &&
    last.t === options.t
  ) {
    return last.marked;
  }
  const marked = new Marked({
    renderer: rendererFor(options),
    // LaTeX in the model's text is typeset while the text is lexed (see
    // math.ts): by the time the HTML exists, "_" and "*" inside a formula
    // would already be emphasis.
    ...markedMath,
  });
  last = { visualBase: options.visualBase, t: options.t, marked };
  return marked;
}

/** Render model output as sanitized markdown HTML. */
export function renderMarkdown(text: string, options: MarkdownOptions): string {
  // The instance keeps no state of its own between parses: each call merges
  // its own options over the defaults and builds a fresh lexer and parser
  // (markdown_test.ts renders twice on one instance to hold that).
  return markedFor(options).parse(text, { async: false }) as string;
}
