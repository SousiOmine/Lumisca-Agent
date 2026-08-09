import { createApp } from "../packages/server/app.ts";
import { LumiscaCore } from "../packages/core/mod.ts";
import { fauxProvider } from "@earendil-works/pi-ai";

const faux = fauxProvider();
const core = LumiscaCore.forTesting([faux.provider]);
const app = createApp(core, { token: "secret-token" });
const r = await app.fetch(new Request("http://127.0.0.1:8000/api/health"));
console.log("no token:", r.status, await r.text());
const r2 = await app.fetch(
  new Request("http://127.0.0.1:8000/api/health", {
    headers: { "x-lumisca-token": "secret-token" },
  }),
);
console.log("with token:", r2.status);
core.close();
