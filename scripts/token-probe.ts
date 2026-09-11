/**
 * Manual probe for the server's token guard: builds an app with a token
 * and checks that /api/health answers 401 without it and 200 with the
 * x-lumisca-token header. No network listener is started — the app is
 * driven through `fetch` directly.
 *
 * The Host header is set explicitly: a hand-built Request carries none,
 * and the Host guard (DNS-rebinding protection) would answer 403 before
 * the token check ever runs.
 *
 * Run from the repository root:
 *   deno run --allow-read --allow-env --allow-sys scripts/token-probe.ts
 */
import { fauxProvider, LumiscaCore } from "../packages/core/mod.ts";
import { createApp } from "../packages/server/app.ts";

const HOST = "127.0.0.1:8000";
const URL = `http://${HOST}/api/health`;

const faux = fauxProvider();
const core = LumiscaCore.forTesting([faux.provider]);
try {
  const app = createApp(core, { token: "secret-token" });
  const r = await app.fetch(
    new Request(URL, { headers: { host: HOST } }),
  );
  console.log("no token:", r.status, await r.text());
  const r2 = await app.fetch(
    new Request(URL, {
      headers: { host: HOST, "x-lumisca-token": "secret-token" },
    }),
  );
  console.log("with token:", r2.status);
} finally {
  await core.close();
}
