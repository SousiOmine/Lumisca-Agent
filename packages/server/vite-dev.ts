import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import type { InitialData } from "@lumisca/web/types";
import { coreSharedPath } from "./paths.ts";

/** Port of Vite's own HMR websocket in middleware mode (Vite serves it on
 * its own http server, independent of the Lumisca port; the page CSP must
 * allow connecting to it). Pinned so the CSP and reality cannot drift. */
export const VITE_HMR_PORT = 24678;

/** Narrow view of the Vite APIs used here. The full types live in vite's
 * own d.ts; keeping the surface small keeps deno check fast and isolates
 * the integration from API churn. */
interface ViteTransformResult {
  code: string;
  etag?: string;
}

interface ViteEnvironment {
  transformRequest(url: string): Promise<ViteTransformResult | null>;
}

interface ViteServerHandle {
  environments: {
    ssr: ViteEnvironment;
    client: ViteEnvironment;
  };
  transformIndexHtml(url: string, html: string): Promise<string>;
  close(): Promise<void>;
}

interface ViteModuleRunner {
  import(url: string): Promise<unknown>;
}

export interface ViteModuleResponse {
  code: string;
  etag?: string;
  type: "js" | "css";
}

/** Dev-mode Vite integration: SSR via the module runner (source changes are
 * reflected in the next render without a rebuild), client modules served
 * through transformRequest, and HMR over Vite's own websocket. */
export interface ViteDev {
  /** Server-render the app shell with the current sources. */
  renderAppMarkup(data: InitialData): Promise<string>;
  /** Apply Vite's HTML transforms (injects the HMR client + fast refresh
   * preamble). */
  transformIndexHtml(url: string, html: string): Promise<string>;
  /** Transform and return a client module for the given request URL, or
   * null when the URL is not a module Vite knows. */
  serveModule(req: Request): Promise<Response | null>;
  close(): Promise<void>;
}

// URL predicates and preprocessing mirroring Vite's own middleware
// (transformMiddleware) so virtual modules (html proxies, /@id/ ids with
// null bytes) resolve exactly the same way.
const JS_EXT_RE = /\.(?:m?[jt]sx?|vue|svelte|astro|mdx|mts|cts)(\?.*)?$/;
const CSS_EXT_RE = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss)(\?.*)?$/;
const IMPORT_QUERY_RE = /(\?|&)import=?(?:&|$)/;
const NULL_BYTE_PLACEHOLDER = "__x00__";
const VALID_ID_PREFIX = "/@id/";
const timestampRE = /\bt=\d{13}&?\b/;
const trailingSeparatorRE = /[?&]$/;
const directRequestRE = /[?&]direct\b/;

function removeTimestampQuery(url: string): string {
  return url.replace(timestampRE, "").replace(trailingSeparatorRE, "");
}

function removeImportQuery(url: string): string {
  return url.replace(IMPORT_QUERY_RE, "$1").replace(trailingSeparatorRE, "");
}

function unwrapId(id: string): string {
  return id.startsWith(VALID_ID_PREFIX)
    ? id.slice(VALID_ID_PREFIX.length).replace(NULL_BYTE_PLACEHOLDER, "\0")
    : id;
}

function isDirectCSSRequest(request: string): boolean {
  return CSS_EXT_RE.test(request) && directRequestRE.test(request);
}

function isModuleRequest(url: URL, secFetchDest: string | null): boolean {
  const { pathname, search } = url;
  // /assets/* is owned by the Hono app (initial-data.js embeds the token).
  if (pathname.startsWith("/assets/")) return false;
  if (
    pathname.startsWith("/@vite/") || pathname.startsWith("/@id/") ||
    pathname.startsWith("/@fs/") || pathname === "/@react-refresh" ||
    pathname.startsWith("/node_modules/.vite/deps/")
  ) {
    return true;
  }
  if (secFetchDest === "script") return true;
  return JS_EXT_RE.test(pathname) || CSS_EXT_RE.test(pathname) ||
    IMPORT_QUERY_RE.test(search);
}

/**
 * Start an in-process Vite dev server (middleware mode, config in code).
 * Vite's connect middleware is Node-specific, so client modules are served
 * by the Hono app through `serveModule` below instead; the HMR websocket is
 * Vite's own (port {@link VITE_HMR_PORT}).
 */
