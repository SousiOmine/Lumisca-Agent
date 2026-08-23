/**
 * Browser-lab end-to-end smoke test (CLI host): opens a local test page
 * in lumisca-browser-host through the real RPC protocol and exercises the
 * full agent tool surface — observe / act / wait / screenshot / reload /
 * close — asserting every completion criterion that can be checked
 * without an LLM.
 *
 * Prerequisite: the host binary must be built:
 *   cd packages/browser-host && cargo build --release
 *
 * Run: deno run --allow-all scripts/browser-host-e2e.ts
 */
import { HttpBrowserBackend } from "../packages/core/browser/client.ts";
import { checkBrowserUrl } from "../packages/core/browser/policy.ts";

const SCRIPTS_DIR = import.meta.dirname!;
const HOST_BINARY = `${SCRIPTS_DIR}/../packages/browser-host/target/release/${
  exe("lumisca-browser-host")
}`;

function exe(name: string): string {
  return Deno.build.os === "windows" ? `${name}.exe` : name;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ASSERT FAILED: ${message}`);
  }
}

async function readReadyLine(
  stdout: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<number> {
  const reader = stdout.getReader();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("ready line timeout")), 500)
      ),
    ]);
    if (done) break;
    buffer += new TextDecoder().decode(value);
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      const port = Number(buffer.slice(0, newline).trim().split(" ")[1]);
      if (Number.isInteger(port) && port > 0) return port;
    }
  }
  throw new Error(`host did not become ready; output: ${buffer}`);
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- the test page ---------------------------------------------------------

const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Browser Lab E2E</title></head>
<body>
  <h1>ようこそ</h1>
  <p>テストページです。</p>
  <label for="username">ユーザー名</label>
  <input id="username" type="text" value="alice">
  <button id="save">保存</button>
  <div id="result"></div>
  <script>
    console.log("page loaded");
    const input = document.getElementById("username");
    const button = document.getElementById("save");
    const result = document.getElementById("result");
    button.addEventListener("click", () => {
      result.textContent = "saved: " + input.value;
      console.log("clicked:", input.value);
    });
    // A deliberate page error for the error-collection check.
    setTimeout(() => {
      Promise.reject(new Error("deliberate unhandled rejection"));
    }, 100);
  </script>
</body>
</html>`;

const pageServer = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: () => {} },
  () => new Response(html, { headers: { "content-type": "text/html" } }),
);
const pagePort = (pageServer.addr as Deno.NetAddr).port;
const pageUrl = `http://127.0.0.1:${pagePort}/`;

console.log(`[page] ${pageUrl}`);

// --- spawn the host --------------------------------------------------------

const token = randomToken();
const child = new Deno.Command(HOST_BINARY, {
  args: ["--token", token, "--idle-timeout-ms", "60000"],
  stdin: "piped",
  stdout: "piped",
  stderr: "piped",
}).spawn();
let stderrTail = "";
void (async () => {
  try {
    const reader = child.stderr.pipeThrough(new TextDecoderStream())
      .getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      stderrTail = (stderrTail + value).slice(-1000);
    }
  } catch {
    // process gone
  }
})();

let exited = false;
void child.status.then(() => (exited = true));

const port = await readReadyLine(child.stdout, 10_000);
console.log(`[host] ready on 127.0.0.1:${port}`);
const backend = new HttpBrowserBackend({
  url: `http://127.0.0.1:${port}`,
  token,
});

