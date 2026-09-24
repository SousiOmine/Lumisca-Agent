import { useState } from "preact/compat";
import {
  type Icon,
  IconArchive,
  IconBrandPython,
  IconCheck,
  IconClipboard,
  IconCode,
  IconFile,
  IconFileCheck,
  IconFileTypeBmp,
  IconFileTypeCss,
  IconFileTypeCsv,
  IconFileTypeDoc,
  IconFileTypeDocx,
  IconFileTypeHtml,
  IconFileTypeJpg,
  IconFileTypeJs,
  IconFileTypeJsx,
  IconFileTypePdf,
  IconFileTypePhp,
  IconFileTypePng,
  IconFileTypePpt,
  IconFileTypeRs,
  IconFileTypeSql,
  IconFileTypeSvg,
  IconFileTypeTs,
  IconFileTypeTsx,
  IconFileTypeTxt,
  IconFileTypeVue,
  IconFileTypeXls,
  IconFileTypeXml,
  IconFileTypeZip,
  IconMarkdown,
  IconMusic,
  IconPhoto,
  IconVideo,
} from "@tabler/icons-preact";
import { type MessageKey, TOOL_PRESENT } from "@lumisca/core/shared";
import type { AgentMessage } from "../../types.ts";
import { useT } from "../../i18n.ts";

/** A single deliverable file entry extracted from a successful `present`
 * tool call. */
export interface DeliverableFile {
  path: string;
  description?: string;
}

/** The kind a deliverable belongs to, for the card's icon and type line. */
export type FileKind =
  | "document"
  | "spreadsheet"
  | "presentation"
  | "image"
  | "code"
  | "archive"
  | "audio"
  | "video";

/** What one card displays: the path split into name and extension, plus the
 * icon and the kind label the extension resolves to. */
export interface FileVisual {
  icon: Icon;
  /** Absent for an extension the app does not classify; the card then shows
   * the bare extension. */
  kind?: FileKind;
  /** Uppercased extension without the dot; "" when the name carries none. */
  extension: string;
  /** The last path segment. */
  name: string;
}

/** Icon of an extension that has one of its own, so a PDF looks like a PDF.
 * Everything else falls to the icon of its kind (KIND_ICON). */
const EXTENSION_ICON: Record<string, Icon> = {
  pdf: IconFileTypePdf,
  doc: IconFileTypeDoc,
  docx: IconFileTypeDocx,
  txt: IconFileTypeTxt,
  md: IconMarkdown,
  markdown: IconMarkdown,
  csv: IconFileTypeCsv,
  xls: IconFileTypeXls,
  xlsx: IconFileTypeXls,
  ppt: IconFileTypePpt,
  pptx: IconFileTypePpt,
  png: IconFileTypePng,
  jpg: IconFileTypeJpg,
  jpeg: IconFileTypeJpg,
  bmp: IconFileTypeBmp,
  svg: IconFileTypeSvg,
  zip: IconFileTypeZip,
  ts: IconFileTypeTs,
  tsx: IconFileTypeTsx,
  js: IconFileTypeJs,
  jsx: IconFileTypeJsx,
  rs: IconFileTypeRs,
  html: IconFileTypeHtml,
  css: IconFileTypeCss,
  php: IconFileTypePhp,
  sql: IconFileTypeSql,
  vue: IconFileTypeVue,
  xml: IconFileTypeXml,
  py: IconBrandPython,
};

/** The kind of each extension the app knows: the type line's first half,
 * and the icon of every extension that has no icon of its own. An extension
 * missing here is shown as a plain file with just its extension. */
const EXTENSION_KIND: Record<string, FileKind> = {
  // document
  pdf: "document",
  doc: "document",
  docx: "document",
  txt: "document",
  md: "document",
  markdown: "document",
  rtf: "document",
  odt: "document",
  // spreadsheet
  csv: "spreadsheet",
  tsv: "spreadsheet",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  ods: "spreadsheet",
  // presentation
  ppt: "presentation",
  pptx: "presentation",
  odp: "presentation",
  key: "presentation",
  // image
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  ico: "image",
  avif: "image",
  tiff: "image",
  // code
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  py: "code",
  rb: "code",
  go: "code",
  rs: "code",
  java: "code",
  kt: "code",
  c: "code",
  h: "code",
  cc: "code",
  cpp: "code",
  hpp: "code",
  cs: "code",
  php: "code",
  sql: "code",
  vue: "code",
  svelte: "code",
  html: "code",
  css: "code",
  scss: "code",
  less: "code",
  xml: "code",
  json: "code",
  yaml: "code",
  yml: "code",
  toml: "code",
  ini: "code",
  sh: "code",
  bash: "code",
  ps1: "code",
  bat: "code",
  lua: "code",
  swift: "code",
  dart: "code",
  r: "code",
  tex: "code",
  // archive
  zip: "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  "7z": "archive",
  rar: "archive",
  // audio
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  flac: "audio",
  m4a: "audio",
  aac: "audio",
  // video
  mp4: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  avi: "video",
};

