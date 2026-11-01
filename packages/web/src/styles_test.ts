import { assertEquals } from "@std/assert";

/**
 * Guards for the design tokens (styles/tokens.css). Both bugs these catch are
 * invisible in a single theme: a token that only one theme block declares
 * keeps the other theme's value there (the dark theme used to draw its
 * selected tab with a light theme's white card), and a variable reference
 * that resolves nowhere silently falls back to a hardcoded color (the peer
 * status dots asked for a green and a red token that were never declared).
 */

interface Block {
  selector: string;
  /** The custom properties the block declares (`--x: ...`). */
  tokens: string[];
}

/** Split a stylesheet into its top-level rule blocks, ignoring comments. */
function blocks(css: string): Block[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => {
    const [, selector = "", body = ""] = match;
    return {
      selector: selector.trim(),
      tokens: [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((token) =>
        token[1] ?? ""
      ),
    };
  });
}

/** The files under `src` that can carry a design token: the stylesheets and
 * the components (their inline styles use the same variables). */
async function* sourceFiles(dir: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      yield* sourceFiles(new URL(`${entry.name}/`, dir));
    } else if (/\.(css|ts|tsx)$/.test(entry.name)) {
      yield new URL(entry.name, dir);
    }
  }
}

/** The token names a stylesheet or component references in a variable. */
function referenced(css: string): string[] {
  return [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) =>
    match[1] ?? ""
  );
}

Deno.test("both theme blocks declare the same tokens", async () => {
  const css = await Deno.readTextFile(
    new URL("./styles/tokens.css", import.meta.url),
  );
  const themed = new Map<string, string[]>();
  for (const block of blocks(css)) {
    const theme = block.selector.match(/data-theme="([^"]+)"/)?.[1];
    if (theme) themed.set(theme, block.tokens);
  }
  assertEquals(
    [...themed.keys()].sort(),
    ["dark", "light"],
    "tokens.css must carry a dark and a light theme block",
  );
  const dark = new Set(themed.get("dark"));
  const light = new Set(themed.get("light"));
  assertEquals(
    [...light].filter((token) => !dark.has(token)).sort(),
    [],
    "declared by the light theme but not by the dark one",
  );
  assertEquals(
    [...dark].filter((token) => !light.has(token)).sort(),
    [],
    "declared by the dark theme but not by the light one",
  );
  // Dark is the default theme: it applies before the client sets data-theme.
  assertEquals(
    blocks(css).some((block) =>
      block.selector.includes(":root") &&
      block.selector.includes('data-theme="dark"')
    ),
    true,
    "the dark theme block must also match :root",
  );
});

Deno.test("every token reference resolves", async () => {
  const tokensCss = await Deno.readTextFile(
    new URL("./styles/tokens.css", import.meta.url),
  );
  const declared = new Set(
    blocks(tokensCss).flatMap((block) => block.tokens),
  );
  const missing = new Set<string>();
  for await (const file of sourceFiles(new URL("./", import.meta.url))) {
    if (file.pathname.endsWith("styles/tokens.css")) continue;
    for (const token of referenced(await Deno.readTextFile(file))) {
      if (!declared.has(token)) missing.add(token);
    }
  }
  assertEquals(
    [...missing].sort(),
    [],
    "referenced by the web UI but not declared in styles/tokens.css",
  );
});

/** One rule of a stylesheet, with the media query it sits in. */
interface CssRule {
  selector: string;
  body: string;
  /** The `@media` prelude the rule sits in, `null` for a top-level rule. */
  media: string | null;
}

/** Split a stylesheet into its rules, keeping the `@media` prelude each one
 * sits in. The `blocks` helper above cannot do this: it matches innermost
 * braces, so a rule inside a media query loses the query. Comments are
 * dropped first (a commented-out rule must not count), and nested rules are
 * attributed to the innermost at-rule — which is what the tests below need to
 * tell "hidden on a desktop, revealed on hover" from "hidden on a phone". */
function cssRules(css: string): CssRule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  // The at-rule preludes (e.g. `@media (...)`) currently open.
  const atRules: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "{") {
      const prelude = source.slice(start, i).trim();
      if (prelude.startsWith("@")) {
        atRules.push(prelude);
      } else {
        // A plain rule: its body holds declarations, so the next `}` closes
        // it (one level deep is all the sheets use).
        const end = source.indexOf("}", i);
        if (end === -1) break;
        rules.push({
          selector: prelude,
          body: source.slice(i + 1, end),
          media: atRules.find((at) => at.startsWith("@media")) ?? null,
        });
        i = end;
      }
      start = i + 1;
    } else if (char === "}") {
      atRules.pop();
      start = i + 1;
    }
  }
  return rules;
}

/** The elements a hover rule reveals: the last compound selector of each
 * comma-separated part (`...:hover .x` reveals `.x`). */
function revealed(selector: string): string[] {
  return selector.split(",").map((part) => {
    const compounds = part.trim().split(/\s+/);
    return compounds[compounds.length - 1] ?? "";
  }).filter((compound) => compound !== "");
}

/** The stylesheets under `styles/`, in cascade order. */
async function* styleSheets(): AsyncGenerator<[string, string]> {
  for await (const file of sourceFiles(new URL("./styles/", import.meta.url))) {
    if (!file.pathname.endsWith(".css")) continue;
    yield [
      file.pathname.split("/styles/")[1] ?? file.pathname,
      await Deno.readTextFile(file),
    ];
  }
}

