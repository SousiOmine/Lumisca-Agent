import { assertEquals } from "@std/assert";
import { shouldRegisterServiceWorker } from "./pwa.ts";

Deno.test("the service worker is registered on https pages only", () => {
  // The install prompt only exists on a secure origin, and the worker's
  // cache is worth having only there: a page over plain http (a LAN
  // address, the loopback of a dev server) gets no PWA either way.
  assertEquals(shouldRegisterServiceWorker("https:", false), true);
  assertEquals(shouldRegisterServiceWorker("http:", false), false);
});

Deno.test("the desktop shell never registers the worker", () => {
  // The shell loads this server over `http://127.0.0.1`, which IS a secure
  // context — so the protocol alone does not exclude it, and a worker there
  // would keep a cached client bundle across the app's own update.
  assertEquals(shouldRegisterServiceWorker("https:", true), false);
  assertEquals(shouldRegisterServiceWorker("http:", true), false);
});
