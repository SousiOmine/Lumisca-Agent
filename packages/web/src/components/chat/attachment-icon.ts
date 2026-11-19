/**
 * The icon that names a file's kind, chosen from the name's last extension.
 *
 * Tabler's `IconFileType*` family draws the extension into the icon itself
 * (PDF, DOCX, ZIP), which is what a file card needs: the name already ends in
 * the extension, and a second line saying it again would be a label beside a
 * label. The table also covers the formats Tabler names outside that family
 * (Markdown, JSON, TOML) and the broad families that have one honest icon
 * (archives, audio, video, code, databases, logs).
 *
 * An extension outside the table gets `IconFileUnknown`. The fallback is
 * deliberate: a wrong picture (a ZIP icon on a RAR, a document icon on an
 * executable) would say something untrue about the file, while a generic
 * sheet says only what the client knows.
 */
import {
  IconArchive,
  IconFileCode,
  IconFileDatabase,
  IconFileText,
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
  IconFileUnknown,
  IconJson,
  IconMarkdown,
  IconMovie,
  IconMusic,
  IconToml,
} from "@tabler/icons-preact";

/** Every Tabler icon is the same component type; naming it once keeps the
 * table below readable and makes a wrong entry a type error. */
type FileIcon = typeof IconFileUnknown;

const ICON_BY_EXTENSION: Readonly<Record<string, FileIcon>> = {
  // Tabler's IconFileType family.
  bmp: IconFileTypeBmp,
  css: IconFileTypeCss,
  csv: IconFileTypeCsv,
  doc: IconFileTypeDoc,
  docx: IconFileTypeDocx,
  htm: IconFileTypeHtml,
  html: IconFileTypeHtml,
  jpeg: IconFileTypeJpg,
  jpg: IconFileTypeJpg,
  cjs: IconFileTypeJs,
  js: IconFileTypeJs,
  mjs: IconFileTypeJs,
  jsx: IconFileTypeJsx,
  pdf: IconFileTypePdf,
  php: IconFileTypePhp,
  png: IconFileTypePng,
  ppt: IconFileTypePpt,
  pptx: IconFileTypePpt,
  rs: IconFileTypeRs,
  sql: IconFileTypeSql,
  svg: IconFileTypeSvg,
  cts: IconFileTypeTs,
  mts: IconFileTypeTs,
  ts: IconFileTypeTs,
  tsx: IconFileTypeTsx,
  txt: IconFileTypeTxt,
  vue: IconFileTypeVue,
  xls: IconFileTypeXls,
  xlsx: IconFileTypeXls,
  xml: IconFileTypeXml,
  zip: IconFileTypeZip,
  // Formats Tabler draws with their own icon outside the FileType family.
  json: IconJson,
  markdown: IconMarkdown,
  md: IconMarkdown,
  toml: IconToml,
  // Families with one honest picture.
  "7z": IconArchive,
  bz2: IconArchive,
  gz: IconArchive,
  rar: IconArchive,
  tar: IconArchive,
  tgz: IconArchive,
  xz: IconArchive,
  bash: IconFileCode,
  go: IconFileCode,
  ini: IconFileCode,
  java: IconFileCode,
  py: IconFileCode,
  rb: IconFileCode,
  sh: IconFileCode,
  yaml: IconFileCode,
  yml: IconFileCode,
  zsh: IconFileCode,
  db: IconFileDatabase,
  sqlite: IconFileDatabase,
  sqlite3: IconFileDatabase,
  log: IconFileText,
  text: IconFileText,
  flac: IconMusic,
  m4a: IconMusic,
  mp3: IconMusic,
  ogg: IconMusic,
  wav: IconMusic,
  mkv: IconMovie,
  mov: IconMovie,
  mp4: IconMovie,
  webm: IconMovie,
};

/** The icon for a file name. A dotfile or an extensionless name is unknown. */
export function attachmentIcon(name: string): FileIcon {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return IconFileUnknown;
  return (
    ICON_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? IconFileUnknown
  );
}
