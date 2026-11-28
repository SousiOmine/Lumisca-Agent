/**
 * Frontend-safe shared helpers: pure functions and constants used by the
 * web UI, the server, and the core. This module must stay free of
 * runtime dependencies (no db, no Node APIs) because esbuild bundles it
 * into the browser client; the web package imports it via
 * `@lumisca/core/shared`.
 *
 * Split for single responsibility without breaking importers:
 * - `./settings-keys.ts` — settings keys, saved prompts, model prefs,
 * - `./tool-names.ts` — TOOL_* agent-visible contract constants,
 * - `./interaction.ts` — ask / todo / task shapes,
 * - `./providers.ts` — thinking levels, provider/login/model summaries,
 * - `./content.ts` — message content helpers,
 * - `./visual.ts` — published visuals (the `visual:` image references),
 * - `./attachments.ts` — files an agent sends to the user, and their limits,
 * - `./chat-message.ts` — one `send_chat` message (words, card, files) as the
 *   conversation draws it,
 * - `./stella-preview.ts` — the second line of an agent's sidebar row (what
 *   the conversation last said) and the order of those rows,
 * - `./agent-avatar.ts` — a stella agent's avatar: the initial and its
 *   colour, and the icon formats' limits,
 * - `./mcp-config.ts` — MCP server config serialization,
 * - `./context-usage.ts` — context accounting and formatting,
 * - `./token-estimate.ts` — fixed-heuristic token estimates for history,
 * - `./app-mode.ts` — the operating mode the VIEW shows (code / stella),
 * - `./misc.ts` — errorMessage, InitialData, decode/parse/format helpers,
 * - `./digest.ts` — FNV-1a change-detection digests and canonical JSON,
 * - `./loopback.ts` — loopback host detection and URL host spellings,
 * - `./theme-colors.ts` — the canvas colour of each theme (the manifest's
 *   `theme_color`),
 * - `./web-search.ts` — the web-search setting's wire shape,
 * - `./routine.ts` — routine schedules, their limits and the next-run rule,
 * - `./watch-path.ts` — the field path a watch reads out of a tool's result,
 * - `./push.ts` — Web Push subscriptions and the base64url codec,
 * - `./markdown-text.ts` — a reply's markdown as the plain text of a
 *   notification,
 * - `./chat-ui/` — the prose and app cards a reply is split into,
 * - `./ui-app/` — the JSON spec, catalog, parser and state of an app card,
 * - `./i18n/mod.ts` — Locale, the message catalogue, locale resolution.
 *
 * Every name is listed here rather than re-exported with `export *`: the
 * barrel is the one import path 279 modules share, so its surface is a
 * contract. A star hid which module a name came from and let a new export in
 * any of them reach every importer without a review, and the public entry
 * point has to stay a list scripts/check-architecture.ts can check (see the
 * core-specifier rule there). Adding an export means adding one line below,
 * in the block of the module that declares it.
 */

