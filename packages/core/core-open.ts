import { dirname, join } from "node:path";
import type { Provider } from "./ai/catalog.ts";
import {
  type CoreHost,
  type CoreOverrides,
  createCoreGraph,
} from "./bootstrap.ts";
import { LumiscaCore } from "./core.ts";
import { LumiscaDb } from "./db/mod.ts";
import type { EnvReader } from "./models/custom.ts";
import {
  ATTACHMENTS_DIR_NAME,
  SessionAttachmentStore,
} from "./session/attachments.ts";
import { SessionVisualStore, VISUALS_DIR_NAME } from "./session/visuals.ts";
import { resolveSettingsPath } from "./settings/path.ts";
import {
  createFileSettingsRepo,
  createInMemorySettingsRepo,
  type SettingsRepo,
} from "./settings/repo.ts";
import { AGENT_ICONS_DIR_NAME, AgentIconStore } from "./stella/icons.ts";
import type { VmChannelRunner } from "./vm/channel.ts";
import type { VmCommandBytesRunner, VmCommandRunner } from "./vm/command.ts";

/** The facade's own methods, as the graph builder sees them. */
function hostFor(core: () => LumiscaCore): CoreHost {
  return {
    buildGeneratedPrompt: (workspace, stella) =>
      core().internals.buildGeneratedPrompt(workspace, stella),
    browserBackend: () => core().capabilities.getBrowserBackend(),
    computerHostForSession: () => core().capabilities.computerHostForSession(),
    decorateSession: (session) => core().internals.decorateSession(session),
    deleteSession: (id) => core().services.sessions.deleteSession(id),
    emit: (event) => core().emit(event),
    forgetSession: (sessionId) => core().forgetSession(sessionId),
    getCompactionPolicy: () => core().settings.compactionPolicy(),
    getLanguage: () => core().settings.language(),
    getOrCreateChatWorkspace: () => core().internals.getOrCreateChatWorkspace(),
    getStellaKeepFullLog: () => core().settings.stellaKeepsFullLog(),
    isAskToolEnabled: () => core().capabilities.isAskToolEnabled(),
    isCodeExecutionEnabled: () => core().capabilities.isCodeExecutionEnabled(),
    requireModel: (provider, modelId) =>
      core().internals.requireModel(provider, modelId),
    requireWorkspace: (id) => core().internals.requireWorkspace(id),
    resolveDefaultModel: (provider, modelId) =>
      core().internals.resolveDefaultModel(provider, modelId),
    routineRunner: () => core().routines.runner(),
    setSessionName: (id, name) =>
      core().services.sessions.setSessionName(id, name),
    stellaRuntimeFor: (session) => core().internals.stellaRuntimeFor(session),
  };
}

function createCore(
  db: LumiscaDb,
  settings: SettingsRepo,
  overrides: CoreOverrides = {},
): LumiscaCore {
  let core: LumiscaCore | undefined;
  const graph = createCoreGraph(
    db,
    settings,
    overrides,
    hostFor(() => {
      if (core === undefined) {
        throw new Error("core host called before construction finished");
      }
      return core;
    }),
  );
  core = new LumiscaCore(graph);
  return core;
}

/** Settings live in ~/.config/lumisca-agent/settings.jsonc by default
 * (see resolveSettingsPath); an explicit settingsPath overrides that.
 * `env` replaces the process environment the model layer reads; production
 * leaves it unset. */
export function openCore(
  dbPath: string,
  settingsPath: string = resolveSettingsPath(),
  env?: EnvReader,
): LumiscaCore {
  return createCore(
    LumiscaDb.open(dbPath),
    createFileSettingsRepo(settingsPath),
    {
      env,
      visuals: new SessionVisualStore(join(dirname(dbPath), VISUALS_DIR_NAME)),
      attachments: new SessionAttachmentStore(
        join(dirname(dbPath), ATTACHMENTS_DIR_NAME),
      ),
      agentIcons: new AgentIconStore(
        join(dirname(dbPath), AGENT_ICONS_DIR_NAME),
      ),
      dbPath,
    },
  );
}

export function openInMemoryCore(): LumiscaCore {
  return createCore(LumiscaDb.openInMemory(), createInMemorySettingsRepo());
}

/** Test-only: in-memory core with extra providers (e.g. the faux provider).
 * Global skill discovery is disabled: a test's skill catalog must come from
 * its own fixture, never from the machine running it. `env` defaults to
 * EMPTY so a test never reads the process environment. `stellaRun` replaces
 * the machine's command runner, so a test can give a stella session a skill
 * directory without a container. */
export function forTestingCore(
  extraProviders: Provider[] = [],
  env: EnvReader = () => ({}),
  stellaRun?: {
    run: VmCommandRunner;
    runBytes: VmCommandBytesRunner;
    openChannel?: VmChannelRunner;
  },
): LumiscaCore {
  const core = createCore(
    LumiscaDb.openInMemory(),
    createInMemorySettingsRepo(),
    {
      globalSkillDirs: [],
      appSkillDirs: [],
      env,
      ...(stellaRun !== undefined ? { stellaRun } : {}),
    },
  );
  for (const provider of extraProviders) {
    core.models.models.setProvider(provider);
  }
  return core;
}
