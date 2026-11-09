import type { StellaApi } from "./stella.ts";

/**
 * A stand-in for the routes' StellaApi.
 *
 * Route tests only care about the two or three methods the route under test
 * calls. Writing the whole interface by hand produces a `as unknown as
 * StellaApi` cast per file, and the cast then hides the opposite problem: a
 * route that starts calling a method the test never implemented reads
 * `undefined` and fails somewhere later with a message about the property, not
 * about the missing stub.
 *
 * Every method here either comes from `overrides` or throws with its own name.
 * Symbols (and `then`, which a promise-like check may read) stay undefined:
 * the stub is an object, not a thenable.
 */
export function stellaApiStub(overrides: Partial<StellaApi>): StellaApi {
  const target = overrides as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property];
      if (typeof property !== "string" || property === "then") return undefined;
      throw new Error(`stellaApiStub: ${property} is not implemented`);
    },
  }) as unknown as StellaApi;
}