export {
  AGENT_ICON_FORMATS,
  AGENT_ICON_MIME_BY_EXTENSION,
  agentAvatarHue,
  agentIconExtensionOfMimeType,
  agentIconMimeType,
  agentInitial,
  MAX_AGENT_ICON_BYTES,
} from "./agent-avatar.ts";
export { MAX_AGENT_IDENTITY_CHARS } from "./agent-limits.ts";
export {
  apiPath,
  conversationVerbs,
  enc,
  paths,
  routePath,
} from "./api-paths.ts";
export type { AppMode } from "./app-mode.ts";
export {
  APP_MODES,
  isAppMode,
} from "./app-mode.ts";
export type {
  AttachmentRef,
  PromptFileRef,
} from "./attachments.ts";
export {
  attachmentDisplayName,
  attachmentMimeType,
  attachmentsOfDetails,
  formatAttachmentSize,
  INLINE_IMAGE_MIME_BY_EXTENSION,
  isInlineImageExtension,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME_CHARS,
  MAX_ATTACHMENTS_PER_CALL,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  promptFileNotice,
  textWithFileNotice,
} from "./attachments.ts";
export { formatBytes } from "./bytes-format.ts";
export type { ChatMessage } from "./chat-message.ts";
export { chatMessageOfDetails } from "./chat-message.ts";
export type {
  FlowBlock,
  FlowEdge,
  FlowNode,
  FlowShape,
  UiAppSegment,
  UiSegment,
  UiTextSegment,
} from "./chat-ui/index.ts";
export {
  segmentsText,
  splitChatText,
} from "./chat-ui/index.ts";
export {
  contentImages,
  contentText,
  MAX_PROMPT_FILE_BYTES,
  MAX_PROMPT_FILES,
  MAX_PROMPT_FILES_TOTAL_BYTES,
  MAX_PROMPT_IMAGE_BASE64_LENGTH,
  MAX_PROMPT_TEXT_LENGTH,
  PROMPT_UPLOAD_CHUNK_BYTES,
  PROMPT_UPLOAD_CHUNK_HEADER,
  stripDataUrlHeader,
  toDataUrl,
} from "./content.ts";
export type {
  ContextUsageLike,
  ContextUsageMessageLike,
  ContextUsageSummary,
} from "./context-usage.ts";
export {
  addContextUsage,
  compactionUsageRatio,
  contextTokensOf,
  contextUsageOfMessage,
  contextUsageRatio,
  formatCompactTokens,
  formatContextUsageLine,
  formatPercent1,
  inputBudgetTokens,
  subtractContextUsage,
  summarizeContextUsage,
  withLatestContextUsage,
} from "./context-usage.ts";
export type { DiffLineCounts } from "./diff-stat.ts";
export {
  diffLineCounts,
  formatDiffStat,
  splitDiffLines,
} from "./diff-stat.ts";
export {
  canonicalJson,
  fnv1a,
} from "./digest.ts";
export {
  WS_HEARTBEAT_CHECK_MS,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_HEARTBEAT_TIMEOUT_MS,
  WS_HEARTBEAT_TYPE,
} from "./heartbeat.ts";
export type {
  Locale,
  LocalizedText,
  MessageKey,
  MessageParams,
  Translator,
} from "./i18n/mod.ts";
export {
  createTranslator,
  DEFAULT_LOCALE,
  isLocale,
  LOCALES,
  localeForTag,
  localeTag,
  messages,
  parseAcceptLanguage,
  parseLocale,
  resolveLocale,
  translate,
} from "./i18n/mod.ts";
export type {
  AskAnswer,
  AskOption,
  AskQuestion,
  AskTurn,
  SubagentStatus,
  SubagentType,
  TaskInfo,
  TodoPhase,
  TodoStatus,
  TodoTask,
} from "./interaction.ts";
export { sameAsks } from "./interaction.ts";
export {
  hostForUrl,
  isLoopbackHost,
} from "./loopback.ts";
export {
  markdownToText,
  notificationText,
} from "./markdown-text.ts";
export type { McpServerConfig } from "./mcp-config.ts";
export {
  mcpServerEntry,
  serializeMcpServers,
} from "./mcp-config.ts";
export {
  RASTER_IMAGE_MIME_BY_EXTENSION,
  rasterExtensionOfMimeType,
  SVG_EXTENSION,
  SVG_MIME_TYPE,
} from "./mime.ts";
export type {
  InitialData,
  SetupState,
} from "./misc.ts";
export {
  abortError,
  decodeUtf8,
  errorMessage,
  formatLocalDate,
  formatLocalDateTime,
  formatLocalDay,
  formatModelMeta,
  formatSessionName,
  parseJsonOrThrow,
  parseLocalDateTime,
  safeJsonParse,
  sleep,
  sleepAbortable,
  withRequestTimeout,
  withTimeout,
  withTimeoutError,
} from "./misc.ts";
export type {
  CatalogSourceKind,
  CatalogStatus,
  ModelInfo,
  ProviderAuthType,
  ProviderInfo,
  ProviderLoginEvent,
  ProviderLoginMethod,
  ProviderLoginPrompt,
  ProviderLoginSnapshot,
  ThinkingLevel,
} from "./providers.ts";
export {
  ALLOWED_OPENAI_APIS,
  THINKING_LEVEL_ORDER,
} from "./providers.ts";
export type {
  PushSubscriptionKeys,
  PushSubscriptionRecord,
} from "./push.ts";
export {
  fromBase64Url,
  isPushEndpoint,
  PUSH_ENDPOINT_MAX_CHARS,
  PUSH_KEY_MAX_CHARS,
  PUSH_MAX_SUBSCRIPTIONS,
  parsePushSubscriptions,
  serializePushSubscriptions,
  toBase64Url,
} from "./push.ts";
export type {
  Routine,
  RoutineSchedule,
  RoutineStatus,
  RoutineView,
  WatchSource,
} from "./routine.ts";
export {
  MAX_EVERY_MINUTES,
  MAX_WATCH_ARGS_CHARS,
  MAX_WATCH_MINUTES,
  MIN_EVERY_MINUTES,
  MIN_WATCH_MINUTES,
  nextRunAt,
  parseSchedule,
  ROUTINE_NAME_MAX_CHARS,
  ROUTINE_PROMPT_MAX_CHARS,
  ROUTINES_PER_AGENT_MAX,
  scheduleKey,
  scheduleProblem,
} from "./routine.ts";
export type {
  CommandApproval,
  CommandSafetyKind,
  CompactionPolicyInput,
  ModelPreference,
  SavedPrompt,
  ThemeSetting,
} from "./settings-keys.ts";
export {
  AGENT_IDENTITY_EDIT_KEY,
  AGENT_MCP_SETTINGS_PREFIX,
  APP_MCP_SETTINGS_KEY,
  APP_UI_IN_SYSTEM_PROMPT_KEY,
  ASK_TOOL_ENABLED_KEY,
  agentIdentityEditEnabled,
  agentMcpSettingsKey,
  appUiInSystemPrompt,
  askToolEnabled,
  CHATGPT_HOST_ID_KEY,
  CHATGPT_MODELS_KEY,
  CODE_EXECUTION_ENABLED_KEY,
  CODE_MODE_ENABLED_KEY,
  COMMAND_SAFETY_APPROVALS_KEY,
  COMMAND_SAFETY_ENABLED_KEY,
  COMPACTION_DEFAULT_KEEP_RECENT_PERCENT,
  COMPACTION_DEFAULT_RESERVE_PERCENT,
  COMPACTION_ENABLED_KEY,
  COMPACTION_RESERVE_PERCENT_KEY,
  COMPUTER_USE_ENABLED_KEY,
  COMPUTER_USE_SESSION_TOKEN_KEY,
  CONNECTIONS_KEY,
  codeExecutionEnabled,
  codeModeEnabled,
  DEFAULT_MODEL_KEY,
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  LANGUAGE_KEY,
  MODEL_ENABLED_PREFIX,
  MODEL_THINKING_PREFIX,
  PUSH_SUBSCRIPTIONS_KEY,
  PUSH_VAPID_KEY,
  parseCompactionPolicyInput,
  parseModelPreference,
  parseNonNegativeIntSetting,
  parsePercentSetting,
  parseSavedPrompts,
  SAVED_PROMPTS_KEY,
  STELLA_KEEP_FULL_LOG_KEY,
  serializeModelPreference,
  serializeSavedPrompts,
  stellaKeepsFullLog,
  UPDATE_AUTO_KEY,
  UPDATE_AUTO_RESTART_KEY,
  USER_PROVIDERS_KEY,
  WEB_SEARCH_KEY,
} from "./settings-keys.ts";
export type { ShellHeadOptions } from "./shell-head.ts";
export { shellHeadTags } from "./shell-head.ts";
export type {
  StellaAgentSummary,
  StellaAgentSummaryBase,
  StellaPreview,
} from "./stella-preview.ts";
export {
  compareAgentRows,
  mergeAgentRows,
  newestPreview,
  PREVIEW_TEXT_CHARS,
  previewOf,
  previewText,
  samePreview,
  withAgentPreview,
  withAgentRow,
} from "./stella-preview.ts";
export { THEME_COLORS } from "./theme-colors.ts";
export {
  estimateLlmMessagesTokens,
  estimateLlmMessageTokens,
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTextTokens,
  estimateToolTokens,
  IMAGE_TOKEN_ESTIMATE,
} from "./token-estimate.ts";
export {
  TOOL_AGENT_CREATE,
  TOOL_ASK,
  TOOL_ASYNC_BASH,
  TOOL_ASYNC_BASH_KILL,
  TOOL_ASYNC_BASH_STATUS,
  TOOL_BASH,
  TOOL_BROWSER_ACT,
  TOOL_BROWSER_CLOSE,
  TOOL_BROWSER_OBSERVE,
  TOOL_BROWSER_OPEN,
  TOOL_BROWSER_SCREENSHOT,
  TOOL_BROWSER_WAIT,
  TOOL_CALL,
  TOOL_CHAT_ATTACH,
  TOOL_COMPUTER_ACT,
  TOOL_COMPUTER_LIST_WINDOWS,
  TOOL_COMPUTER_SCREENSHOT,
  TOOL_EDIT,
  TOOL_EVAL,
  TOOL_EXECUTE,
  TOOL_HISTORY_SEARCH,
  TOOL_IDENTITY,
  TOOL_LIST_DIR,
  TOOL_MCP_ADD,
  TOOL_MCP_LIST,
  TOOL_MCP_REMOVE,
  TOOL_PDF_READ_PAGES,
  TOOL_READ,
  TOOL_ROUTINE_CREATE,
  TOOL_ROUTINE_DELETE,
  TOOL_ROUTINE_LIST,
  TOOL_ROUTINE_RUN,
  TOOL_ROUTINE_UPDATE,
  TOOL_SEARCH,
  TOOL_SEND_CHAT,
  TOOL_SEND_MESSAGE,
  TOOL_SHARE_DISCONNECT,
  TOOL_SHARE_DOWNLOAD,
  TOOL_SHARE_REQUEST,
  TOOL_SHARE_UPLOAD,
  TOOL_SKILL,
  TOOL_TASK,
  TOOL_TASK_OUTPUT,
  TOOL_TODO,
  TOOL_VISUAL,
  TOOL_VM_ACT,
  TOOL_VM_ASK_USER,
  TOOL_VM_DO,
  TOOL_VM_ENV,
  TOOL_VM_FIND,
  TOOL_VM_LAUNCH,
  TOOL_VM_SCREENSHOT,
  TOOL_VM_WAIT,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
} from "./tool-names.ts";
export { truncateText } from "./truncate.ts";
export type {
  AppCardProblem,
  UiAppAction,
  UiAppBinding,
  UiAppComponent,
  UiAppCondition,
  UiAppContext,
  UiAppElement,
  UiAppItemKind,
  UiAppParseResult,
  UiAppPrimitive,
  UiAppProp,
  UiAppPropKind,
  UiAppResolvedProps,
  UiAppResolvedValue,
  UiAppSetStateOp,
  UiAppSpec,
  UiAppState,
  UiAppStateStore,
  UiAppValue,
} from "./ui-app/index.ts";
export {
  appComponentNames,
  appHelp,
  applyAction,
  applyActions,
  bindingOf,
  cloneJson,
  completeJson,
  createUiAppState,
  firstAppCardProblem,
  isExpression,
  itemValue,
  parseAppSpec,
  parseAppSpecPartial,
  pathSegments,
  resolveCondition,
  resolveProps,
  resolveValue,
  templateReferences,
  textOf,
  UI_APP_COMPONENT_BY_NAME,
  UI_APP_COMPONENTS,
  UI_APP_EXPRESSION_KEYS,
  UI_APP_LIMITS,
  UI_APP_ROOT_TYPE,
  UI_HELP,
  UI_HELP_INLINE,
  valueAtPath,
} from "./ui-app/index.ts";
export {
  isVisualExtension,
  MAX_VISUAL_ASSET_BYTES,
  MAX_VISUAL_SVG_BYTES,
  maxVisualBytes,
  parseVisualRef,
  VISUAL_EXTENSIONS,
  VISUAL_MIME_BY_EXTENSION,
  VISUAL_REF_SCHEME,
  visualMimeType,
  visualRef,
} from "./visual.ts";
export {
  MAX_WATCH_IDS,
  resolveWatchPath,
  watchIdsFrom,
  watchPathProblem,
} from "./watch-path.ts";
export type {
  WebSearchAvailableProviderView,
  WebSearchProviderForm,
  WebSearchProviderId,
  WebSearchProviderUpdate,
  WebSearchProviderView,
  WebSearchSettingsView,
  WebSearchTestView,
} from "./web-search.ts";
export type {
  FsBreadcrumb,
  FsBrowse,
  FsEntry,
  FsPlace,
  FsPlaceKind,
  PeerStatus,
  PendingQuestionLike,
  SessionSnapshot,
  StellaAvailability,
  StellaMachineStatus,
  StellaStatus,
} from "./wire.ts";
export type {
  DeltaFrame,
  FrameBatcher,
  FrameBatcherOptions,
} from "./ws-batch.ts";
export {
  createFrameBatcher,
  WS_DELTA_FLUSH_MS,
  WS_DELTA_MAX_CHARS,
} from "./ws-batch.ts";
