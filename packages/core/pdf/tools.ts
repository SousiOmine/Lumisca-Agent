/**
 * The PDF page-as-image tool: `pdf_read_pages` renders specified pages of
 * a workspace PDF to PNG images (vision models see the pixels) and
 * reports the total page count.
 *
 * The tool is never preloaded into the LLM context: the session pool seeds
 * it into the session's tool registry (discoverable via tool_search), the
 * same contract as MCP and browser-lab tools.
 *
 * Rendering is Deno-native: unpdf (PDF.js) rasterizes pages through
 * @napi-rs/canvas — no Python, no poppler/mupdf binaries, no external
 * process. The canvas library loads lazily at render time (FFI), so a host
 * without a matching native binding fails the tool call with a clear
 * error instead of breaking server startup. Skia's ICU data file
 * (`icudtl.dat`) follows the same rule: a packaged server ships it beside
 * the binary (see scripts/build-server.ts), but when it cannot be found the
 * tool refuses to load Skia with a clear error — a missing file makes Skia
 * abort the whole server process with `STATUS_ILLEGAL_INSTRUCTION`, which no
 * try/catch can contain.
 */
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { getDocumentProxy, renderPageAsImage } from "unpdf";
import { errorMessage } from "../errors.ts";
import { bytesToBase64 } from "../base64.ts";
import type { Sandbox } from "../workspace/sandbox.ts";
import { TOOL_PDF_READ_PAGES } from "../shared/mod.ts";
import {
  array,
  integer,
  object,
  optional,
  string,
  type Tool,
} from "../tools/schema.ts";
import { requireResolved } from "../tools/resolve.ts";

/** The tool names of the PDF family. The session pool removes the seeded
 * tools with this list for chat sessions (no workspace folders to resolve
 * against), mirroring the browser-lab detach contract. */
export const PDF_TOOL_NAMES: readonly string[] = [TOOL_PDF_READ_PAGES];

/** One tool call never puts more images into the context than a user
 * message could attach (see MAX_PROMPT_IMAGES). */
export const MAX_PDF_PAGES_PER_CALL = 8;

/** Default render resolution: crisp enough for text/figures, cheap enough
 * for the context (an A4 page is ~1239x1754 px at 150 dpi). */
export const DEFAULT_PDF_DPI = 150;
const MIN_PDF_DPI = 72;
const MAX_PDF_DPI = 300;

/** Largest PDF read into memory: the renderer buffers the whole file, so
 * an explicit cap keeps a huge file from exhausting the server. */
const MAX_PDF_BYTES = 100 * 1024 * 1024;

/** One rendered page: PNG bytes plus pixel dimensions. */
export interface RenderedPdfPage {
  /** 1-based page number, as requested. */
  page: number;
  png: Uint8Array;
  width: number;
  height: number;
}

/** Render result: the total page count plus the requested pages. */
export interface PdfRenderResult {
  totalPages: number;
  pages: RenderedPdfPage[];
}

/** Renders PDF pages. The default implementation is Deno-native (see
 * `createUnpdfRenderer`); tests inject a fake. */
export interface PdfRenderer {
  render(
    pdfPath: string,
    pages: number[],
    dpi: number,
    signal?: AbortSignal,
  ): Promise<PdfRenderResult>;
}

type DocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

