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
import type { AgentMessage, ToolResultMessage } from "../../types.ts";
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

/** The files one `present` result carries: the entries of `details.files`
 * that name a path, in order. Anything malformed (no details, a non-array
 * `files`, an entry that is not an object or carries no path) is skipped —
 * a result written by another version must not break the cards. */
function filesOfDetails(details: unknown): DeliverableFile[] {
  const files = (details as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(files)) return [];
  const result: DeliverableFile[] = [];
  for (const entry of files) {
    if (!entry || typeof entry !== "object") continue;
    const { path, description } = entry as Record<string, unknown>;
    if (typeof path !== "string" || !path) continue;
    result.push({
      path,
      description: typeof description === "string" ? description : undefined,
    });
  }
  return result;
}

/** The files a turn declared with the `present` tool: every present tool
 * call of the turn's assistant messages, paired with its result by
 * tool-call id (the same pairing the tool timeline uses). Pairing by the
 * call — not by where the result sits in the transcript — keeps the cards
 * with the message that declared them even when the result does not land in
 * the same turn's rows (a steered message that had to start a turn of its
 * own, or a delivery order that put the rows apart). A call whose result
 * never arrived, or arrived as an error, declares nothing. Returns files in
 * order of first declaration, deduplicated by path (the latest description
 * wins). Pure, so a session restored from the database derives the same
 * cards. */
export function deliverablesOf(
  messages: AgentMessage[],
  toolResults: Map<string, ToolResultMessage>,
): DeliverableFile[] {
  const seen = new Map<string, DeliverableFile>();
  const order: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall" || block.name !== TOOL_PRESENT) continue;
      const result = toolResults.get(block.id);
      if (result === undefined || result.isError) continue;
      for (const file of filesOfDetails(result.details)) {
        const existing = seen.get(file.path);
        if (existing) {
          // A later declaration of the same path updates the card in place:
          // the latest description wins, the first position is kept.
          seen.set(file.path, {
            path: file.path,
            description: file.description ?? existing.description,
          });
        } else {
          seen.set(file.path, file);
          order.push(file.path);
        }
      }
    }
  }
  return order.map((path) => seen.get(path)!);
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

/** One turn's deliverables (the present tool), listed at the end of that
 * turn: the files the agent declared for the user while answering it.
 * Renders nothing while the list is empty. */
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
