import { useState } from "react";
import {
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconCode,
  IconEdit,
  IconFile,
  IconFolder,
  IconLoader,
  IconLoader2,
  IconMessageQuestion,
  IconSearch,
  IconSend,
  IconTerminal2,
  IconUsers,
  IconWorldSearch,
} from "@tabler/icons-react";
import {
  contentImages,
  contentText,
  TOOL_ASK,
  TOOL_ASYNC_BASH,
  TOOL_ASYNC_BASH_KILL,
  TOOL_ASYNC_BASH_STATUS,
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_EVAL,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LIST_DIR,
  TOOL_READ,
  TOOL_SEND_MESSAGE,
  TOOL_TASK,
  TOOL_TASK_OUTPUT,
  TOOL_WRITE,
} from "@lumisca/core/shared";
import type { ToolCallBlock, ToolResultMessage } from "../types.ts";
import { ContentImages } from "./ContentImages.tsx";

/** Map tool names to compact icons. */
function toolIcon(name: string) {
  switch (name) {
    // file reading
    case TOOL_READ:
    case "Read":
      return <IconFile size={13} />;
    // file writing / editing
    case TOOL_WRITE:
    case TOOL_EDIT:
    case "Edit":
    case "Write":
      return <IconEdit size={13} />;
    // directory listing
    case TOOL_LIST_DIR:
      return <IconFolder size={13} />;
    // shell commands
    case TOOL_BASH:
    case "Bash":
    // background shell commands
    case TOOL_ASYNC_BASH:
    case TOOL_ASYNC_BASH_STATUS:
    case TOOL_ASYNC_BASH_KILL:
      return <IconTerminal2 size={13} />;
    // search / grep
    case TOOL_GREP:
    case "Grep":
    case TOOL_GLOB:
    case "Search":
      return <IconSearch size={13} />;
    // web
    case "WebFetch":
      return <IconWorldSearch size={13} />;
    // sub-agent
    case "Agent":
    case TOOL_TASK:
      return <IconBrain size={13} />;
    // sub-agent output
    case TOOL_TASK_OUTPUT:
      return <IconUsers size={13} />;
    // agent-to-agent message
    case TOOL_SEND_MESSAGE:
      return <IconSend size={13} />;
    // code evaluation
    case TOOL_EVAL:
      return <IconCode size={13} />;
    // asking the user a question
    case TOOL_ASK:
      return <IconMessageQuestion size={13} />;
    // task list
    case "TodoWrite":
    case "TodoRead":
      return <IconCode size={13} />;
    default:
      return <IconLoader size={13} />;
  }
}

