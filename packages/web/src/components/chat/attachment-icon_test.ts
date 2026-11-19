import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  IconArchive,
  IconFileCode,
  IconFileTypePdf,
  IconFileTypePng,
  IconFileUnknown,
  IconJson,
  IconMarkdown,
} from "@tabler/icons-preact";
import { attachmentIcon } from "./attachment-icon.ts";

test("attachmentIcon: the extension picks Tabler's own file type", () => {
  assertEquals(attachmentIcon("report.pdf"), IconFileTypePdf);
  assertEquals(attachmentIcon("REPORT.PDF"), IconFileTypePdf);
  assertEquals(attachmentIcon("shot.png"), IconFileTypePng);
});

test("attachmentIcon: the last extension wins", () => {
  assertEquals(attachmentIcon("bundle.tar.gz"), IconArchive);
});

test("attachmentIcon: the formats outside the FileType family", () => {
  assertEquals(attachmentIcon("README.md"), IconMarkdown);
  assertEquals(attachmentIcon("package.json"), IconJson);
  assertEquals(attachmentIcon("main.py"), IconFileCode);
});

test("attachmentIcon: a name without a usable extension is unknown", () => {
  assertEquals(attachmentIcon("README"), IconFileUnknown);
  assertEquals(attachmentIcon(".gitignore"), IconFileUnknown);
  assertEquals(attachmentIcon("trailing."), IconFileUnknown);
  assertEquals(attachmentIcon("archive.unknown"), IconFileUnknown);
});