try {
  // --- open ---------------------------------------------------------------
  const info = await backend.open({ url: pageUrl });
  assert(info.url === pageUrl, `open returned ${info.url}`);

  // --- observe ------------------------------------------------------------
  await new Promise((r) => setTimeout(r, 400)); // let the page + probe settle
  let snapshot = await backend.observe();
  if (snapshot.url === undefined) {
    console.log("[debug] raw observe result:", JSON.stringify(snapshot));
  }
  assert(snapshot.url === pageUrl, `observe url: ${snapshot.url}`);
  assert(snapshot.title === "Browser Lab E2E", `title: ${snapshot.title}`);
  const heading = snapshot.elements.find((e) => e.role === "heading");
  assert(heading !== undefined, "heading must be visible");
  assert(heading!.name.includes("ようこそ"), `heading name: ${heading!.name}`);
  const textbox = snapshot.elements.find((e) => e.role === "textbox");
  assert(textbox !== undefined, "textbox must be visible");
  assert(textbox!.name === "ユーザー名", `textbox name: ${textbox!.name}`);
  assert(textbox!.value === "alice", `textbox value: ${textbox!.value}`);
  const button = snapshot.elements.find((e) => e.role === "button");
  assert(button !== undefined, "button must be visible");
  assert(button!.name === "保存", `button name: ${button!.name}`);

  console.log("[observe] ok — heading/button/textbox with refs:");
  for (const el of snapshot.elements) {
    console.log(`  ${el.role} "${el.name}" [ref=${el.ref}]`);
  }

  // --- console + page errors ------------------------------------------------
  assert(
    snapshot.console.some((c) => c.text.includes("page loaded")),
    "console log captured",
  );
  assert(
    snapshot.errors.some((e) => e.kind === "unhandledrejection"),
    "unhandled rejection captured",
  );
  console.log("[console] page loaded + unhandledrejection captured");

  // --- fill + click ---------------------------------------------------------
  const fill = await backend.act({
    kind: "fill",
    ref: textbox!.ref,
    value: "bob",
  });
  assert(fill.ok, `fill failed: ${fill.error}`);
  const click = await backend.act({ kind: "click", ref: button!.ref });
  assert(click.ok, `click failed: ${click.error}`);

  await new Promise((r) => setTimeout(r, 200));
  snapshot = await backend.observe();
  assert(
    snapshot.pageText.includes("saved: bob"),
    `click must update the page: ${snapshot.pageText.slice(0, 120)}`,
  );
  assert(
    snapshot.console.some((c) => c.text.includes("clicked: bob")),
    "click console log captured",
  );
  console.log("[act] fill + click ok — page shows `saved: bob`");

  // --- wait (event-driven, promise-resolving platform) ---------------------
  const waited = await backend.wait({ until: "idle", timeoutMs: 3000 });
  assert(waited.ok, `wait idle failed: ${JSON.stringify(waited)}`);
  console.log(`[wait] idle after ${waited.durationMs}ms`);

  // --- screenshot -----------------------------------------------------------
  const shot = await backend.screenshot({ format: "png" });
  assert(shot.mimeType === "image/png", `mime: ${shot.mimeType}`);
  assert(
    shot.data.length > 1000,
    `screenshot data too small: ${shot.data.length}`,
  );
  const bytes = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
  assert(
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
      bytes[3] === 0x47,
    "PNG magic bytes",
  );
  Deno.writeFileSync(
    `${SCRIPTS_DIR}/browser-host-smoke-${Date.now()}.png`,
    bytes,
  );
  console.log(`[screenshot] png ${bytes.length} bytes (PNG magic verified)`);

  // --- reload + re-observe ----------------------------------------------------
  const reload = await backend.act({ kind: "reload" });
  assert(reload.ok, "reload must not fail");
  // wait for the fresh document
  const reloaded = await backend.wait({ until: "load", timeoutMs: 5000 });
  assert(reloaded.ok, `wait load failed: ${JSON.stringify(reloaded)}`);
  await new Promise((r) => setTimeout(r, 300));
  snapshot = await backend.observe();
  assert(
    snapshot.console.some((c) => c.text.includes("page loaded")),
    "post-reload console must re-capture page loaded (probe re-injected)",
  );
  const button2 = snapshot.elements.find((e) => e.role === "button");
  assert(button2 !== undefined, "button must exist after reload");
  // After a full navigation the probe restarts and refs are re-numbered
  // from e1 — the same numbers may recur, but they address the NEW
  // document. Verify usability instead of number inequality:
  await backend.act({ kind: "click", ref: button2!.ref });
  await new Promise((r) => setTimeout(r, 200));
  const afterClick = await backend.observe();
  assert(
    afterClick.pageText.includes("saved:"),
    `post-reload click must work: ${afterClick.pageText.slice(0, 100)}`,
  );
  console.log(
    "[reload] page reloaded, probe re-injected (refs re-numbered from e1)",
  );

  // --- URL policy (host-side defense, RPC without client validation) --------
  const refused = await (async () => {
    try {
      // Bypass the Deno policy by calling the raw endpoint directly.
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lumisca-browser-token": token,
        },
        body: JSON.stringify({
          id: 999,
          method: "open",
          params: { url: "https://example.com/" },
        }),
      });
      const body = await response.json();
      console.log("[policy] raw response:", JSON.stringify(body).slice(0, 200));
      // The raw wire shape carries page-level failures inside `result`
      // (the eval channel cannot throw); the loopback policy rejection is
      // one of them.
      return body.result?.error?.code ?? body.result?.code ?? "no-error";
    } catch (error) {
      return String(error);
    }
  })();
  assert(
    refused === "invalid",
    `non-loopback URL must be refused with invalid, got: ${refused}`,
  );
  assert(
    checkBrowserUrl("http://127.0.0.1:1234/") === undefined,
    "Deno-side policy sanity",
  );
  console.log("[policy] https://example.com refused by the host");

  // --- close: the host process must go away --------------------------------
  await backend.close();
  const deadline = Date.now() + 10_000;
  while (!exited && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(exited, "host process must exit after close");
  console.log("[close] host process exited");

  console.log("\nE2E SMOKE TEST PASSED");
} finally {
  if (!exited) {
    console.log("[cleanup] killing host");
    child.kill();
  }
  await pageServer.shutdown();
}