/** Extract a short summary from tool arguments. */
function toolSummary(name: string, args: Record<string, unknown>): string {
  switch (name) {
    // file reading — argument may be `path`, `file_path`, or `file`
    case TOOL_READ:
    case "Read":
      return shortPath(
        typeof args.path === "string"
          ? args.path
          : typeof args.file_path === "string"
          ? args.file_path
          : typeof args.file === "string"
          ? args.file
          : "",
      );
    // file writing / editing
    case TOOL_WRITE:
    case TOOL_EDIT:
    case "Edit":
    case "Write":
      return shortPath(
        typeof args.path === "string"
          ? args.path
          : typeof args.file_path === "string"
          ? args.file_path
          : "",
      );
    // directory listing — argument may be `path` or `dir`
    case TOOL_LIST_DIR:
      return typeof args.path === "string"
        ? args.path
        : typeof args.dir === "string"
        ? args.dir
        : ".";
    // shell commands
    case TOOL_BASH:
    case "Bash":
      return typeof args.command === "string" ? truncate(args.command, 60) : "";
    // background shell commands
    case TOOL_ASYNC_BASH:
      return typeof args.command === "string" ? truncate(args.command, 60) : "";
    case TOOL_ASYNC_BASH_STATUS:
      return typeof args.id === "string" ? `#${args.id}` : "list";
    case TOOL_ASYNC_BASH_KILL:
      return typeof args.id === "string" ? `#${args.id}` : "";
    // code evaluation — show the snippet
    case TOOL_EVAL:
      return typeof args.code === "string" ? truncate(args.code, 60) : "";
    // asking the user — show the number of questions / first question
    case TOOL_ASK: {
      const questions = Array.isArray(args.questions)
        ? args.questions as Array<{ question?: unknown }>
        : [];
      if (questions.length === 0) return "";
      if (questions.length === 1) {
        return typeof questions[0]!.question === "string"
          ? truncate(questions[0]!.question as string, 50)
          : "1 question";
      }
      return `${questions.length} questions`;
    }
    // search / grep — argument may be `pattern`, `query`, or `command`
    case TOOL_GREP:
    case "Grep":
      return typeof args.pattern === "string"
        ? args.pattern
        : typeof args.query === "string"
        ? args.query
        : typeof args.command === "string"
        ? truncate(args.command, 50)
        : "";
    case TOOL_GLOB:
      return typeof args.pattern === "string" ? args.pattern : "";
    case "Search":
      return typeof args.query === "string" ? truncate(args.query, 50) : "";
    // web
    case "WebFetch":
      return typeof args.url === "string" ? truncate(args.url, 50) : "";
    // sub-agent
    case "Agent":
    case TOOL_TASK:
      return typeof args.description === "string"
        ? truncate(args.description, 50)
        : typeof args.prompt === "string"
        ? truncate(args.prompt, 50)
        : "";
    case TOOL_TASK_OUTPUT:
      return typeof args.agent_id === "string"
        ? `${args.agent_id}${args.wait === true ? " (wait)" : ""}`
        : "";
    case TOOL_SEND_MESSAGE:
      return typeof args.to === "string"
        ? `to ${args.to}: ${
          typeof args.summary === "string" ? truncate(args.summary, 40) : ""
        }`
        : "";
    // task list
    case "TodoWrite":
      return "update task list";
    case "TodoRead":
      return "read task list";
    default:
      // Generic: show first string arg value.
      for (const v of Object.values(args)) {
        if (typeof v === "string" && v.length > 0) return truncate(v, 50);
      }
      return "";
  }
}

/** Show only the tail of a file path (e.g. "src/components/Chat.tsx"). */
function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

interface ToolCallProps {
  toolCall: ToolCallBlock;
  result?: ToolResultMessage;
  running: boolean;
}

export function ToolCall({ toolCall, result, running }: ToolCallProps) {
  const [open, setOpen] = useState(false);

  const state = result
    ? result.isError ? "error" : "done"
    : running
    ? "running"
    : "pending";

  const summary = toolSummary(
    toolCall.name,
    toolCall.arguments as Record<string, unknown>,
  );

  return (
    <div className="tool-timeline">
      <div
        className={`tool-line${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tool-line-chevron">
          <IconChevronRight size={12} />
        </span>
        <span className="tool-line-icon">
          {state === "running"
            ? <IconLoader2 size={13} className="spin" />
            : toolIcon(toolCall.name)}
        </span>
        <span className="tool-line-name">{toolCall.name}</span>
        {summary && (
          <>
            <span className="tool-line-sep">·</span>
            <span className="tool-line-summary">{summary}</span>
          </>
        )}
        {state === "done" && (
          <IconCheck
            size={12}
            className="tool-line-check"
          />
        )}
        {state === "error" && <span className="tool-line-error">error</span>}
      </div>
      {open && (
        <div className="tool-detail">
          <div className="tool-detail-args">
            {JSON.stringify(toolCall.arguments, null, 2)}
          </div>
          {result && (
            <div
              className={`tool-detail-result${result.isError ? " error" : ""}`}
            >
              <pre>{contentText(result.content)}</pre>
              {contentImages(result.content).length > 0 && (
                <ContentImages images={contentImages(result.content)} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
