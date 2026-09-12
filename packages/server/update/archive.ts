/**
 * Extraction of release packages, with nothing but web APIs.
 *
 * A server package is the compiled binary plus the assets it serves
 * (`assets.json`, and `icudtl.dat` on Windows), packed by the release
 * workflow: a zip on Windows, a tar.gz elsewhere. Both containers are read
 * here — zip by walking the central directory and inflating entries through
 * `DecompressionStream("deflate-raw")`, tar.gz by decompressing and
 * streaming through `@std/tar` — so the updater needs neither a native
 * dependency nor a shell (`unzip` / `tar`) to be present on the machine.
 *
 * Extraction is deliberately strict: a package is flat (`<dir>/<file>` at
 * most), and anything else (a nested path, a symlink, a package that does
 * not exist) fails loudly instead of writing an unexpected file next to the
 * server. The archive is signature-verified before it gets here, so this is
 * defense in depth rather than the trust boundary.
 */
import { type TarStreamEntry, UntarStream } from "@std/tar/untar-stream";
import type { ArchiveFormat } from "./release.ts";

/** The container formats this module can read (the release layout owns
 * which platform gets which). Re-exported so callers that only extract do
 * not have to reach into the release module. */
export type { ArchiveFormat };

/** An archive that cannot be installed (broken container, unsupported
 * layout, or an entry that is not a plain file). */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/** A byte buffer backed by a plain `ArrayBuffer`: the stream and WebCrypto
 * types reject the `ArrayBufferLike`-backed flavor (shared or resizable
 * buffers), which is what the typed-array view methods hand back. */
type Bytes = Uint8Array<ArrayBuffer>;

/** Longest tail searched for the zip end-of-central-directory record
 * (22-byte record plus the 64 KiB comment field it can carry). */
const ZIP_EOCD_SEARCH_BYTES = 22 + 65_535;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
/** Methods worth supporting: stored and deflate (what PowerShell's
 * Compress-Archive, 7-Zip and Info-ZIP all emit). */
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;
/** Refuse entries larger than this (4 GiB): a server package is ~400 MB, so
 * anything bigger is a broken archive, not a real one. */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * The file name a package entry maps to, or undefined when the entry is not
 * a plain top-level file.
 *
 * Packages carry a single top-level directory (`lumisca-server-<v>-<platform>/`)
 * with flat files inside, so both forms are accepted: `dir/file` and `file`.
 * Everything else — absolute paths, `..`, drive letters, nested directories,
 * names with separators or leading dots — is rejected.
 */
export function packageEntryName(path: string): string | undefined {
  if (path.includes("\\") || path.includes("\0")) return undefined;
  // A trailing separator names a directory, which is never a file to write.
  if (path.endsWith("/")) return undefined;
  const components = path.split("/").filter((part) =>
    part !== "" && part !== "."
  );
  if (components.length === 0 || components.length > 2) return undefined;
  if (components.some((part) => part === "..")) return undefined;
  if (components[0]!.endsWith(":")) return undefined;
  const name = components[components.length - 1]!;
  // A conservative name space: the release ships `lumisca-server(.exe)`,
  // `assets.json` and `icudtl.dat`, and a future addition that does not fit
  // fails here instead of landing somewhere unplanned.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined;
  return name;
}

/** Read exactly `length` bytes at `offset`, or throw (a short read means
 * the archive was truncated). */
async function readAt(
  file: Deno.FsFile,
  offset: number,
  length: number,
): Promise<Bytes> {
  if (length < 0) throw new ArchiveError("アーカイブのオフセットが不正です");
  const buffer = new Uint8Array(length);
  await file.seek(offset, Deno.SeekMode.Start);
  let filled = 0;
  while (filled < length) {
    const read = await file.read(buffer.subarray(filled));
    if (read === null) {
      throw new ArchiveError("アーカイブが途中で終わっています");
    }
    filled += read;
  }
  return buffer;
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    written += await file.write(bytes.subarray(written));
  }
}

/** Write a stream to a file, returning the number of bytes written. */
async function writeStream(
  stream: ReadableStream<Uint8Array>,
  path: string,
  mode?: number,
): Promise<number> {
  const file = await Deno.open(path, {
    create: true,
    write: true,
    truncate: true,
    ...(mode === undefined ? {} : { mode }),
  });
  let written = 0;
  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writeAll(file, value);
      written += value.length;
    }
  } finally {
    file.close();
  }
  return written;
}

