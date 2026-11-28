import {
  contentImages,
  contentText,
  type MessageKey,
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
  TOOL_SKILL,
  TOOL_TASK,
  TOOL_TASK_OUTPUT,
  TOOL_TODO,
  TOOL_VISUAL,
  TOOL_VM_ACT,
  TOOL_VM_ASK_USER,
  TOOL_VM_SCREENSHOT,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
} from "@lumisca/core/shared";
import {
  IconBook,
  IconCamera,
  IconCheck,
  IconChevronRight,
  IconCode,
  IconDeviceDesktop,
  IconEdit,
  IconFile,
  IconFileText,
  IconFolder,
  IconHistory,
  IconListCheck,
  IconLoader,
  IconLoader2,
  IconMessageCircle,
  IconMessageQuestion,
  IconMouse,
  IconPaperclip,
  IconPhoto,
  IconPlug,
  IconRepeat,
  IconSearch,
  IconSend,
  IconSubtask,
  IconTerminal2,
  IconUser,
  IconUsers,
  IconWindowMaximize,
  IconWorld,
  IconWorldSearch,
} from "@tabler/icons-preact";
import type { ComponentType } from "preact/compat";
import { useExpandableRow } from "../hooks/useExpandableRow.ts";
import { useT } from "../i18n.ts";
import type { ToolCallBlock, ToolResultMessage } from "../types.ts";
import { ContentImages } from "./ContentImages.tsx";

type Args = Readonly<Record<string, unknown>>;
type IconComponent = ComponentType<{ size?: number }>;

interface ToolPresentation {
  icon: IconComponent;
  label: MessageKey;
  summary?: (args: Args, t: Translate) => string;
}