/** Reject an aborted/absent render promptly: unpdf takes no signal, so
 * race the render against the caller's abort and let the loser settle
 * harmlessly in the background (cleanup still runs in `finally`). */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined || signal.aborted) {
    return signal?.aborted === true
      ? Promise.reject(new DOMException("Aborted", "AbortError"))
      : work;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The production renderer: unpdf (PDF.js) plus a lazily loaded canvas.
 * Stateless (a fresh document per call), so concurrent tool calls are
 * independent. Encrypted or malformed PDFs surface PDF.js's own errors
 * (PasswordException / InvalidPDFException). On Windows, a missing Skia
 * ICU data file refuses with a clear error before Skia is touched:
 * without it the Windows Skia binary aborts the whole server process
 * (fatal `check(fUnicode)` → STATUS_ILLEGAL_INSTRUCTION), which no
 * try/catch can contain. macOS/Linux Skia binaries embed their ICU data
 * (the @napi-rs/canvas platform packages ship no icudtl.dat there), so
 * the check is Windows-only. */
export function createUnpdfRenderer(options?: {
  /**
   * Override for tests (defaults to `findCanvasIcuDataFile`). The search
   * itself must stay load-free — resolving a path never executes the
   * native binding, while importing the platform package would
   * initialize Skia and abort the process when the file is missing.
   */
  findIcuDataFile?: () => string | undefined;
}): PdfRenderer {
  // Windows Skia loads `icudtl.dat` from the library/executable
  // directory at startup and aborts when it is missing; the other
  // platforms compile the data into the binding and skip the guard.
  const needsIcuDataFile = Deno.build.os === "windows";
  const findIcuDataFile = options?.findIcuDataFile ?? findCanvasIcuDataFile;
  return {
    async render(
      pdfPath: string,
      pages: number[],
      dpi: number,
      signal?: AbortSignal,
    ): Promise<PdfRenderResult> {
      const bytes = await Deno.readFile(pdfPath);
      if (bytes.length > MAX_PDF_BYTES) {
        throw new Error(
          `PDF is too large to render (${bytes.length} bytes; max ${MAX_PDF_BYTES})`,
        );
      }
      let canvasImport: () => Promise<typeof import("@napi-rs/canvas")>;
      try {
        // Resolve once per call (not at module load): a host without a
        // matching native binding fails here with a clear error instead
        // of crashing the process at startup.
        canvasImport = () => import("@napi-rs/canvas");
        await canvasImport();
      } catch (error) {
        throw new Error(
          `Cannot render PDF pages (the canvas library failed to load: ${
            errorMessage(error)
          }); the host needs @napi-rs/canvas support (FFI)`,
        );
      }
      if (needsIcuDataFile && findIcuDataFile() === undefined) {
        throw new Error(
          "Cannot render PDF pages (Skia's ICU data file icudtl.dat was " +
            "not found next to the canvas native library or the server " +
            "binary; reinstall Lumisca to restore the server/icudtl.dat " +
            "resource)",
        );
      }
      const scale = dpi / 72;
      const pdf: DocumentProxy = await abortable(
        getDocumentProxy(bytes),
        signal,
      );
      try {
        const totalPages = pdf.numPages;
        const bad = pages.filter((p) => p < 1 || p > totalPages);
        if (bad.length > 0) {
          throw new Error(
            `Page ${
              bad.join(",")
            } out of range: the PDF has ${totalPages} page(s)`,
          );
        }
        const rendered: RenderedPdfPage[] = [];
        for (const page of pages) {
          const viewport = (await abortable(pdf.getPage(page), signal))
            .getViewport({ scale });
          const buffer = await abortable(
            renderPageAsImage(pdf, page, { scale, canvasImport }),
            signal,
          );
          rendered.push({
            page,
            png: new Uint8Array(buffer),
            width: Math.floor(viewport.width),
            height: Math.floor(viewport.height),
          });
        }
        return { totalPages, pages: rendered };
      } finally {
        await pdf.cleanup();
      }
    },
  };
}

/** Platform suffixes of the `@napi-rs/canvas-<platform>` npm packages
 * (the optionalDependencies of @napi-rs/canvas plus the extra branches of
 * its js-binding loader). Probed with require.resolve only — resolving a
 * path never executes the native binding. */
const CANVAS_PLATFORM_SUFFIXES: readonly string[] = [
  "win32-x64-msvc",
  "win32-x64-gnu",
  "win32-ia32-msvc",
  "win32-arm64-msvc",
  "darwin-x64",
  "darwin-arm64",
  "darwin-universal",
  "linux-x64-gnu",
  "linux-x64-musl",
  "linux-arm64-gnu",
  "linux-arm64-musl",
  "linux-arm-gnueabihf",
  "linux-riscv64-gnu",
  "android-arm64",
  "android-arm-eabi",
  "freebsd-x64",
  "freebsd-arm64",
];

/**
 * Locate Skia's ICU data file (`icudtl.dat`) without loading Skia itself.
 * Windows-only: Windows Skia binaries load the data file (see
 * createUnpdfRenderer), while macOS/Linux binaries embed it. The lookup
 * must stay load-free: merely importing the platform package would
 * initialize Skia and abort the process when the file is missing —
 * exactly what this guard exists to prevent.
 *
 * Order: (1) explicit `LUMISCA_ICU_DATA` override, (2) the `server/`
 * resource directory shipped by the desktop installer (next to the
 * deno-compiled binary), (3) next to an already-loaded canvas native
 * binding, (4) next to any installed `@napi-rs/canvas-<platform>`
 * package, resolved without loading it.
 */
export function findCanvasIcuDataFile(): string | undefined {
  const override = (() => {
    try {
      return Deno.env.get("LUMISCA_ICU_DATA")?.trim() || undefined;
    } catch {
      return undefined;
    }
  })();
  if (override) {
    try {
      if (Deno.statSync(override).isFile) return override;
    } catch {
      // A stale override must not crash the process; fall through to the
      // normal search, which refuses cleanly when nothing is found.
    }
  }
  for (const dir of canvasIcuSearchDirs()) {
    const candidate = join(dir, "icudtl.dat");
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch {
      // Not here; try the next directory.
    }
  }
  return undefined;
}

function canvasIcuSearchDirs(): string[] {
  const dirs: string[] = [];
  // The deno-compiled server ships icudtl.dat next to its own binary
  // (the `server/icudtl.dat` Tauri resource).
  try {
    dirs.push(dirname(Deno.execPath()));
  } catch {
    // execPath unavailable; the searches below may still match.
  }
  try {
    const bindingRequire = createRequire(
      import.meta.resolve("@napi-rs/canvas/js-binding.js"),
    );
    // Next to an already-loaded native binding (require.cache exposes
    // the `.node` path once @napi-rs/canvas was imported earlier).
    const cache = (bindingRequire as unknown as {
      cache?: Record<string, unknown>;
    }).cache;
    if (cache) {
      for (const path of Object.keys(cache)) {
        if (path.endsWith(".node")) dirs.push(dirname(path));
      }
    }
    // Next to any installed platform package. require.resolve only
    // resolves the path — it never executes the native binding, so this
    // stays safe even when the data file is missing.
    for (const suffix of CANVAS_PLATFORM_SUFFIXES) {
      try {
        dirs.push(
          dirname(
            bindingRequire.resolve(`@napi-rs/canvas-${suffix}/package.json`),
          ),
        );
      } catch {
        // That platform's package is not installed; keep looking.
      }
    }
  } catch {
    // node resolution unavailable; fall through with what we have.
  }
  return [...new Set(dirs)];
}

const pdfReadPagesSchema = object({
  path: string("Workspace path to the PDF file (e.g. `Docs/report.pdf`)"),
  pages: array(
    integer("A 1-based page number"),
    "1-based page numbers to render as images, e.g. [1, 2, 3]. " +
      `At most ${MAX_PDF_PAGES_PER_CALL} pages per call; duplicates are rendered once.`,
  ),
  dpi: optional(integer(
    `Render resolution in DPI (${MIN_PDF_DPI}-${MAX_PDF_DPI}, default ${DEFAULT_PDF_DPI}). ` +
      "Higher values give sharper images at a larger context cost.",
  )),
});

export interface PdfToolOptions {
  sandbox: Sandbox;
  /** Renderer override (tests inject a fake; omitted → unpdf). */
  renderer?: PdfRenderer;
}

/** Build the PDF page-as-image tool over a workspace sandbox. */
export function createPdfTools(options: PdfToolOptions): Tool[] {
  return [createPdfReadPagesTool(options)];
}

function createPdfReadPagesTool(
  options: PdfToolOptions,
): Tool<typeof pdfReadPagesSchema> {
  const renderer = options.renderer ?? createUnpdfRenderer();
  return {
    name: TOOL_PDF_READ_PAGES,
    label: "PDF Read Pages",
    description:
      "Render pages of a PDF file as PNG images (the model sees the " +
      "pixels). Use for scanned PDFs, page layout, figures, tables, or " +
      "any page where text extraction loses information. Takes a " +
      "workspace PDF path and 1-based page numbers, and returns one " +
      "image per page plus the total page count.",
    parameters: pdfReadPagesSchema,
    execute: async (_id, params, signal) => {
      const dpi = params.dpi ?? DEFAULT_PDF_DPI;
      if (!Number.isInteger(dpi) || dpi < MIN_PDF_DPI || dpi > MAX_PDF_DPI) {
        throw new Error(
          `dpi must be an integer ${MIN_PDF_DPI}-${MAX_PDF_DPI} (got ${params.dpi})`,
        );
      }
      if (params.pages.length === 0) {
        throw new Error("pages must not be empty (e.g. [1])");
      }
      // De-duplicate, keeping the requested order; validate 1-based.
      const pages: number[] = [];
      for (const page of params.pages) {
        if (!Number.isInteger(page) || page < 1) {
          throw new Error(`pages must be 1-based page numbers (got ${page})`);
        }
        if (!pages.includes(page)) pages.push(page);
      }
      if (pages.length > MAX_PDF_PAGES_PER_CALL) {
        throw new Error(
          `At most ${MAX_PDF_PAGES_PER_CALL} pages per call (got ${pages.length}); ` +
            "call again for the remaining pages",
        );
      }
      const filePath = await requireResolved(options.sandbox, params.path);
      const stat = await Deno.stat(filePath);
      if (stat.isDirectory) throw new Error(`Is a directory: ${params.path}`);

      const { totalPages, pages: rendered } = await renderer.render(
        filePath,
        pages,
        dpi,
        signal,
      );
      const base = filePath.split(/[\\/]/).pop() ?? filePath;
      const lines = [
        `[pdf: ${params.path} — pages ${
          pages.join(", ")
        } of ${totalPages} at ${dpi}dpi]`,
      ];
      const content: Array<
        { type: "text"; text: string } | {
          type: "image";
          data: string;
          mimeType: string;
        }
      > = [];
      for (const page of rendered) {
        lines.push(
          `[image: ${base} p.${page.page} (${page.png.length} bytes, ${page.width}x${page.height})]`,
        );
        content.push({
          type: "image",
          data: bytesToBase64(page.png),
          mimeType: "image/png",
        });
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }, ...content],
        details: {
          path: filePath,
          pages,
          totalPages,
          dpi,
        },
      };
    },
  };
}