Deno.test("width breakpoints are the documented two", async () => {
  // The narrow-viewport rules are split across the part sheets, so a fourth
  // value would silently fragment the layout. The documented list is in
  // styles/tokens.css (and styles/README.md).
  const used = new Map<string, Set<string>>();
  for await (const [name, css] of styleSheets()) {
    for (const match of css.matchAll(/@media[^{]*max-width:\s*(\d+)px/g)) {
      const width = `${match[1]}px`;
      const files = used.get(width) ?? new Set<string>();
      files.add(name);
      used.set(width, files);
    }
  }
  assertEquals(
    [...used.keys()].sort(),
    ["600px", "900px"],
    `used by: ${
      [...used.entries()].map(([width, files]) =>
        `${width} (${[...files].sort().join(", ")})`
      ).join("; ")
    }`,
  );
});

Deno.test("hover-only affordances stay visible on touch", async () => {
  // A touch screen never fires :hover, so anything a hover rule reveals
  // (opacity 0 / visibility hidden at rest) is unreachable there unless a
  // touch media query keeps it visible. The rewind buttons of a user message
  // and the workspace row's edit/delete actions were both in that state.
  const missing: string[] = [];
  for await (const [name, css] of styleSheets()) {
    const rules = cssRules(css);
    const hidden = rules
      .filter((rule) =>
        rule.media === null &&
        /(opacity|visibility):\s*(0|hidden)/.test(rule.body)
      )
      .map((rule) => rule.selector);
    const hoverRevealed = new Set(
      rules
        .filter((rule) =>
          rule.media === null && rule.selector.includes(":hover") &&
          /(opacity:\s*1|visibility:\s*visible)/.test(rule.body)
        )
        .flatMap((rule) => revealed(rule.selector)),
    );
    for (const selector of hidden) {
      // Hidden for another reason (a keyboard-only input, a JS-toggled
      // class): only the hover-revealed ones have to be covered.
      if (!hoverRevealed.has(selector)) continue;
      const covered = rules.some((rule) =>
        rule.media?.includes("hover: none") === true &&
        revealed(rule.selector).includes(selector) &&
        /(opacity:\s*1|visibility:\s*visible)/.test(rule.body)
      );
      if (!covered) missing.push(`${name}: ${selector}`);
    }
  }
  assertEquals(
    missing.sort(),
    [],
    "revealed by :hover but nothing shows them on a touch screen",
  );
});

Deno.test("the app height follows the visual viewport", async () => {
  // The app is sized by the token (itself the dynamic viewport height) and
  // refined by useAppHeight; a hardcoded height here would put the composer
  // back behind the software keyboard.
  const layout = await Deno.readTextFile(
    new URL("./styles/layout.css", import.meta.url),
  );
  assertEquals(
    /\.app\s*\{[^}]*height:\s*var\(--app-height\)/.test(layout),
    true,
    "styles/layout.css must size .app from --app-height",
  );
  const tokens = await Deno.readTextFile(
    new URL("./styles/tokens.css", import.meta.url),
  );
  assertEquals(
    /--app-height:\s*\S+/.test(tokens),
    true,
    "--app-height must be declared in styles/tokens.css",
  );
});

Deno.test("corners come from the radius ramp", async () => {
  // The shape of the UI is the radius steps, so a sheet that writes its own
  // pixel value quietly reintroduces the small, square-cornered look the
  // ramp replaced (58 rules once carried a literal 4px). Only the ramp, a
  // reset, and a full circle (a dot, a round icon, a slider knob) are
  // allowed.
  const allowed = new Set([
    "var(--radius-xs)",
    "var(--radius-sm)",
    "var(--radius)",
    "var(--radius-lg)",
    "var(--radius-xl)",
    "var(--radius-pill)",
  ]);
  const offenders: string[] = [];
  for await (const [name, css] of styleSheets()) {
    for (const rule of cssRules(css)) {
      for (const match of rule.body.matchAll(/border-radius:\s*([^;]+);/g)) {
        const value = (match[1] ?? "").trim();
        // A shorthand naming one to four corners of the ramp (the bottom
        // edge of a menu, a blockquote's outer side) is still the ramp.
        const parts = value.split(/\s+/).filter((part) =>
          part !== "0" && !allowed.has(part)
        );
        if (parts.length > 0 && value !== "50%") {
          offenders.push(`${name}: ${rule.selector} { ${value} }`);
        }
      }
    }
  }
  assertEquals(
    offenders.sort(),
    [],
    "border-radius values outside the documented ramp",
  );
});

Deno.test("the machine's screen canvas is left to noVNC to size", () => {
  // Regression: the pane stretched the canvas with `width/height: 100%
  // !important`. noVNC divides every pointer coordinate by the scale it
  // derived from its own `NNNpx` inline size, so the override made the
  // picture look right and the input land elsewhere — a click at the pane's
  // centre reached the machine's bottom edge, and the screen read as
  // unresponsive. Sizing is the client's, not the stylesheet's.
  const css = Deno.readTextFileSync(
    new URL("./styles/stella.css", import.meta.url),
  );
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector = "", body = ""] = match;
    if (!selector.includes("stella-pane-screen")) continue;
    if (!selector.includes("canvas")) continue;
    assertEquals(
      /(width|height)\s*:/.test(body),
      false,
      `the canvas must keep its own size, but the rule sets one: ${body}`,
    );
  }
});
