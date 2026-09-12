/**
 * The version this server build carries at runtime.
 *
 * A packaged server cannot read the repository manifests it was built from
 * (`deno compile` bakes the sources into the binary), but the updater has to
 * tell "the version I am" apart from "the version on the release page".
 * `scripts/check-versions.ts` lists this file as one more manifest, so the
 * constant can never drift from the tag the release was cut from.
 */
export const SERVER_VERSION = "0.7.7";
