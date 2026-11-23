/**
 * Which tests need the machine and which do not.
 *
 * `bun test` discovers every `*_test.ts` and runs them in one pool, so a
 * test that writes a temporary directory, binds a port, spawns a process or
 * opens SQLite shares a scheduler with a test that is pure arithmetic. Under
 * load (a `cargo build` in the next terminal, a CI runner busy with another
 * job) the environment-bound tests miss their deadline first, and the
 * failure says nothing about the code.
 *
 * The split is per file, not per test: a file that touches the environment
 * at all is integration, because its setup and teardown span the whole file.
 * `unit` is everything else — pure functions and in-memory collaborators.
 * `scripts/test-suites_test.ts` pins the classification of the files that
 * carry an environment marker, so adding a `mkdtemp()` to a unit test turns
 * the suite red instead of quietly slowing the unit run down.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Imports and globals only an integration test has. */
export const INTEGRATION_MARKERS: readonly RegExp[] = [
  /from\s+["']node:fs["']/,
  /from\s+["']node:fs\/promises["']/,
  /from\s+["']node:child_process["']/,
  /from\s+["']node:net["']/,
  /from\s+["']node:http["']/,
  /from\s+["']node:https["']/,
  /from\s+["']bun:sqlite["']/,
  /\bBun\.serve\s*\(/,
  /\bBun\.listen\s*\(/,
  /\bBun\.connect\s*\(/,
  /\bBun\.spawn\s*\(/,
  /\bBun\.write\s*\(/,
  /\bnew\s+WebSocket\s*\(/,
  // podman is a host daemon, not an in-memory stub.
  /\bpodman\b/,
  // A test that reads its own `LUMISCA_*` switch talks to a real service when
  // the switch is on: a `podman` machine, or a provider over the network.
  /process\.env\[["']LUMISCA_(STELLA_LIVE|E2E_)/,
];

/** Test files `test:unit` must not run: they read or write the real file
 * system, bind a port, spawn a process, open a database, or need podman. */
export const INTEGRATION_SUITE: readonly string[] = [
  "packages/core/agent/sdk-tool-execution_test.ts",
  "packages/core/ai/prefix-cache.e2e_test.ts",
  "packages/core/browser/client_test.ts",
  "packages/core/browser/probe_test.ts",
  "packages/core/browser/tools_test.ts",
  "packages/core/browser/types_test.ts",
  "packages/core/code-execution/store_test.ts",
  "packages/core/core_code_execution_test.ts",
  "packages/core/core_context_test.ts",
  "packages/core/core_mcp-browser-computer_test.ts",
  "packages/core/core_models_test.ts",
  "packages/core/core_sessions_test.ts",
  "packages/core/core_tools_test.ts",
  "packages/core/core_workspaces_test.ts",
  "packages/core/db/schema_test.ts",
  "packages/core/db/vacuum_test.ts",
  "packages/core/fs_test.ts",
  "packages/core/mcp/mcp_test.ts",
  "packages/core/memory/agents-md_test.ts",
  "packages/core/memory/instructions_test.ts",
  "packages/core/models/catalog-refresh_test.ts",
  "packages/core/models/catalog-source_test.ts",
  "packages/core/models/custom_test.ts",
  "packages/core/pdf/icu-data_test.ts",
  "packages/core/pdf/tools_test.ts",
  "packages/core/plugins/discover_test.ts",
  "packages/core/plugins/mcp_test.ts",
  "packages/core/repo_hygiene_test.ts",
  "packages/core/routine/watch_test.ts",
  "packages/core/sandbox_test.ts",
  "packages/core/session/attachments_test.ts",
  "packages/core/session/visuals_test.ts",
  "packages/core/settings/settings_test.ts",
  "packages/core/settings/setup_test.ts",
  "packages/core/skills/builtin_test.ts",
  "packages/core/skills/catalog_test.ts",
  "packages/core/skills/discover_test.ts",
  "packages/core/stack_smoke_test.ts",
  "packages/core/stella/agents_test.ts",
  "packages/core/stella/icons_test.ts",
  "packages/core/stella_live_test.ts",
  "packages/core/stella_test.ts",
  "packages/core/tools/attach_test.ts",
  "packages/core/tools/background_test.ts",
  "packages/core/tools/bash_test.ts",
  "packages/core/tools/eval_test.ts",
  "packages/core/tools/filesystem_test.ts",
  "packages/core/tools/host/command-runner_test.ts",
  "packages/core/tools/host/files_test.ts",
  "packages/core/tools/host/process-tree_test.ts",
  "packages/core/tools/layering_test.ts",
  "packages/core/tools/send-chat_test.ts",
  "packages/core/tools/skill_test.ts",
  "packages/core/tools/task_test.ts",
  "packages/core/tools/truncate_test.ts",
  "packages/core/tools/visual_test.ts",
  "packages/core/vm/env-store_test.ts",
  "packages/core/vm/fs_test.ts",
  "packages/core/vm/machine_skills_test.ts",
  "packages/server/app_clipboard_test.ts",
  "packages/server/routes/stella_prompt_test.ts",
  "packages/web/src/components/stella/StellaTitleBarHeader_test.tsx",
  "packages/core/vm/container_test.ts",
  "packages/core/vm/uploads_test.ts",
  "packages/core/workspace/files_test.ts",
  "packages/server/app_events_test.ts",
  "packages/server/app_mcp_test.ts",
  "packages/server/app_models_test.ts",
  "packages/server/app_sessions_test.ts",
  "packages/server/app_setup_test.ts",
  "packages/server/app_share_test.ts",
  "packages/server/app_workspaces_test.ts",
  "packages/server/assets_test.ts",
  "packages/server/bundle_test.ts",
  "packages/server/federation_test.ts",
  "packages/server/health-probe_test.ts",
  "packages/server/routes/api_paths_test.ts",
  "packages/server/routes/attachments_test.ts",
  "packages/server/routes/fs_test.ts",
  "packages/server/routes/prompt-uploads_test.ts",
  "packages/server/routes/route_paths_test.ts",
  "packages/server/routes/visuals_test.ts",
  "packages/server/share-host_test.ts",
  "packages/server/startup_test.ts",
  "packages/server/systemd/mod_test.ts",
  "packages/server/update/archive_test.ts",
  "packages/server/update/install_test.ts",
  "packages/server/update/release_test.ts",
  "packages/server/update/service_test.ts",
  "packages/server/update/stage_test.ts",
  "packages/server/update/verify_test.ts",
  "packages/web/src/boundaries_test.ts",
  "packages/web/src/components/StellaSidebar_test.tsx",
  "packages/web/src/components/chat/AttachmentCard_test.tsx",
  "packages/web/src/confirm_test.ts",
  "packages/web/src/shell-actions_test.ts",
  "packages/web/src/styles_test.ts",
  "scripts/check-architecture_test.ts",
  "scripts/install-server_test.ts",
];

/** Whether a test file's source reaches for the machine. */
export function needsMachine(source: string): boolean {
  return INTEGRATION_MARKERS.some((marker) => marker.test(source));
}

/** Run order and suite membership of the discovered test files. Both
 * suites are sorted, so two runs on the same tree start the same files in
 * the same order and a flake is reproducible. A file in no suite is a bug
 * in the caller, and `listed` names entries the tree no longer has. */
export function partitionTestFiles(
  discovered: readonly string[],
  integration: readonly string[] = INTEGRATION_SUITE,
): { unit: string[]; integration: string[]; stale: string[] } {
  const known = new Set(integration);
  const present = new Set(discovered);
  return {
    unit: discovered.filter((file) => !known.has(file)).sort(),
    integration: discovered.filter((file) => known.has(file)).sort(),
    stale: integration.filter((file) => !present.has(file)).sort(),
  };
}

/** Test file names `bun test` discovers. Kept beside the markers so a file
 * cannot be integration by one rule and invisible to the other. */
const TEST_FILE = /(^|[._-])(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

const SKIP_DIRS = new Set([
  ".git",
  ".lumisca-cache",
  ".vite",
  ".tmpwork",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

/** Every test file in the tree, relative to `root`, sorted. */
export function discoverTestFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      const rel = prefix === "" ? entry : `${prefix}/${entry}`;
      if (statSync(path).isDirectory()) {
        walk(path, rel);
        continue;
      }
      if (TEST_FILE.test(entry)) found.push(rel);
    }
  };
  for (const dir of ["packages", "scripts"]) walk(join(root, dir), dir);
  return found.sort();
}

/** The two ways the list can fall behind the tree, found in one pass: a file
 * that reaches for the machine but is not listed, and a listed file that is
 * no longer there. `scripts/test-suites_test.ts` reports both. */
export function auditSuiteList(
  root: string,
  integration: readonly string[] = INTEGRATION_SUITE,
): { unlisted: string[]; stale: string[] } {
  const discovered = discoverTestFiles(root);
  const listed = new Set(integration);
  return {
    unlisted: discovered.filter(
      (file) =>
        !listed.has(file) &&
        needsMachine(readFileSync(join(root, file), "utf8")),
    ),
    stale: partitionTestFiles(discovered, integration).stale,
  };
}