function arg(args: Args, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const pathTail = (args: Args) => shortPath(arg(args, "path"));
const command = (args: Args) => truncate(arg(args, "command"), 60);
const query = (args: Args) => truncate(arg(args, "query"), 50);
const url = (args: Args) => truncate(arg(args, "url"), 50);
const id = (args: Args) => arg(args, "id");
const act = (args: Args) =>
  [arg(args, "action"), arg(args, "ref")].filter(Boolean).join(" ");

function todoProgress(args: Args): string {
  const phases = Array.isArray(args.phases)
    ? (args.phases as Array<{ tasks?: unknown }>)
    : [];
  const tasks = phases.flatMap((phase) =>
    Array.isArray(phase.tasks)
      ? (phase.tasks as Array<{ status?: unknown }>)
      : [],
  );
  if (tasks.length === 0) return "";
  const done = tasks.filter((task) => task.status === "completed").length;
  return `${done}/${tasks.length}`;
}

type Translate = ReturnType<typeof useT>;

function askSummary(args: Args, t: Translate): string {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  if (questions.length === 0) return "";
  if (questions.length > 1) {
    return t("panels.tool.askQuestions", { count: questions.length });
  }
  const first = questions[0] as { question?: unknown } | undefined;
  return typeof first?.question === "string"
    ? truncate(first.question, 50)
    : t("panels.tool.askOneQuestion");
}

function pdfSummary(args: Args): string {
  const pages = Array.isArray(args.pages) ? args.pages : [];
  const path = pathTail(args);
  return pages.length === 0 ? path : `${path} p.${pages.join(",")}`;
}

const PRESENTATION: Readonly<Record<string, ToolPresentation>> = {
  [TOOL_READ]: {
    icon: IconFile,
    label: "panels.tool.name.read",
    summary: pathTail,
  },
  [TOOL_WRITE]: {
    icon: IconEdit,
    label: "panels.tool.name.write",
    summary: pathTail,
  },
  [TOOL_EDIT]: {
    icon: IconEdit,
    label: "panels.tool.name.edit",
    summary: pathTail,
  },
  [TOOL_LIST_DIR]: {
    icon: IconFolder,
    label: "panels.tool.name.listDir",
    summary: pathTail,
  },
  [TOOL_CHAT_ATTACH]: {
    icon: IconPaperclip,
    label: "panels.tool.name.chatAttach",
    summary: (args) => {
      const paths = Array.isArray(args.paths) ? args.paths : [];
      if (paths.length === 0) return "";
      const first = paths[0];
      const name = typeof first === "string" ? shortPath(first) : "";
      return paths.length === 1 ? name : `${name} +${paths.length - 1}`;
    },
  },
  [TOOL_VISUAL]: {
    icon: IconPhoto,
    label: "panels.tool.name.visual",
    summary: pathTail,
  },
  [TOOL_PDF_READ_PAGES]: {
    icon: IconFileText,
    label: "panels.tool.name.pdfReadPages",
    summary: pdfSummary,
  },
  [TOOL_BASH]: {
    icon: IconTerminal2,
    label: "panels.tool.name.bash",
    summary: command,
  },
  [TOOL_ASYNC_BASH]: {
    icon: IconTerminal2,
    label: "panels.tool.name.asyncBash",
    summary: command,
  },
  [TOOL_ASYNC_BASH_STATUS]: {
    icon: IconTerminal2,
    label: "panels.tool.name.asyncBashStatus",
    summary: (args, t) =>
      id(args) === "" ? t("panels.tool.backgroundList") : `#${id(args)}`,
  },
  [TOOL_ASYNC_BASH_KILL]: {
    icon: IconTerminal2,
    label: "panels.tool.name.asyncBashKill",
    summary: (a) => `#${id(a)}`,
  },
  [TOOL_EVAL]: {
    icon: IconCode,
    label: "panels.tool.name.eval",
    summary: (a) => truncate(arg(a, "code"), 60),
  },
  [TOOL_EXECUTE]: {
    icon: IconCode,
    label: "panels.tool.name.execute",
    summary: (a) => truncate(arg(a, "code"), 60),
  },
  [TOOL_WEB_SEARCH]: {
    icon: IconWorldSearch,
    label: "panels.tool.name.webSearch",
    summary: query,
  },
  [TOOL_WEB_FETCH]: {
    icon: IconWorldSearch,
    label: "panels.tool.name.webFetch",
    summary: url,
  },
  [TOOL_BROWSER_OPEN]: {
    icon: IconWorld,
    label: "panels.tool.name.browserOpen",
    summary: url,
  },
  [TOOL_BROWSER_OBSERVE]: {
    icon: IconWorld,
    label: "panels.tool.name.browserObserve",
  },
  [TOOL_BROWSER_ACT]: {
    icon: IconMouse,
    label: "panels.tool.name.browserAct",
    summary: act,
  },
  [TOOL_BROWSER_WAIT]: {
    icon: IconWorld,
    label: "panels.tool.name.browserWait",
    summary: (a) => arg(a, "until"),
  },
  [TOOL_BROWSER_SCREENSHOT]: {
    icon: IconCamera,
    label: "panels.tool.name.browserScreenshot",
    summary: (a) => arg(a, "format"),
  },
  [TOOL_BROWSER_CLOSE]: {
    icon: IconWorld,
    label: "panels.tool.name.browserClose",
  },
  [TOOL_COMPUTER_SCREENSHOT]: {
    icon: IconDeviceDesktop,
    label: "panels.tool.name.computerScreenshot",
  },
  [TOOL_COMPUTER_ACT]: {
    icon: IconMouse,
    label: "panels.tool.name.computerAct",
    summary: act,
  },
  [TOOL_COMPUTER_LIST_WINDOWS]: {
    icon: IconWindowMaximize,
    label: "panels.tool.name.computerListWindows",
    summary: (a) => arg(a, "title_contains"),
  },
  [TOOL_VM_SCREENSHOT]: {
    icon: IconDeviceDesktop,
    label: "panels.tool.name.computerScreenshot",
  },
  [TOOL_VM_ACT]: {
    icon: IconMouse,
    label: "panels.tool.name.computerAct",
    summary: act,
  },
  [TOOL_VM_ASK_USER]: {
    icon: IconMessageQuestion,
    label: "panels.tool.name.vmAskUser",
    summary: (a) => truncate(arg(a, "reason"), 50),
  },
  [TOOL_ASK]: {
    icon: IconMessageQuestion,
    label: "panels.tool.name.ask",
    summary: askSummary,
  },
  [TOOL_TODO]: {
    icon: IconListCheck,
    label: "panels.tool.name.todo",
    summary: todoProgress,
  },
  [TOOL_SEND_CHAT]: {
    icon: IconMessageCircle,
    label: "panels.tool.name.sendChat",
    summary: (a) => truncate(arg(a, "text"), 50),
  },
  [TOOL_SKILL]: {
    icon: IconBook,
    label: "panels.tool.name.skill",
    summary: (a) => arg(a, "name"),
  },
  [TOOL_HISTORY_SEARCH]: {
    icon: IconHistory,
    label: "panels.tool.name.historySearch",
    summary: query,
  },
  [TOOL_IDENTITY]: {
    icon: IconUser,
    label: "panels.tool.name.identity",
    summary: (a) => arg(a, "action"),
  },
  [TOOL_TASK]: {
    icon: IconSubtask,
    label: "panels.tool.name.task",
    summary: (a) => truncate(arg(a, "description") || arg(a, "prompt"), 50),
  },
  [TOOL_TASK_OUTPUT]: {
    icon: IconUsers,
    label: "panels.tool.name.taskOutput",
    summary: (a, t) =>
      `${arg(a, "agent_id")}${
        a.wait === true ? t("panels.tool.taskWaitSuffix") : ""
      }`,
  },
  [TOOL_SEND_MESSAGE]: {
    icon: IconSend,
    label: "panels.tool.name.sendMessage",
    summary: (a, t) =>
      t("panels.tool.sendTo", {
        to: arg(a, "to"),
        summary: truncate(arg(a, "summary"), 40),
      }),
  },
  [TOOL_AGENT_CREATE]: {
    icon: IconUser,
    label: "panels.tool.name.agentCreate",
    summary: (a) => arg(a, "name"),
  },
  [TOOL_ROUTINE_CREATE]: {
    icon: IconRepeat,
    label: "panels.tool.name.routineCreate",
    summary: (a) => arg(a, "name"),
  },
  [TOOL_ROUTINE_LIST]: {
    icon: IconRepeat,
    label: "panels.tool.name.routineList",
  },
  [TOOL_ROUTINE_UPDATE]: {
    icon: IconRepeat,
    label: "panels.tool.name.routineUpdate",
    summary: id,
  },
  [TOOL_ROUTINE_DELETE]: {
    icon: IconRepeat,
    label: "panels.tool.name.routineDelete",
    summary: id,
  },
  [TOOL_ROUTINE_RUN]: {
    icon: IconRepeat,
    label: "panels.tool.name.routineRun",
    summary: id,
  },
  [TOOL_SEARCH]: {
    icon: IconSearch,
    label: "panels.tool.name.search",
    summary: query,
  },
  [TOOL_CALL]: {
    icon: IconPlug,
    label: "panels.tool.name.call",
    summary: (a) => arg(a, "name"),
  },
};

function toolSummary(name: string, args: Args, t: Translate): string {
  const presentation = PRESENTATION[name];
  if (presentation !== undefined) {
    return presentation.summary ? presentation.summary(args, t) : "";
  }
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.length > 0) {
      return truncate(value, 50);
    }
  }
  return "";
}

