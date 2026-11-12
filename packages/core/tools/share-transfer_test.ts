import { assertEquals, assertRejects } from "@std/assert";
import { base64ToBytes, bytesToBase64 } from "../base64.ts";
import { MountedFiles } from "../share/mounted-files.ts";
import type {
  ShareCall,
  ShareOpMap,
  ShareOpName,
  ShareTransport,
} from "../share/ops.ts";
import { grantOf } from "../share/test-utils.ts";
import { toolText } from "../test-utils.ts";
import type {
  BackendDirEntry,
  BackendStat,
  FileBackend,
  LineRange,
  RangeReadResult,
} from "./file-backend.ts";
import {
  createShareDownloadTool,
  createShareUploadTool,
  MAX_TRANSFER_BYTES,
  TRANSFER_CHUNK_BYTES,
} from "./share-transfer.ts";

/** The machine's own files, as bytes: the tools' only source and destination
 * on this side of the loan. */
class ByteBackend implements FileBackend {
  readonly roots = ["/home/agent"];
  readonly files = new Map<string, Uint8Array>();
  readonly sizes = new Map<string, number>();
  readonly calls: string[] = [];

  resolve(
    requested: string,
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    if (!requested.startsWith("/")) {
      return Promise.resolve({ ok: false, reason: "Path must be absolute" });
    }
    const inside = this.roots.some(
      (root) => requested === root || requested.startsWith(`${root}/`),
    );
    return Promise.resolve(
      inside
        ? { ok: true, path: requested }
        : { ok: false, reason: `Path is outside the machine: ${requested}` },
    );
  }

  stat(path: string): Promise<BackendStat | undefined> {
    const bytes = this.files.get(path);
    if (bytes === undefined && !this.sizes.has(path)) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      isFile: true,
      size: this.sizes.get(path) ?? bytes?.length ?? 0,
    });
  }

  readBytes(path: string, offset: number, length: number): Promise<Uint8Array> {
    this.calls.push(`readBytes ${path} ${offset} ${length}`);
    return Promise.resolve(
      (this.files.get(path) ?? new Uint8Array(0)).slice(
        offset,
        offset + length,
      ),
    );
  }

  writeBytes(
    path: string,
    bytes: Uint8Array,
    options: { private?: boolean; append?: boolean } = {},
  ): Promise<void> {
    this.calls.push(`writeBytes ${path} ${options.append === true}`);
    const before =
      options.append === true
        ? (this.files.get(path) ?? new Uint8Array(0))
        : new Uint8Array(0);
    const joined = new Uint8Array(before.length + bytes.length);
    joined.set(before);
    joined.set(bytes, before.length);
    this.files.set(path, joined);
    return Promise.resolve();
  }

  writeText(): Promise<void> {
    throw new Error("not used by these tools");
  }

  readText(): Promise<string> {
    throw new Error("not used by these tools");
  }

  readHead(): Promise<{ bytes: Uint8Array; size: number }> {
    throw new Error("not used by these tools");
  }

  readRanges(
    _path: string,
    _ranges: readonly LineRange[],
  ): Promise<RangeReadResult> {
    throw new Error("not used by these tools");
  }

  removeFile(): Promise<void> {
    throw new Error("not used by these tools");
  }

  listDir(): Promise<BackendDirEntry[]> {
    throw new Error("not used by these tools");
  }
}

/** The lent computer's answers, recorded so the test can read the wire. */
class RecordingHost implements ShareTransport {
  readonly calls: ShareCall[] = [];
  readonly files = new Map<string, Uint8Array>();

  async call<K extends ShareOpName>(
    _grantId: string,
    op: K,
    request: ShareOpMap[K]["req"],
  ): Promise<ShareOpMap[K]["res"]> {
    const call = { op, ...request } as ShareCall;
    this.calls.push(call);
    switch (call.op) {
      case "stat": {
        const bytes = this.files.get(call.path.join("/"));
        return (
          bytes === undefined ? null : { isFile: true, size: bytes.length }
        ) as ShareOpMap[K]["res"];
      }
      case "readBytes": {
        const bytes = this.files.get(call.path.join("/")) ?? new Uint8Array(0);
        return {
          base64: bytesToBase64(
            bytes.slice(call.offset, call.offset + call.length),
          ),
        } as ShareOpMap[K]["res"];
      }
      case "writeBytes": {
        const key = call.path.join("/");
        const before = call.append
          ? (this.files.get(key) ?? new Uint8Array(0))
          : new Uint8Array(0);
        const chunk = base64ToBytes(call.base64);
        const joined = new Uint8Array(before.length + chunk.length);
        joined.set(before);
        joined.set(chunk, before.length);
        this.files.set(key, joined);
        return null as ShareOpMap[K]["res"];
      }
      default:
        throw new Error(`unexpected operation ${call.op}`);
    }
  }
}

