import { afterAll, test } from "bun:test";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { ApiError, httpError, parseError, promptBody } from "./api-client.ts";
import { putPromptUploadChunk, sha256Hex } from "./prompt-upload.ts";
import type { PendingFile } from "./types.ts";

function pending(overrides: Partial<PendingFile> = {}): PendingFile {
  return {
    id: "p1",
    name: "run.log",
    size: 5,
    file: new File(["hello"], "run.log"),
    status: "done",
    uploaded: 5,
    uploadId: "u1",
    ...overrides,
  };
}

test("promptBody names the upload ids instead of carrying bytes", () => {
  const body = promptBody("このログを見て", undefined, undefined, [
    pending(),
    pending({ id: "p2", name: "b.txt", uploadId: "u2" }),
  ]);
  assertEquals(body.uploads, ["u1", "u2"]);
  assertEquals("files" in body, false);
  assertEquals("data" in body, false);
});

test("promptBody refuses a file whose upload did not finish", () => {
  assertThrows(
    () =>
      promptBody("x", undefined, undefined, [pending({ uploadId: undefined })]),
    Error,
  );
  assertThrows(
    () =>
      promptBody("x", undefined, undefined, [pending({ status: "uploading" })]),
    Error,
  );
});

test("sha256Hex hashes one chunk as lowercase hex", async () => {
  assertEquals(
    await sha256Hex(new TextEncoder().encode("hello")),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

/** A stand-in for the browser's XHR: it holds what `putPromptUploadChunk`
 * configured and answers when the test says so. The chunk upload is the one
 * request that cannot use fetch (it reports `upload.onprogress`), so it reads
 * its own answer — and this is what makes that reading testable. */
class FakeXhr {
  static last: FakeXhr | undefined;
  method = "";
  url = "";
  headers = new Map<string, string>();
  status = 0;
  responseText = "";
  readonly upload: { onprogress?: (event: ProgressEvent) => void } = {};
  onerror?: () => void;
  onabort?: () => void;
  onload?: () => void;
  aborted = false;

  constructor() {
    FakeXhr.last = this;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  send(): void {}

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  /** Answer with `status` and `body`, as the server (or a proxy) did. */
  answer(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

/** Run one chunk upload against a FakeXhr and report how it settled. */
async function chunkAgainst(): Promise<{
  xhr: FakeXhr;
  result: Promise<{ offset: number }>;
}> {
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    "XMLHttpRequest",
  );
  Object.defineProperty(globalThis, "XMLHttpRequest", {
    value: FakeXhr,
    configurable: true,
  });
  const controller = new AbortController();
  const result = putPromptUploadChunk(
    "a1",
    "u1",
    0,
    new TextEncoder().encode("hello"),
    "hash",
    () => {},
    controller.signal,
  );
  const xhr = FakeXhr.last!;
  if (original === undefined) {
    delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  } else {
    Object.defineProperty(globalThis, "XMLHttpRequest", original);
  }
  return { xhr, result };
}

test("the chunk upload classifies its answer exactly as request does", async () => {
  // Two transports, one rule: the XHR cannot use `request` (it needs
  // `upload.onprogress`), so it read its own answer's status and body — and
  // the classification was a second, hand-written copy of request's. They are
  // now the same functions, so the same answer must produce the same error.
  const answers: Array<[status: number, body: string]> = [
    [400, '{"error":"offset mismatch"}'],
    [500, '{"error":"disk full"}'],
    [503, "<html>down</html>"],
    [200, "<html>login</html>"],
  ];
  for (const [status, body] of answers) {
    const { xhr, result } = await chunkAgainst();
    xhr.answer(status, body);
    const error = await result.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert(error instanceof ApiError, `${status}: must fail`);
    // The shared classifiers are the expectation: whatever they say, the
    // upload says — not a second opinion.
    const expected =
      status < 300
        ? parseError(new SyntaxError("x"), status)
        : httpError(status, body);
    assertEquals(error.kind, expected.kind, `${status}: kind`);
    assertEquals(error.status, expected.status, `${status}: status`);
    assertEquals(error.detail, expected.detail, `${status}: detail`);
  }
});

test("the chunk upload keeps the server's sentence for a refused chunk", async () => {
  const { xhr, result } = await chunkAgainst();
  xhr.answer(409, '{"error":"chunk hash does not match"}');
  const error = (await result.catch((cause: unknown) => cause)) as ApiError;
  assertEquals(error.message, "chunk hash does not match");
  assertEquals(error.detail, "chunk hash does not match");
});

test("the chunk upload sends the chunk with the offset and the hash", async () => {
  const { xhr, result } = await chunkAgainst();
  assertEquals(xhr.method, "PUT");
  assertEquals(xhr.url, "/api/stella/conversations/a1/uploads/u1?offset=0");
  assertEquals(xhr.headers.get("content-type"), "application/octet-stream");
  assertEquals(xhr.headers.get("x-chunk-sha256"), "hash");
  xhr.answer(200, '{"offset":5}');
  assertEquals(await result, { offset: 5 });
});

test("httpError reads the server's own explanation out of any body", () => {
  // The upload and the fetch path share this, so what it says is what the
  // reader is shown in both.
  assertEquals(httpError(404, '{"error":"gone"}').message, "gone");
  assertEquals(httpError(404, '{"error":"gone"}').kind, "http-4xx");
  assertEquals(httpError(500, '{"error":"gone"}').kind, "http-5xx");
  // A proxy's HTML page is not the server's sentence: the status speaks.
  assertEquals(
    httpError(502, "<html>down</html>").message,
    "Request failed: 502",
  );
  assertEquals(httpError(502, "<html>down</html>").detail, null);
  // A `{ error }` that is not a string is not a sentence either.
  assertEquals(httpError(400, '{"error":{"code":1}}').detail, null);
});

afterAll(() => {
  FakeXhr.last = undefined;
});
