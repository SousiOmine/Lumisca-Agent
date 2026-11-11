# Bun migration (branch `bun-migration`)

The server runs, tests, checks and builds on Bun. This branch is the
migration itself; it is not merged yet.

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
- CI and release run on Bun (`oven-sh/setup-bun`): `bun install
  --frozen-lockfile` then the package.json scripts. No workflow calls `deno`
  any more.
- Development commands are package.json scripts: `dev` (server + Vite),
  `dev:server`, `dev:web`, `dev:desktop`, `server`, `demo`, `seed:history`,
  `probe:*`.
- The Windows computer host's FFI goes through `computer/windows-ffi.ts`, a
  Deno-shaped bridge over `bun:ffi` (`dlopen`, pointers as numbers,
  `JSCallback`, `toArrayBuffer`).
- `bun.lock` is the dependency lock; `package.json` carries the versions the
  root `deno.json` import map used to hold. `deno.json`/`deno.lock` remain
  only as a local `deno check` cross-check and for the version entries.

## Verified

- `bun run build:server --out <dir>`: assets.json + stella container + a
  195 MB single binary, in about 2 seconds on this machine.
- Running that binary from an unrelated cwd: `/api/health` 200, `/api/build`
  with a buildId, `/` with the embedded client, assets and the stella
  container directory found beside the binary, standalone auto-update
  active. `bun run smoke:server --bin <path>` checks all of it.
- `bun run dev`: server on 8000, Vite on 5173, both 200, both stop together.
- `bun test --parallel --timeout 30000`:

| package | pass | fail | skip |
| --- | ---: | ---: | ---: |
| core | 1714 | 0 | 15 |
| web | 547 | 0 | 0 |
| server | 366 | 0 | 0 |
| **total** | **2627** | **0** | **15** |

18 stella tests need podman; with a stand-in `podman` on `PATH` (`--version`
and `run` exit 0, `image` exits 1) the whole suite is green. CI runs on
Ubuntu, macOS and Windows and is green on all three.

## Not verified

- The Windows FFI bridge has not run on a real Windows desktop: the machine
  this was written on is Linux, and the host's tests skip without a display.
  The structures and sizes are unchanged; only the bridge is new. The first
  thing to check on Windows is monitor enumeration and one screenshot,
  before anything is clicked.

## Left to do

- Delete `deno.json` / `deno.lock` (and the version entries they carry), and
  with them the local `deno check` cross-check. Nothing in CI or the release
  flow reads them any more.
