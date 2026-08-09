import { useState } from "react";
import {
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconCode,
  IconEdit,
  IconFile,
  IconFolder,
  IconLoader2,
  IconLoader,
  IconSearch,
  IconTerminal2,
  IconWorldSearch,
} from "@tabler/icons-react";
import { contentText } from "@lumisca/core/shared";
import type { ToolCallBlock, ToolResultMessage } from "../types.ts";

/** Map tool names to compact icons. */
function toolIcon(name: string) {
  switch (name) {
    // file reading
    case "read_file":
    case "Read":
      return <IconFile size={13} />;
    // file writing / editing
    case "write_file":
    case "Edit":
    case "Write":
      return <IconEdit size={13} />;
    // directory listing
    case "list_dir":
      return <IconFolder size={13} />;
    // shell commands
    case "bash":
    case "Bash":
      return <IconTerminal2 size={13} />;
    // search / grep
    case "grep":
    case "Grep":
    case "Glob":
    case "Search":
      return <IconSearch size={13} />;
    // web
    case "WebFetch":
      return <IconWorldSearch size={13} />;
    // sub-agent
    case "Agent":
      return <IconBrain size={13} />;
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
    case "read_file":
    case "Read":
      return shortPath(
        typeof args.path === "string"
          ? args.path
          : typeof args.file_path === "string"
          ? args.file_path
          : typeof args.file === "string"
          ? args.file
          : ""
      );
    // file writing / editing
    case "write_file":
    case "Edit":
    case "Write":
      return shortPath(
        typeof args.path === "string"
          ? args.path
          : typeof args.file_path === "string"
          ? args.file_path
          : ""
      );
    // directory listing — argument may be `path` or `dir`
    case "list_dir":
      return typeof args.path === "string"
        ? args.path
        : typeof args.dir === "string"
        ? args.dir
        : ".";
    // shell commands
    case "bash":
    case "Bash":
      return typeof args.command === "string"
        ? truncate(args.command, 60)
        : "";
    // search / grep — argument may be `pattern`, `query`, or `command`
    case "grep":
    case "Grep":
      return typeof args.pattern === "string"
        ? args.pattern
        : typeof args.query === "string"
        ? args.query
        : typeof args.command === "string"
        ? truncate(args.command, 50)
        : "";
    case "Glob":
      return typeof args.pattern === "string" ? args.pattern : "";
    case "Search":
      return typeof args.query === "string"
        ? truncate(args.query, 50)
        : "";
    // web
    case "WebFetch":
      return typeof args.url === "string" ? truncate(args.url, 50) : "";
    // sub-agent
    case "Agent":
      return typeof args.description === "string"
        ? truncate(args.description, 50)
        : typeof args.prompt === "string"
        ? truncate(args.prompt, 50)
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

  const summary = toolSummary(toolCall.name, toolCall.arguments as Record<string, unknown>);

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
        {state === "done" && <IconCheck size={12} className="tool-line-check" />}
        {state === "error" && <span className="tool-line-error">error</span>}
      </div>
      {open && (
        <div className="tool-detail">
          <div className="tool-detail-args">
            {JSON.stringify(toolCall.arguments, null, 2)}
          </div>
          {result && (
            <pre className={`tool-detail-result${result.isError ? " error" : ""}`}>
              {contentText(result.content)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