function fixture() {
  const primary = new ByteBackend();
  const host = new RecordingHost();
  const files = new MountedFiles(primary, host, () => [grantOf()]);
  return { primary, host, files };
}

Deno.test("share_upload moves a file into the lent folder, chunk by chunk", async () => {
  const { primary, host, files } = fixture();
  const bytes = new Uint8Array(TRANSFER_CHUNK_BYTES + 5);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  primary.files.set("/home/agent/shot.png", bytes);

  const result = await createShareUploadTool(files).execute("id", {
    path: "/home/agent/shot.png",
    to: "/lend/proj/shot.png",
  });

  const writes = host.calls.filter((call) => call.op === "writeBytes");
  assertEquals(writes.length, 2);
  assertWrites(writes);
  const written = host.files.get("shot.png")!;
  assertEquals(written.length, bytes.length);
  assertEquals([...written], [...bytes]);
  assertEquals(
    toolText(result),
    "Copied /home/agent/shot.png to /lend/proj/shot.png (1.0 MB)",
  );
});

function assertWrites(writes: readonly ShareCall[]): void {
  // The first chunk truncates (a shorter file must not keep an old tail);
  // the rest append to what the first wrote.
  const flags = writes.map((call) => call.op === "writeBytes" && call.append);
  assertEquals(flags, [false, true]);
}

Deno.test("share_download moves a file out of the lent folder", async () => {
  const { primary, host, files } = fixture();
  const bytes = new TextEncoder().encode("a zip's bytes\n");
  host.files.set("bundle.zip", bytes);

  const result = await createShareDownloadTool(files).execute("id", {
    path: "/lend/proj/bundle.zip",
    to: "/home/agent/bundle.zip",
  });

  assertEquals([...primary.files.get("/home/agent/bundle.zip")!], [...bytes]);
  assertEquals(host.calls.filter((call) => call.op === "readBytes").length, 1);
  assertEquals(host.calls.filter((call) => call.op === "writeBytes").length, 0);
  assertEquals(
    toolText(result),
    "Copied /lend/proj/bundle.zip to /home/agent/bundle.zip (14 bytes)",
  );
});

Deno.test("share_upload creates an empty file as an empty file", async () => {
  const { primary, host, files } = fixture();
  primary.files.set("/home/agent/empty.txt", new Uint8Array(0));

  await createShareUploadTool(files).execute("id", {
    path: "/home/agent/empty.txt",
    to: "/lend/proj/empty.txt",
  });

  assertEquals(host.files.get("empty.txt")!.length, 0);
  assertEquals(host.calls.filter((call) => call.op === "readBytes").length, 0);
});

Deno.test("the tools refuse a copy that would not cross the loan", async () => {
  const { primary, files } = fixture();
  primary.files.set("/home/agent/a.txt", new TextEncoder().encode("a"));
  const upload = createShareUploadTool(files);
  const download = createShareDownloadTool(files);

  await assertRejects(
    () =>
      upload.execute("id", {
        path: "/home/agent/a.txt",
        to: "/home/agent/b.txt",
      }),
    Error,
    "share_download",
  );
  await assertRejects(
    () =>
      download.execute("id", {
        path: "/home/agent/a.txt",
        to: "/home/agent/b.txt",
      }),
    Error,
    "/lend",
  );
  // The reverse of each tool's direction is the other tool.
  await assertRejects(
    () =>
      upload.execute("id", {
        path: "/lend/proj/a.txt",
        to: "/home/agent/b.txt",
      }),
    Error,
    "share_download",
  );
});

Deno.test("a file over the transfer limit is refused before any byte moves", async () => {
  const { primary, host, files } = fixture();
  primary.sizes.set("/home/agent/huge.bin", MAX_TRANSFER_BYTES + 1);

  await assertRejects(
    () =>
      createShareUploadTool(files).execute("id", {
        path: "/home/agent/huge.bin",
        to: "/lend/proj/huge.bin",
      }),
    Error,
    "at most 64.0 MB",
  );
  assertEquals(host.calls.length, 0);
});

Deno.test("a missing source is reported as missing, not as a failed write", async () => {
  const { host, files } = fixture();
  await assertRejects(
    () =>
      createShareDownloadTool(files).execute("id", {
        path: "/lend/proj/missing.bin",
        to: "/home/agent/missing.bin",
      }),
    Error,
    "Path does not exist",
  );
  assertEquals(host.calls.filter((call) => call.op === "writeBytes").length, 0);
});