/** A single file of a package archive. */
interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  dataOffset: number;
}

/** Parse the central directory of a zip file (the authoritative record:
 * entries written with a data descriptor carry zero sizes in their local
 * header). */
async function readZipEntries(file: Deno.FsFile): Promise<ZipEntry[]> {
  const { size } = await file.stat();
  if (size < 22) throw new ArchiveError("ZIP アーカイブが小さすぎます");

  const tailLength = Math.min(size, ZIP_EOCD_SEARCH_BYTES);
  const tail = await readAt(file, size - tailLength, tailLength);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === ZIP_EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError("ZIP の終端レコードが見つかりません");

  const entryCount = tailView.getUint16(eocd + 10, true);
  const centralSize = tailView.getUint32(eocd + 12, true);
  const centralOffset = tailView.getUint32(eocd + 16, true);
  if (
    entryCount === 0xffff || centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new ArchiveError("ZIP64 形式のアーカイブには対応していません");
  }
  const central = await readAt(file, centralOffset, centralSize);
  const view = new DataView(
    central.buffer,
    central.byteOffset,
    central.byteLength,
  );

  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > central.length) {
      throw new ArchiveError("ZIP のセントラルディレクトリが壊れています");
    }
    if (view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new ArchiveError("ZIP のセントラルディレクトリが壊れています");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const rawName = new TextDecoder().decode(
      central.subarray(offset + 46, offset + 46 + nameLength),
    );
    offset += 46 + nameLength + extraLength + commentLength;

    // Directory entries end in "/"; they carry no payload.
    if (rawName.endsWith("/")) continue;
    if (
      compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new ArchiveError("ZIP64 形式のアーカイブには対応していません");
    }
    if (method !== ZIP_METHOD_STORED && method !== ZIP_METHOD_DEFLATE) {
      throw new ArchiveError(
        `未対応の圧縮方式です (method ${method}): ${rawName}`,
      );
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new ArchiveError(`エントリが大きすぎます: ${rawName}`);
    }
    const name = packageEntryName(rawName);
    if (name === undefined) {
      throw new ArchiveError(`アーカイブに想定外のパスがあります: ${rawName}`);
    }
    if (entries.some((entry) => entry.name === name)) {
      throw new ArchiveError(`アーカイブに同名のファイルがあります: ${name}`);
    }
    if (localOffset + 30 > size) {
      throw new ArchiveError(`ローカルヘッダが範囲外です: ${rawName}`);
    }
    const local = await readAt(file, localOffset, 30);
    const localView = new DataView(
      local.buffer,
      local.byteOffset,
      local.byteLength,
    );
    if (localView.getUint32(0, true) !== ZIP_LOCAL_SIGNATURE) {
      throw new ArchiveError(`ローカルヘッダが壊れています: ${rawName}`);
    }
    const dataOffset = localOffset + 30 +
      localView.getUint16(26, true) + localView.getUint16(28, true);
    if (dataOffset + compressedSize > size) {
      throw new ArchiveError(`データが範囲外です: ${rawName}`);
    }
    entries.push({
      name,
      method,
      compressedSize,
      size: uncompressedSize,
      dataOffset,
    });
  }
  return entries;
}

async function extractZip(
  archivePath: string,
  targetDir: string,
): Promise<string[]> {
  const file = await Deno.open(archivePath, { read: true });
  try {
    const entries = await readZipEntries(file);
    const written: string[] = [];
    for (const entry of entries) {
      // One entry at a time: the largest (the server binary) is ~100 MB
      // compressed, which stays well below the archive's own size.
      const compressed = await readAt(
        file,
        entry.dataOffset,
        entry.compressedSize,
      );
      const target = `${targetDir}/${entry.name}`;
      if (entry.method === ZIP_METHOD_STORED) {
        if (compressed.length !== entry.size) {
          throw new ArchiveError(`展開サイズが一致しません: ${entry.name}`);
        }
        const out = await Deno.open(target, {
          create: true,
          write: true,
          truncate: true,
        });
        try {
          await writeAll(out, compressed);
        } finally {
          out.close();
        }
      } else {
        const stream = new ReadableStream<Bytes>({
          start(controller) {
            controller.enqueue(compressed);
            controller.close();
          },
        }).pipeThrough(new DecompressionStream("deflate-raw"));
        const size = await writeStream(stream, target);
        if (size !== entry.size) {
          throw new ArchiveError(`展開サイズが一致しません: ${entry.name}`);
        }
      }
      written.push(entry.name);
    }
    return written;
  } finally {
    file.close();
  }
}

