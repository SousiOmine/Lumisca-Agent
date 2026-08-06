/** Windows code page number -> WHATWG TextDecoder label. */
const OEM_CP_TO_LABEL: Record<number, string> = {
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  866: "ibm866",
};

let oemLabelCache: string | null | undefined;

/**
 * Detect the Windows OEM code page (as a TextDecoder label) by running
 * `chcp`. cmd.exe's internal commands emit output in this code page, not
 * UTF-8. Returns null when detection fails or the code page has no
 * TextDecoder label.
 */
export async function detectOemLabel(): Promise<string | null> {
  if (Deno.build.os !== "windows") return null;
  if (oemLabelCache !== undefined) return oemLabelCache;
  try {
    const { stdout } = await new Deno.Command("cmd.exe", {
      args: ["/d", "/c", "chcp"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(stdout);
    const cp = Number(text.match(/(\d+)/)?.[1]);
    oemLabelCache = OEM_CP_TO_LABEL[cp] ?? null;
  } catch {
    oemLabelCache = null;
  }
  return oemLabelCache;
}

/**
 * Decode process output. Prefers strict UTF-8 (modern CLI tools emit UTF-8
 * regardless of the system locale); falls back to the OEM code page for
 * bytes that are not valid UTF-8 (typical of cmd.exe internal commands on
 * non-UTF-8 Windows locales).
 */
export function decodeOutput(
  bytes: Uint8Array,
  oemLabel: string | null,
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    if (oemLabel) {
      try {
        return new TextDecoder(oemLabel).decode(bytes);
      } catch {
        // fall through
      }
    }
    return new TextDecoder().decode(bytes);
  }
}