export async function createViteDevServer(repoRoot: string): Promise<ViteDev> {
  const { createServer, createServerModuleRunner } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const webRoot = join(repoRoot, "packages", "web");

  const server = await createServer({
    configFile: false,
    logLevel: "info",
    root: webRoot,
    appType: "custom",
    server: {
      middlewareMode: true,
      ws: { port: VITE_HMR_PORT },
    },
    // Dep optimization cache: keep it inside the repo instead of letting
    // Vite fall back to the user's home directory on Deno.
    cacheDir: join(repoRoot, ".lumisca-cache", "vite"),
    // Vite does not read deno.json workspace exports; alias the one
    // workspace import used by the web package (same target as esbuild).
    resolve: {
      alias: { "@lumisca/core/shared": coreSharedPath(repoRoot) },
    },
    plugins: [react()],
  }) as unknown as ViteServerHandle;

  // Module runner for SSR. This is the HMR-capable replacement for the
  // deprecated server.ssrLoadModule: on a source change Vite invalidates
  // the module graph, the runner drops its cache, and the next import()
  // re-evaluates the fresh code.
  const createRunner = createServerModuleRunner as unknown as (
    environment: unknown,
    options: { root: string },
  ) => ViteModuleRunner;
  const runner = createRunner(server.environments.ssr, { root: webRoot });

  async function renderAppMarkup(data: InitialData): Promise<string> {
    const mod = await runner.import("/src/App.tsx") as {
      App: (props: { initialData: InitialData }) => ReactElement;
    };
    const stream = await renderToReadableStream(
      createElement(mod.App, { initialData: data }),
    );
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let html = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    return html;
  }

  function transformIndexHtml(
    url: string,
    html: string,
  ): Promise<string> {
    return server.transformIndexHtml(url, html);
  }

  /** Serve a client module request, or null when Vite does not own the URL
   * (the caller then falls through to the regular routes). */
  async function serveModule(req: Request): Promise<Response | null> {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api") || url.pathname === "/ws") {
      return null;
    }
    if (!isModuleRequest(url, req.headers.get("sec-fetch-dest"))) {
      return null;
    }
    // Same preprocessing as Vite's transformMiddleware: strip the HMR
    // timestamp query, decode null-byte placeholders and /@id/ prefixes.
    let requestUrl = decodeURI(
      removeTimestampQuery(url.pathname + url.search),
    ).replace(NULL_BYTE_PLACEHOLDER, "\0");
    requestUrl = removeImportQuery(requestUrl);
    requestUrl = unwrapId(requestUrl);
    // Link-tag stylesheets (Accept: text/css) want the raw CSS; Vite's
    // middleware adds ?direct in that case so CSS HMR still applies.
    if (
      CSS_EXT_RE.test(requestUrl) && !directRequestRE.test(requestUrl) &&
      (req.headers.get("accept") ?? "").includes("text/css")
    ) {
      requestUrl += (requestUrl.includes("?") ? "&" : "?") + "direct";
    }
    let result: ViteTransformResult | null;
    try {
      result = await server.environments.client.transformRequest(requestUrl);
    } catch (error) {
      // Unresolvable (e.g. /styles.css in dev): not a Vite module, let the
      // regular routes answer. Real transform errors (syntax, …) throw a
      // plain Error and surface as a 500 in the caller.
      if (
        error instanceof Error &&
        /failed to (?:load|resolve)/i.test(error.message)
      ) {
        return null;
      }
      throw error;
    }
    if (result === null) return null;
    const type: "js" | "css" = isDirectCSSRequest(requestUrl) ? "css" : "js";
    const headers = new Headers();
    headers.set(
      "content-type",
      type === "css"
        ? "text/css; charset=utf-8"
        : "application/javascript; charset=utf-8",
    );
    headers.set(
      "cache-control",
      requestUrl.includes(".vite/deps")
        ? "max-age=31536000,immutable"
        : "no-cache",
    );
    if (result.etag) headers.set("etag", result.etag);
    return new Response(result.code, { headers });
  }

  return {
    renderAppMarkup,
    transformIndexHtml,
    serveModule,
    close: () => server.close(),
  };
}
