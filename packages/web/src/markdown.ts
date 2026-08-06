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
};

const marked = new Marked({ renderer });

/** Render model output as sanitized markdown HTML. */
export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}
