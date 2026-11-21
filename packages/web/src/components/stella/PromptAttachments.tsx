import type { PromptFileRef } from "@lumisca/core/shared";
import { withToken } from "../../api-client.ts";
import { useT } from "../../i18n.ts";
import {
  type AttachmentView,
  MessageAttachments,
} from "../chat/MessageAttachments.tsx";

/**
 * The pictures and files a prompt brought in, mapped onto the shared
 * attachment block.
 *
 * The bytes live in the machine, not in the transcript (see PromptFileRef):
 * the pictures are read back through the conversation's upload route, and the
 * cards download by the same route. A file the machine no longer has is an
 * ordinary state: a picture's failed load turns its tile into the sentence
 * that says so, and a card asks the route before it saves.
 */
export function PromptAttachments({
  files,
  /** The conversation's upload endpoint, already carrying the agent. */
  base,
}: {
  files: readonly PromptFileRef[];
  base: string;
}) {
  const t = useT();
  /** One file's URL. `preview` is the downscaled copy the grid draws; the
   * original is what a click opens and what a card downloads. */
  const srcOf = (file: PromptFileRef, preview: boolean) =>
    withToken(
      `${base}?ref=${encodeURIComponent(file.ref)}${preview ? "" : "&preview=0"}`,
    );

  const items: AttachmentView[] = files.map((file) =>
    file.image
      ? {
          key: file.ref,
          kind: "image",
          name: file.name,
          src: srcOf(file, true),
          fullSrc: srcOf(file, false),
        }
      : {
          key: file.ref,
          kind: "file",
          name: file.name,
          size: file.size,
          href: srcOf(file, false),
          downloadName: file.name,
          check: true,
        },
  );

  return (
    <MessageAttachments items={items} missingText={t("chat.stella.fileGone")} />
  );
}
