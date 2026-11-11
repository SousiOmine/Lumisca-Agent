# Bun migration (branch `bun-migration`)

The server now runs, tests, checks and builds on Bun. This branch is the
migration itself, not a spike; it is not merged yet.

## What changed

- `packages/core/runtime/deno.ts` — a first-party implementation of the
  `Deno` API surface this codebase uses (files, env, `Command`, `serve` with
  WebSocket upgrade, `listen`/`connect`, `build.standalone`). Nothing in it
  calls the Deno runtime. The name stays because 460 call sites still say
  `Deno.*`; renaming them is a mechanical follow-up.
- `packages/server/mod.ts` imports that module first, so the packaged binary
  carries it.
- `scripts/build-server.ts` compiles with `bun build --compile` instead of
  `deno compile`; the desktop dev launch uses `bun run`.
- `scripts/fake-mcp-*.ts` use Node/Bun stdin/stdout instead of `Deno.*`.
- `tools/bun/deno-shim.ts` is now only `Deno.test` → `bun:test` glue, loaded
  with `bunfig.toml`.
- Formatting and lint are Biome (`biome.json`), the type check is `tsc`
  (`tsconfig.json`), and both are package.json scripts: `fmt`, `fmt:check`,
  `check`. The suite is `bun test --parallel` (`test`).
- CI and release run on Bun (`oven-sh/setup-bun`): `bun install
  --frozen-lockfile` then the package.json scripts. No workflow calls `deno`
  any more.
- `bun.lock` is the dependency lock; `package.json` carries the same versions
  as the root `deno.json` import map, which is still what `deno check` (a
  local cross-check, no longer part of CI) resolves.

## Verified

- `bun run build:server --out <dir>`: assets.json + stella container + a
  195 MB single binary, in about 2 seconds on this machine.
- Running that binary from an unrelated cwd: `/api/health` 200,
  `/api/build` with a buildId, `/` with the embedded client, assets and the
  stella container directory found beside the binary, standalone auto-update
  active. `bun run smoke:server --bin <path>` checks all of it.
- `bun test --parallel`:

| package | pass | fail | skip |
| --- | ---: | ---: | ---: |
| core | 1714 | 0 | 15 |
| web | 547 | 0 | 0 |
| server | 366 | 0 | 0 |
| **total** | **2627** | **0** | **15** |

93.9 % → 100 % of the tests that can run here.

18 stella tests need podman, which this machine does not have. They are the
only failures without it; with a stand-in `podman` on `PATH` (`--version` and
`run` exit 0, `image` exits 1) the whole suite is green.

## Not done yet

- Windows FFI (`computer/windows.ts`) needs `bun:ffi`; `Deno.dlopen` throws.
  `Deno.UnsafePointer.create/value` is enough to parse and format window ids,
  but nothing native can be called.
- `Deno.*` naming (460 call sites) and the now-unused `deno.json` tasks.
- Development commands still come from `deno task` (`dev`, `dev:server`,
  `probe:*`): they need `bun run` equivalents before Deno can be removed.
