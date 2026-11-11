/**
 * The environment a service document may carry is a subset of what the server
 * reads.
 *
 * `systemd/document.ts` lists the keys a generated `service.env` may hold;
 * `startup.ts` lists the keys the server reads from its environment. The
 * document list exists to reject a typo (a misspelled `LUMISCA_ALLOWED_HOST`
 * would otherwise leave remote clients with a 403 and no explanation), and it
 * documented itself as "SERVER_STARTUP_ENV_KEYS plus XDG_CONFIG_HOME" — but
 * the two were separate literals, so a key added to the server and forgotten
 * here is a setting the service command cannot express, and one added here
 * alone is a key the server silently ignores.
 *
 * Only one direction is checked: the document may name a key the server does
 * not read only if it is the settings-file location, which the server reads
 * through a different path. The other direction is a choice, not an
 * invariant — a document does not have to expose every key (the desktop
 * bridge's two are not settable through a unit).
 */
import { assertEquals } from "@std/assert";
import { SERVER_STARTUP_ENV_KEYS } from "../startup.ts";
import { DOCUMENT_KEYS } from "./document.ts";

/** Keys a document may carry that the startup allow-list does not hold: the
 * settings directory, which `resolveSettingsPath` reads directly. */
const NOT_STARTUP_KEYS = new Set(["XDG_CONFIG_HOME"]);

Deno.test("every service-document key is one the server reads", () => {
  const startup = new Set<string>(SERVER_STARTUP_ENV_KEYS);
  const unknown = DOCUMENT_KEYS.filter(
    (key) => !startup.has(key) && !NOT_STARTUP_KEYS.has(key),
  );
  assertEquals(
    unknown,
    [],
    "a service document may only carry keys startup.SERVER_STARTUP_ENV_KEYS " +
      "names (plus XDG_CONFIG_HOME): " +
      unknown.join(", "),
  );
});

Deno.test("the document exposes the keys a unit needs to configure a server", () => {
  // A unit that cannot say where its database, port or token is cannot be
  // installed. These are the minimum; the list may grow, never shrink.
  const document = new Set<string>(DOCUMENT_KEYS);
  for (const required of [
    "LUMISCA_HOST",
    "LUMISCA_PORT",
    "LUMISCA_DB",
    "LUMISCA_TOKEN",
  ]) {
    assertEquals(
      document.has(required),
      true,
      `a service document must be able to set ${required}`,
    );
  }
});
