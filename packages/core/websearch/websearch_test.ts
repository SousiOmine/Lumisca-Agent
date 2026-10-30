import { assert, assertEquals, assertRejects } from "@std/assert";
import { decodeEntities, htmlToText, pageTitle } from "./html.ts";
import { WebSearchError } from "./errors.ts";
import { failureText } from "./failure-text.ts";
import { fetchDirect } from "./direct-fetch.ts";
import { createSearchProvider } from "./providers/registry.ts";
import { MAX_DIRECT_FETCH_BYTES } from "./constants.ts";
import type { FetchLike } from "./types.ts";

/** A Response with the given body and headers. */
function html(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

Deno.test("htmlToText drops markup and keeps block boundaries", () => {
  const text = htmlToText(
    "<html><head><title>T</title><style>p{}</style></head>" +
      "<body><h1>Head</h1><p>One &amp; two</p><script>alert(1)</script>" +
      "<div>Three<br>Four</div></body></html>",
  );
  assertEquals(text, "Head\nOne & two\nThree\nFour");
});

Deno.test("pageTitle reads and decodes the title, null when absent", () => {
  assertEquals(pageTitle("<title> A &amp; B </title>"), "A & B");
  assertEquals(pageTitle("<html><body>no title</body></html>"), null);
  assertEquals(pageTitle("<title>   </title>"), null);
});

Deno.test("decodeEntities keeps unknown entities as written", () => {
  assertEquals(decodeEntities("&amp;&#65;&#x42;&bogus;"), "&AB&bogus;");
});

Deno.test("the direct fetch converts HTML and follows redirects", async () => {
  const seen: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    seen.push(url);
    if (seen.length === 1) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "/final" },
        }),
      );
    }
    return Promise.resolve(html("<title>Final</title><p>Body text</p>"));
  };

  const page = await fetchDirect(fetchImpl, {
    url: "https://example.com/start",
  });
  assertEquals(seen, [
    "https://example.com/start",
    "https://example.com/final",
  ]);
  assertEquals(page.url, "https://example.com/final");
  assertEquals(page.title, "Final");
  assertEquals(page.text, "Body text");
});

Deno.test("the direct fetch refuses this machine's addresses", async () => {
  const fetchImpl: FetchLike = () => {
    throw new Error("must not be called");
  };

  for (
    const url of [
      "http://localhost:8000/api/settings",
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[64:ff9b::7f00:1]/",
    ]
  ) {
    const error = await assertRejects(
      () => fetchDirect(fetchImpl, { url }),
      WebSearchError,
    );
    assertEquals(error.code, "invalid", url);
  }
});

Deno.test("the direct fetch allows public addresses", async () => {
  const fetchImpl: FetchLike = () => Promise.resolve(html("<p>ok</p>"));
  // A public IPv6 and a dotted IPv4 outside every private range.
  for (const url of ["https://[2606:4700::1111]/", "https://8.8.8.8/"]) {
    const page = await fetchDirect(fetchImpl, { url });
    assertEquals(page.text, "ok");
  }
});

Deno.test("the direct fetch refuses non-http schemes and PDFs", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(
      new Response("%PDF", {
        headers: { "content-type": "application/pdf" },
      }),
    );

  const scheme = await assertRejects(
    () => fetchDirect(fetchImpl, { url: "file:///etc/passwd" }),
    WebSearchError,
  );
  assertEquals(scheme.code, "invalid");

  const pdf = await assertRejects(
    () => fetchDirect(fetchImpl, { url: "https://example.com/a.pdf" }),
    WebSearchError,
  );
  assertEquals(pdf.code, "unsupported");
});

Deno.test("the direct fetch stops at the size limit while reading", async () => {
  // A body that keeps producing chunks: the reader must stop counting at the
  // limit instead of buffering everything.
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += chunk.byteLength;
      controller.enqueue(chunk);
      if (sent > MAX_DIRECT_FETCH_BYTES * 2) controller.close();
    },
  });
  const fetchImpl: FetchLike = () =>
    Promise.resolve(
      new Response(stream, {
        headers: { "content-type": "text/plain" },
      }),
    );

  const error = await assertRejects(
    () => fetchDirect(fetchImpl, { url: "https://example.com/big" }),
    WebSearchError,
  );
  assertEquals(error.code, "unavailable");
  // Several chunks may already be in flight; what matters is that reading
  // stopped near the limit instead of running to the end of the stream.
  assert(
    sent <= MAX_DIRECT_FETCH_BYTES + 64 * chunk.byteLength,
    `read ${sent} bytes`,
  );
});

Deno.test("failureText speaks each reader's language", () => {
  const message = "Tavily returned HTTP 401";
  assert(
    failureText("ja", "auth", message).includes("API キー"),
  );
  assert(failureText("en", "auth", message).includes("API key"));
});

Deno.test("a provider without a page API falls back to the direct fetch", async () => {
  // Brave searches only; its fetchPage goes through the direct fetch.
  const fetchImpl: FetchLike = (url) => {
    if (url.startsWith("https://api.search.brave.com/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            web: {
              results: [{
                title: "Hit",
                url: "https://example.com/hit",
                description: "<b>excerpt</b>",
              }],
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(html("<title>Page</title><p>Text</p>"));
  };

  const provider = createSearchProvider({
    id: "brave",
    apiKey: "k",
    fetch: fetchImpl,
  });
  assertEquals(provider.supportsFetch, false);

  const found = await provider.search({ query: "q", limit: 3 });
  assertEquals(found.results, [{
    title: "Hit",
    url: "https://example.com/hit",
    snippet: "excerpt",
    publishedAt: null,
  }]);

  const page = await provider.fetchPage({ url: "https://example.com/page" });
  assertEquals(page.title, "Page");
  assertEquals(page.text, "Text");
});

Deno.test("a provider with a page API uses it instead of the direct fetch", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    calls.push(url);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          results: [{ url: "https://example.com/", title: "T", text: "Body" }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  };

  const provider = createSearchProvider({
    id: "exa",
    apiKey: "k",
    fetch: fetchImpl,
  });
  const page = await provider.fetchPage({ url: "https://example.com/" });
  assertEquals(calls, ["https://api.exa.ai/contents"]);
  assertEquals(page.text, "Body");
});

Deno.test("a fetched page is cut to maxChars and says how much was left out", async () => {
  // Tavily's extract answers with `raw_content`, the first result's body.
  const fetchImpl: FetchLike = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          results: [{ url: "u", title: "T", raw_content: "x".repeat(5_000) }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

  const provider = createSearchProvider({
    id: "tavily",
    apiKey: "k",
    fetch: fetchImpl,
  });
  const page = await provider.fetchPage({
    url: "https://example.com/",
    maxChars: 2_000,
  });
  assert(page.text.startsWith("x".repeat(2_000)));
  assert(page.text.includes("[3000 characters omitted]"));
});

Deno.test("an HTTP error becomes a typed failure", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { message: "bad key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

  const provider = createSearchProvider({
    id: "perplexity",
    apiKey: "k",
    fetch: fetchImpl,
  });
  const error = await assertRejects(
    () => provider.search({ query: "q", limit: 1 }),
    WebSearchError,
  );
  assertEquals(error.code, "auth");
  assertEquals(error.status, 401);
  assertEquals(error.message, "Perplexity returned HTTP 401: bad key");
});
