# Bun migration (branch `bun-migration`)

The server now runs, tests and builds on Bun. This branch is the migration
itself, not a spike; it is not merged yet.

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

## Verified

- `bun run scripts/build-server.ts --out <dir>`: assets.json + stella
  container + a 187 MB single binary, in about 2 seconds on this machine.
- Running that binary from an unrelated cwd: `/api/health` 200,
  `/api/build` with a buildId, `/` with the embedded client, assets and the
  stella container directory found beside the binary, standalone auto-update
  active.
- `bun test --parallel`:

| package | pass | fail | skip |
| --- | ---: | ---: | ---: |
| core | 1701 | 12 | 15 |
| web | 545 | 2 | 0 |
| server | 341 | 18 | 0 |
| **total** | **2587** | **32** | **15** |

93.9 % → 98.2 % since the spike.

## What still fails

- 20 of the 32 need podman, which this machine does not have (stella
  conversation/API/websocket tests).
- `eval` rejects re-declaring a const differently under Bun's VM.
- `killProcessTree` and the "descendant holds the pipes" case: process-group
  semantics of the `Command` adapter.
- Window ids round-trip through FFI pointers (`Deno.dlopen` still throws).
- One tar.gz mode assertion and one federation relay assertion.
- Two web tests assume `location`/`localStorage` exist (Deno's test
  environment provided them).

## Not done yet

- CI and release workflows still call `deno` (`setup-deno`, `deno task
  build:server`, `deno check`). They must switch to Bun before this branch
  is pushed, or CI will fail on the Deno-only static steps.
- `deno fmt`, `deno lint`, `deno check` need replacements (Biome/dprint and
  `tsc`); deciding the formatter is the open question.
- Windows FFI (`computer/windows.ts`) needs `bun:ffi`.
