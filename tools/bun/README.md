# Bun migration

The server runs, tests, checks and builds on Bun. The migration landed on
`master`; this file records what moved and how it was verified. `tools/bun/`
keeps the one piece that is still needed at runtime — the `Deno.test` glue
(`deno-shim.ts`) — and the script that loads it (`bunfig.toml`).

## What changed

- `packages/core/runtime/runtime.ts` — the runtime API this app is written
  against, implemented on Bun and Node: files, env, `Command`, `serve` with
  WebSocket upgrade, `listen`/`connect`, `build.standalone`. The shape is
  Deno's (the names, the option objects and the quirks: `status` ends at
  process exit, `env` merges over the parent, a missing program throws from
  `spawn`). Product code calls it as `runtime.*`; the `Deno` global is kept
  for the test runner's `Deno.test` and the browser probe.
- `packages/server/mod.ts` imports that module first, so the packaged binary
  carries it.
- `scripts/build-server.ts` compiles with `bun build --compile` instead of
  `deno compile`; the desktop dev launch uses `bun run`.
- `scripts/fake-mcp-*.ts` use Node/Bun stdin/stdout instead of `Deno.*`.
- `tools/bun/deno-shim.ts` is only `Deno.test` → `bun:test` glue (hooks
  included), loaded with `bunfig.toml`.
- Formatting and lint are Biome (`biome.json`), the type check is `tsc`
  (`tsconfig.json`), and both are package.json scripts: `fmt`, `fmt:check`,
  `check`. The suite is `bun test --parallel --timeout 30000` (`test`).
  Biome reads `.gitignore` (`vcs.useIgnoreFile`), so build output, scratch
  folders and the agent's own tool output never reach the checks.
- CI and release run on Bun (`oven-sh/setup-bun`): `bun install
  --frozen-lockfile` then the package.json scripts. No workflow calls `deno`
  any more.
- Development commands are package.json scripts: `dev` (server + Vite),
  `dev:server`, `dev:web`, `dev:desktop`, `server`, `demo`, `seed:history`,
  `probe:*`.
- The Windows computer host's FFI goes through `computer/windows-ffi.ts`, a
  Deno-shaped bridge over `bun:ffi` (`dlopen`, pointers as numbers,
  `JSCallback`, `toArrayBuffer`).
- The database layer uses `bun:sqlite` rather than `node:sqlite`. Bun's
  `node:sqlite` keeps the database file open until every prepared statement
  is collected — there is no `finalize()` — and Windows refuses to rename or
  delete an open file. That broke the startup vacuum (which renames the
  database it just copied) and every test that deletes its temporary folder
  after closing one. `bun:sqlite`'s `close(true)` finalizes the statements
  first; `db/close.ts` is the single place that closes a database.
- `bun.lock` is the dependency lock; `package.json` carries the versions the
  root `deno.json` import map used to hold. `deno.json`/`deno.lock` are
  gone, and nothing reads them.

## Verified

- `bun run build:server --out <dir>`: assets.json + stella container + a
  141 MB single binary, in under 2 seconds on this machine.
- Running that binary from an unrelated cwd: `/api/health` 200, `/api/build`
  with a buildId, `/` with the embedded client, assets and the stella
  container directory found beside the binary, standalone auto-update
  active. `bun run smoke:server --bin <path>` checks all of it.
- `bun run dev`: server on 8000, Vite on 5173, both 200, both stop together.
- `bun run check` (tsc), `bun run fmt:check` (Biome) and
  `bun run check:versions` are clean.
- `bun test --parallel --timeout 30000` on Windows:

| package | pass | fail | skip |
| --- | ---: | ---: | ---: |
| core | 1718 | 0 | 11 |
| web | 547 | 0 | 0 |
| server | 366 | 0 | 0 |
| scripts | 9 | 0 | 0 |
| **total** | **2640** | **0** | **11** |

The skips are the tests that need a display, a browser backend or podman.
18 stella tests need podman; with a stand-in `podman` on `PATH` (`--version`
and `run` exit 0, `image` exits 1) the whole suite is green. CI runs on
Ubuntu, macOS and Windows and is green on all three.

## Windows, on a real desktop

- `bun run probe:computer`: the host reports itself, lists three displays
  (one primary), and captures 2560×1440 in 75 ms through the `bun:ffi`
  bridge. The live host tests in `computer/windows_test.ts` pass: monitor
  enumeration, a 1:1 region capture, window enumeration and a double close.