function toolDiffStat(
  name: string,
  result?: ToolResultMessage,
): { added: number; removed: number } | null {
  if (name !== TOOL_EDIT && name !== TOOL_WRITE) return null;
  if (!result || result.isError) return null;
  const details = result.details as
    | { addedLines?: unknown; removedLines?: unknown }
    | undefined;
  if (
    typeof details?.addedLines !== "number" ||
    typeof details?.removedLines !== "number"
  ) {
    return null;
  }
  if (details.addedLines === 0 && details.removedLines === 0) return null;
  return { added: details.addedLines, removed: details.removedLines };
}

interface ToolCallProps {
  toolCall: ToolCallBlock;
  result?: ToolResultMessage;
  running: boolean;
}

export function ToolCall({ toolCall, result, running }: ToolCallProps) {
  const { open, triggerProps } = useExpandableRow();
  const t = useT();

  const state = result
    ? result.isError
      ? "error"
      : "done"
    : running
      ? "running"
      : "pending";

  const args = toolCall.arguments as Args;
  const presentation = PRESENTATION[toolCall.name];
  const label = presentation ? t(presentation.label) : toolCall.name;
  const summary = toolSummary(toolCall.name, args, t);
  const diffStat = toolDiffStat(toolCall.name, result);
  const Icon = presentation?.icon ?? IconLoader;

  return (
    <div className="tool-timeline">
      <div className={`tool-line${open ? " open" : ""}`} {...triggerProps}>
        <span className="tool-line-chevron">
          <IconChevronRight size={14} />
        </span>
        <span className="tool-line-icon">
          {state === "running" ? (
            <IconLoader2 size={14} className="spin" />
          ) : (
            <Icon size={14} />
          )}
        </span>
        <span className="tool-line-name">{label}</span>
        {summary && (
          <>
            <span className="tool-line-sep">·</span>
            <span className="tool-line-summary">{summary}</span>
          </>
        )}
        {diffStat && (
          <span className="tool-line-diff">
            {diffStat.added > 0 && (
              <span className="tool-diff-added">+{diffStat.added}</span>
            )}
            {diffStat.removed > 0 && (
              <span className="tool-diff-removed">-{diffStat.removed}</span>
            )}
          </span>
        )}
        {state === "done" && (
          <IconCheck size={14} className="tool-line-check" />
        )}
        {state === "error" && (
          <span className="tool-line-error">{t("common.error")}</span>
        )}
      </div>
      {/* Always mounted, with `data-open` carrying the state: a body that
       * unmounts cannot animate its height (styles/motion.css,
       * `.collapse`). */}
      <div className="collapse below" data-open={open}>
        <div className="collapse-inner">
          <div className="tool-detail">
            <div className="tool-detail-args">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </div>
            {result && (
              <div
                className={`tool-detail-result${
                  result.isError ? " error" : ""
                }`}
              >
                <pre>{contentText(result.content)}</pre>
                {contentImages(result.content).length > 0 && (
                  <ContentImages images={contentImages(result.content)} />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
