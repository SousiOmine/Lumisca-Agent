/**
 * Type declaration for the test-only module instances of `shell.ts`.
 *
 * `shellIpc_test.ts` imports `./shell.ts?without-bridge` and
 * `?without-ipc` to get a fresh copy after changing a global (module state is
 * captured at import time). Bun resolves those query-suffixed specifiers at
 * run time; TypeScript needs to be told what they export.
 */
declare module "*?without-bridge" {
  export const shellCall: typeof import("../packages/web/src/shell.ts").shellCall;
}

declare module "*?without-ipc" {
  export const shellCall: typeof import("../packages/web/src/shell.ts").shellCall;
}
