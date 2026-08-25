import type { SkillDef } from "../discover.ts";

/**
 * The built-in "web-browser" skill: the bundled guide to the browser-lab
 * tools (browser_open / browser_observe / browser_act / browser_wait /
 * browser_screenshot / browser_close). The tools are never preloaded into
 * the LLM context — they live in the session's tool registry and are only
 * found through tool_search — so without a skill an agent can go an entire
 * session without realizing the browser exists. This skill exists to close
 * exactly that gap.
 *
 * Sessions without a browser backend must not advertise it: the
 * availability gate lives in builtin/mod.ts (BuiltinContext.browser).
 */

/** The SKILL.md body. English, like the tool descriptions it quotes;
 * kept deliberately compact so the session listing stays small. */
const SKILL_MD = `# Built-in web browser (browser lab) usage

A skill for inspecting, operating, and verifying the UI of web apps and
dev servers running locally, using the browser built into Lumisca (an
OS-standard WebView). The browser tools are not preloaded, so find them
first with tool_search (see "Most important" below).

## When to use

- Verifying the UI of a dev server (deno task dev, npm run dev, ...) or a
  built app
- Exercising the UI: form input, clicks, scrolling
- Taking a screenshot of the page and reporting it as part of the result
- Debugging frontend issues (console errors, network, DOM state)

## Most important: the tools are not preloaded

browser_open / browser_observe / browser_act / browser_wait /
browser_screenshot / browser_close — these six tools are NOT preloaded
into the session's LLM context. Before using one, always find it with
tool_search, then execute it with tool_call:

1. tool_search(query: "browser") — returns the six tools with their
   descriptions and argument schemas
2. tool_call(name: "browser_open", args: {...}) — execute the tool you
   need

When the session has no browser backend attached (see below), tool_search
finds nothing. In that case give up on browser-based verification and tell
the user "the browser is not available in this session".

## What it can and cannot do

- Only http://localhost, http://127.0.0.1 and http://[::1] URLs (with
  ports) can be opened. External sites (https://example.com, ...) are
  rejected by policy. Not usable for investigating or scraping external
  sites.
- No external browser is launched; the page renders in Lumisca's own
  WebView.
- In the desktop app the user can see it too. In the CLI the backend
  starts on the first browser tool use (disabled with
  --browser-preview never). A standalone server without a browser host
  cannot use it.

## Standard workflow

1. If needed, start the dev server with async_bash and confirm it is up
   with async_bash_status
2. browser_open(url: "http://localhost:5173/...") — pass width / height
   to size the viewport when needed (e.g. 390×844 to check the mobile
   layout)
3. browser_wait(until: "load") or until: "idle" — SPAs and HMR use
   WebSockets, so they are excluded from the idle check
4. browser_observe — returns headings, buttons, links, form controls
   (role, name, ref, disabled/hidden state), console entries and errors
   since the previous observe, network state, and a digest of the page
   text
5. Operate with browser_act — use the refs returned by observe
6. If needed, browser_screenshot(format: "png") — the image is included
   in the result
7. When done, browser_close — releases the WebView/host (safe to call
   repeatedly)

## browser_act actions

- click / fill (replaces the value) / type (appends to the value) — fill
  and type dispatch input/change, so React-style apps see the change
- press(key: "Enter", ...) — dispatches a key event (Enter submitting the
  form is the one default action that works)
- select — picks a <select> option by value
- check / uncheck — checkboxes
- scroll — by ref, or by x/y coordinates
- reload — reloads the page

refs are numbered per observe. After the DOM changes, old refs are stale:
re-observe before and after actions as needed.

## Tips

- Right after the page state changes, wait for stability with
  browser_wait(until: "idle"), or until: "url" (url_contains) for URL
  navigations
- browser_observe(include_text: false) skips the text digest (keeps
  repeated observations light)
- browser_open(visible: false) lets you drive the page without showing it
  (be careful: screenshots may come back blank)
- If you cannot interpret the screenshot image, report the page from the
  observe text digest instead
- A timed-out wait returns ok=false (it does not throw). Check the
  network line of observe for stuck requests

## Errors and how to handle them

- "browser tools are not attached to this session" — no backend; give up
  on browser-based verification and report to the user
- URL rejected — loopback only; double-check the dev server port
- "Unknown tool ..." — not found via tool_search; run tool_search first,
  then tool_call
`;

/** Build the built-in web-browser skill definition. Content is embedded
 * (no filesystem), so it survives bundling and any working directory. */
export function webBrowserSkill(): SkillDef {
  return {
    name: "web-browser",
    description:
      "Usage of the built-in web browser (WebView): opening, operating, " +
      "screenshotting and debugging the UI of local web apps and dev " +
      "servers. The browser_open etc. tools are not preloaded — find " +
      "them with tool_search, then execute with tool_call.",
    source: "builtin",
    read: (relativePath) => {
      if (relativePath !== undefined) {
        // One file per built-in skill for now: no follow-up files exist.
        // The message mirrors the file-based skills' read error.
        throw new Error(
          `No such file in skill "web-browser": ${relativePath}`,
        );
      }
      return SKILL_MD;
    },
  };
}
