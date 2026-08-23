// CLI wrapper e2e: createCliBrowserBackend → open/observe/close via the
// real binary. Assumes the release binary exists.
import { createCliBrowserBackend } from "../packages/cli/browser-host.ts";

const backend = createCliBrowserBackend();
const page = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: () => {} },
  () =>
    new Response(
      "<!doctype html><meta charset=utf-8><title>cli</title><button>ok</button>",
      {
        headers: { "content-type": "text/html" },
      },
    ),
);
const port = (page.addr as Deno.NetAddr).port;
try {
  const info = await backend.open({ url: `http://127.0.0.1:${port}/` });
  console.log("open:", info.url);
  await new Promise((r) => setTimeout(r, 800));
  const snapshot = await backend.observe();
  console.log(
    "observe:",
    snapshot.title,
    "- button:",
    snapshot.elements.find((e) => e.role === "button")?.name,
  );
  await backend.close();
  await new Promise((r) => setTimeout(r, 500));
  // The process must be gone; a follow-up call must fail with a clear
  // error (no silent respawn).
  try {
    await backend.observe();
    console.log("ERROR: observe after close must fail");
    Deno.exit(1);
  } catch (e) {
    console.log("after close, error:", (e as Error).message.slice(0, 80));
  }
  console.log("CLI BACKEND E2E PASSED");
  Deno.exit(0);
} finally {
  await page.shutdown();
}