/** Icon of a kind: what an extension without an icon of its own shows. */
const KIND_ICON: Record<FileKind, Icon> = {
  document: IconFileTypeTxt,
  spreadsheet: IconFileTypeXls,
  presentation: IconFileTypePpt,
  image: IconPhoto,
  code: IconCode,
  archive: IconArchive,
  audio: IconMusic,
  video: IconVideo,
};

/** Catalogue key of a kind's label (the type line's first half). */
const KIND_LABEL: Record<FileKind, MessageKey> = {
  document: "chat.deliverables.kind.document",
  spreadsheet: "chat.deliverables.kind.spreadsheet",
  presentation: "chat.deliverables.kind.presentation",
  image: "chat.deliverables.kind.image",
  code: "chat.deliverables.kind.code",
  archive: "chat.deliverables.kind.archive",
  audio: "chat.deliverables.kind.audio",
  video: "chat.deliverables.kind.video",
};

/** Read a workspace path as what the card shows. Classification is by
 * extension; a name without one (or with an unknown one) is still a valid
 * deliverable — it renders as a generic file with no kind label. */
export function fileVisual(path: string): FileVisual {
  const normalized = path.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const kind = EXTENSION_KIND[extension];
  return {
    icon: EXTENSION_ICON[extension] ?? (kind ? KIND_ICON[kind] : IconFile),
    kind,
    extension: extension.toUpperCase(),
    name,
  };
}

/** The card's type line: the kind label and the extension, separated by a
 * middle dot. An unclassified extension has no label, so it shows alone; a
 * name with neither shows nothing and the card drops the line. */
export function typeLine(
  kindLabel: string | undefined,
  extension: string,
): string {
  return kindLabel === undefined ? extension : `${kindLabel} · ${extension}`;
}

/** Scan the transcript for successful `present` tool-result messages and
 * extract the file list from each. Returns files in order of first
 * declaration, deduplicated by path (the latest description wins). Pure, so
 * a session restored from the database derives the same list. */
export function deliverablesOf(
  messages: AgentMessage[],
): DeliverableFile[] {
  const seen = new Map<string, { file: DeliverableFile; order: number }>();
  let order = 0;
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (msg.toolName !== TOOL_PRESENT) continue;
    if (msg.isError) continue;
    const details = msg.details as Record<string, unknown> | undefined;
    if (!details) continue;
    const files = details.files;
    if (!Array.isArray(files)) continue;
    for (const entry of files) {
      if (!entry || typeof entry !== "object") continue;
      const { path, description } = entry as Record<string, unknown>;
      if (typeof path !== "string" || !path) continue;
      const existing = seen.get(path);
      if (existing) {
        existing.file = {
          path,
          description: typeof description === "string"
            ? description
            : existing.file.description,
        };
      } else {
        seen.set(path, {
          file: {
            path,
            description: typeof description === "string"
              ? description
              : undefined,
          },
          order: order++,
        });
      }
    }
  }
  return [...seen.values()]
    .sort((a, b) => a.order - b.order)
    .map((v) => v.file);
}

/** One deliverable: a file card with its type, its name, the description the
 * agent gave it, and the copy-path action. */
function DeliverableCard({ file }: { file: DeliverableFile }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const visual = fileVisual(file.path);
  const FileIcon = visual.icon;
  const kind = visual.kind === undefined
    ? undefined
    : t(KIND_LABEL[visual.kind]);
  const meta = typeLine(kind, visual.extension);

  /** Copy the file's full workspace path, flashing the button while the
   * clipboard holds it. */
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable — silent fail
    }
  };

  return (
    <li className="deliverable">
      <span className="deliverable-icon" aria-hidden="true">
        <FileIcon size={18} />
      </span>
      <span className="deliverable-body">
        <span className="deliverable-name" title={file.path}>
          {visual.name}
        </span>
        {meta !== "" && <span className="deliverable-meta">{meta}</span>}
        {file.description !== undefined && (
          <span className="deliverable-desc">{file.description}</span>
        )}
      </span>
      <button
        type="button"
        className="deliverable-copy"
        title={copied
          ? t("chat.deliverables.copied")
          : t("chat.deliverables.copyPath", { path: file.path })}
        aria-label={t("chat.deliverables.copyPath", { path: file.path })}
        onClick={copy}
      >
        {copied
          ? <IconCheck size={14} className="deliverable-copied" />
          : <IconClipboard size={14} />}
      </button>
    </li>
  );
}

/** The session's deliverables (the present tool), listed under the
 * conversation: the files the agent declared for the user. Renders nothing
 * while the list is empty. */
export function Deliverables(
  { deliverables }: { deliverables: DeliverableFile[] },
) {
  const t = useT();
  if (deliverables.length === 0) return null;
  const title = t("chat.deliverables.title");
  return (
    <section className="deliverables" aria-label={title}>
      <div className="deliverables-head">
        <IconFileCheck size={13} />
        <span className="deliverables-title">{title}</span>
      </div>
      <ul className="deliverables-list">
        {deliverables.map((file) => (
          <DeliverableCard key={file.path} file={file} />
        ))}
      </ul>
    </section>
  );
}
