# Bun spike (2026-11-11)

This branch asks one question: **how much of the existing Deno test suite runs
under Bun, unchanged?** It is a measurement, not a migration. Nothing here is
meant to merge as is: the shim fakes the `Deno` namespace and the packaging
(compile, CI, fmt/lint) is untouched.

## Run

```sh
bun install
bun test --parallel          # all packages
bun test --parallel packages/core
```

`package.json` carries the npm dependencies with the versions from the root
`deno.json`; the five JSR packages were added with `bunx jsr add` (they land in
`package.json` as `npm:@jsr/...` and `.npmrc` pins the registry).
`tsconfig.json` maps the `@lumisca/*` workspace imports to source files.

`bunfig.toml` preloads `tools/bun/deno-shim.ts` for both `bun test` and
`bun run` — the second one matters because the suite spawns helper scripts
(fake MCP servers, fake podman) through `Deno.execPath()`.

## Result

| package | pass | fail | skip | notes |
| --- | ---: | ---: | ---: | --- |
| core | 1661 | 52 | 15 | plus 5 unhandled errors between tests |
| web | 545 | 2 | 0 | |
| server | 268 | 91 | 0 | plus 3 unhandled errors |
| **total** | **2474** | **145** | **15** | **93.9 % of 2634 tests** |

Whole run: roughly 50 seconds on this machine. Deno runs each test file in its
own process; Bun's `--parallel` gives each file a fresh global in a worker.

## What the shim covers

`Deno.test` (all three call forms), `Deno.env`, the whole file API used by the
suite (`readTextFile`, `readDir`, `stat`, `makeTempDir`, `open`…), `Command`,
`build`, `args`, `cwd`, `execPath`, `errors`, `stdin`/`stdout`, `serve` (HTTP
only), `networkInterfaces`, `addSignalListener`, `kill`.

Not replaced, and the reason the server package lags: `upgradeWebSocket`
(Hono's Deno adapter), `listen`/`connect`, `dlopen`/FFI (`windows.ts`).

## Where the 145 failures sit

1. **WebSocket** — 8 direct errors, and the federation/stella stream tests
   behind them. Needs the real design change: `createBunWebSocket()` and a
   server instance passed to `upgradeWebSocket`, instead of importing
   `hono/deno` in three modules.
2. **Process control** (~10) — `Deno.Command`/`Deno.kill` semantics: process
   groups, killing a tree, and returning when a descendant holds the pipes.
   An adapter can fix this, but it must be written deliberately.
3. **`@std/tar`** — the update/install tests throw `TypeError` inside JSR's
   tar code under Bun. Either replace it (npm `tar`, or `node:zlib` plus a
   reader) or keep the extraction out of Bun until then.
4. **`Deno.listen`** — the systemd install tests (port probing) use it.
5. **No podman in this machine** — 6 core + 13 server test failures are the
   environment, not Bun.
6. **Small assumptions**: `location`/`localStorage` exist under Deno but not
   under `bun test`, `Deno.dlopen` window ids, and one `eval` behaviour.

## Reading

The test suite is not the risk: 94 % already passes with a 400-line shim that
was written in one sitting. The risk is concentrated in WebSocket, process
control, tar and Windows FFI — four known, bounded pieces of work.
