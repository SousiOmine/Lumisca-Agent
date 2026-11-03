/**
 * Shared HTTP test helpers: the app-startup and fetch patterns that used to
 * be copy-pasted across every `app_*_test.ts`.
 *
 * Test-only module (imports Deno + the server's app). Never imported from
 * production code or the browser bundle — `repo_hygiene_test.ts` only
 * exempts `*_test.ts` files from the core-barrel rule, so keeping this file
 * out of any non-test import path is the caller's job.
 */
import { fauxProvider } from "@lumisca/core";
import { LumiscaCore } from "@lumisca/core";
import { MINI_PNG } from "@lumisca/core/test-utils";
import { type AppOptions, startServer } from "./app.ts";

/** The pieces a test needs once the app is listening: the core, the server
 * (for the port and for shutdown), the faux provider (to script replies) and
 * the base URL. */
export interface AppHarness {
  core: LumiscaCore;
  server: ReturnType<typeof startServer>;
  faux: ReturnType<typeof fauxProvider>;
  base: string;
}

/**
 * Start an app on an ephemeral port with a faux provider, the way every
 * `app_*_test.ts` did before this module existed.
 *
 * The caller owns the teardown (the suite has a test per file that closes in
 * `finally`, matching what each file used to write inline):
 *
 *   const { core, server, base } = setup();
 *   try { … } finally { disposeServer(server); server.shutdown(); await core.close(); }
 */
export function setup(
  env?: () => Record<string, string>,
  options?: AppOptions,
): AppHarness {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider], env);
  const server = startServer(core, 0, options);
  const base = `http://127.0.0.1:${server.addr.port}`;
  return { core, server, faux, base };
}

/** A JSON fetch against a started app. */
export function json(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

/**
 * The transcript without the dynamic-context publications (skill catalog,
 * instructions, date, on-demand tools) a session publishes ahead of the
 * first user message of a run. Those are not part of a turn, so the tests
 * that count or position turns count this array.
 */
export function conversationOf<T extends { role: string }>(
  messages: T[],
): T[] {
  return messages.filter((m) => m.role !== "context");
}

/**
 * The base64 body an icon upload takes: the same bytes the store's tests
 * use, in the shape a browser's `FileReader` produces (minus the data-URL
 * header, which the route also accepts).
 */
export function pngBase64(): string {
  let binary = "";
  for (const byte of MINI_PNG) binary += String.fromCharCode(byte);
  return btoa(binary);
}
