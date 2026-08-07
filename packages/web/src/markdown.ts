import { Marked, type Tokens } from "marked";

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
 * services). data: URIs and protocol-relative //host URLs never render. */
function safeImageHref(href: string): string {
  const match = href.match(/^https?:\/\/([^/]+)/i);
  if (!match) return "";
  const host = match[1]!.toLowerCase();
  if (host === "localhost" || host.startsWith("127.") || host === "[::1]") {
    return "";
  }
  return href;
}

const renderer = {
  // Raw HTML from the model is shown as escaped text, never executed.
  html(token: Tokens.HTML | Tokens.Tag) {
    return `<p>${escapeHtml(token.text)}</p>`;
  },
  link(token: Tokens.Link) {
    const href = SAFE_PROTOCOLS.test(token.href) ? token.href : "#";
    return `<a href="${
      escapeHtml(href)
    }" target="_blank" rel="noopener noreferrer">${escapeHtml(token.text)}</a>`;
  },
  image(token: Tokens.Image) {
    const href = safeImageHref(token.href);
    if (!href) return "";
    return `<img src="${escapeHtml(href)}" alt="${escapeHtml(token.text)}" />`;
  },
};

const marked = new Marked({ renderer });

/** Render model output as sanitized markdown HTML. */
export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}