/** Typeflags that carry only metadata for the next entry (PAX headers,
 * which GNU tar's pax format and bsdtar's restricted mode emit for
 * timestamps / extended attributes). They are skipped: this reader takes
 * nothing from them, and `assertNoRenameRecord` refuses the one case where
 * ignoring them would be wrong (a long path recorded in a PAX header, where
 * the following entry's own name is truncated). */
const METADATA_TYPEFLAGS = new Set(["x", "g"]);
/** Typeflags whose *content* is a name (GNU long name / long link name):
 * ignoring them would silently install a truncated name. */
const LONG_NAME_TYPEFLAGS = new Set(["L", "K"]);

/** Read a metadata entry and refuse it when it renames the next entry. */
async function assertMetadataOnly(
  entry: TarStreamEntry,
  read: ReadableStream<Uint8Array>,
): Promise<void> {
  const text = await new Response(read).text();
  for (const line of text.split("\n")) {
    // PAX records look like "<length> <key>=<value>".
    const record = /^\d+ ([A-Za-z0-9._-]+)=/.exec(line);
    if (record !== null && (record[1] === "path" || record[1] === "linkpath")) {
      throw new ArchiveError(
        `アーカイブが長いパス名を使っており未対応です (${entry.path})`,
      );
    }
  }
}

async function extractTarGz(
  archivePath: string,
  targetDir: string,
): Promise<string[]> {
  const file = await Deno.open(archivePath, { read: true });
  const written: string[] = [];
  try {
    const entries = file.readable
      .pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(new UntarStream());
    for await (const entry of entries) {
      const typeflag = entry.header.typeflag;
      // Directories carry no payload; the package layout is flat.
      if (typeflag === "5") continue;
      if (METADATA_TYPEFLAGS.has(typeflag)) {
        if (entry.readable === undefined) continue;
        await assertMetadataOnly(entry, entry.readable);
        continue;
      }
      if (typeflag !== "0") {
        const label = LONG_NAME_TYPEFLAGS.has(typeflag)
          ? "長いパス名"
          : `type ${typeflag}`;
        throw new ArchiveError(
          `アーカイブに未対応のエントリがあります (${label}): ${entry.path}`,
        );
      }
      if (entry.readable === undefined) {
        throw new ArchiveError(`エントリの内容を読めません: ${entry.path}`);
      }
      const name = packageEntryName(entry.path);
      if (name === undefined) {
        throw new ArchiveError(
          `アーカイブに想定外のパスがあります: ${entry.path}`,
        );
      }
      if (written.includes(name)) {
        throw new ArchiveError(`アーカイブに同名のファイルがあります: ${name}`);
      }
      const mode = entry.header.mode;
      const size = await writeStream(
        entry.readable,
        `${targetDir}/${name}`,
        mode !== undefined && mode > 0 ? mode & 0o777 : undefined,
      );
      if (size > MAX_ENTRY_BYTES) {
        throw new ArchiveError(`エントリが大きすぎます: ${name}`);
      }
      written.push(name);
    }
    return written;
  } finally {
    closeQuietly(file);
  }
}

/** Close a file whose readable stream may have closed the resource already
 * (`file.readable` releases the resource at EOF and on cancel, so the
 * explicit close after a successful extraction is a no-op error rather than
 * a fault). */
function closeQuietly(file: Deno.FsFile): void {
  try {
    file.close();
  } catch {
    // Already released by the stream that consumed it.
  }
}

/**
 * Extract a release archive into `targetDir` (which must already exist) and
 * return the file names written, in archive order.
 */
export function extractArchive(
  archivePath: string,
  format: ArchiveFormat,
  targetDir: string,
): Promise<string[]> {
  return format === "zip"
    ? extractZip(archivePath, targetDir)
    : extractTarGz(archivePath, targetDir);
}
