import { Marked, type RendererObject, type Tokens } from "marked";
import {
  MAX_VISUAL_SVG_BYTES,
  parseVisualRef,
  type Translator,
} from "@lumisca/core/shared";

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
      return `<a href="${
        escapeHtml(href)
      }" target="_blank" rel="noopener noreferrer">${
        escapeHtml(token.text)
      }</a>`;
    },
    image(token: Tokens.Image) {
      const name = parseVisualRef(token.href);
      const href = name === undefined
        ? safeImageHref(token.href)
        : `${visualBase}${name}`;
      if (!href) return "";
      return `<img src="${escapeHtml(href)}" alt="${
        escapeHtml(token.text)
      }" />`;
    },
    code(token: Tokens.Code) {
      // Returning false keeps marked's own code rendering (`false` = "use the
      // default", the contract of RendererObject). A fence that is still
      // streaming is not a diagram yet: rendering one per delta would decode
      // the same incomplete picture over and over, and the picture appears
      // the moment the closing fence arrives.
      if (token.lang !== SVG_FENCE || !isClosedFence(token.raw)) return false;
      return svgVisual(token.text, t);
    },
  };
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
  return `<img class="visual-svg" src="data:image/svg+xml;charset=utf-8,${
    encodeURIComponent(svg)
  }" alt="${escapeHtml(title.trim())}" />`;
}

/** The card a visual that cannot be shown renders. */
function visualError(reason: string, source: string, t: Translator): string {
  return `<figure class="visual-error">` +
    `<figcaption class="visual-error-title">${
      escapeHtml(t("chat.visual.error.title"))
    }</figcaption>` +
    `<p class="visual-error-reason">${escapeHtml(reason)}</p>` +
    `<details class="visual-error-source"><summary>${
      escapeHtml(t("chat.visual.error.source"))
    }</summary><pre>${escapeHtml(source)}</pre></details>` +
    `</figure>`;
}

/** Render model output as sanitized markdown HTML. */
export function renderMarkdown(
  text: string,
  options: MarkdownOptions,
): string {
  return new Marked({ renderer: rendererFor(options) })
    .parse(text, { async: false }) as string;
}
