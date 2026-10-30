import { assert, assertEquals, assertRejects } from "@std/assert";
import { createWebSearchTools } from "./web.ts";
import { TOOL_WEB_FETCH, TOOL_WEB_SEARCH } from "../shared/tool-names.ts";
import type {
  FetchRequest,
  FetchResponse,
  SearchProvider,
  SearchRequest,
  SearchResponse,
} from "../websearch/types.ts";
import { WebSearchError } from "../websearch/errors.ts";

/** A provider that answers from the test. */
function fakeProvider(
  answer: {
    search?: (request: SearchRequest) => Promise<SearchResponse>;
    fetchPage?: (request: FetchRequest) => Promise<FetchResponse>;
  } = {},
): SearchProvider {
  return {
    id: "exa",
    name: "Exa",
    supportsFetch: true,
    search: answer.search ??
      (() => Promise.resolve({ results: [] })),
    fetchPage: answer.fetchPage ??
      (() => Promise.resolve({ url: "", title: null, text: "" })),
  };
}

/** The text of a tool result. */
function textOf(
  result: { content: { type: string; text?: string }[] },
): string {
  return result.content.map((block) => block.text ?? "").join("");
}

Deno.test("the pair is built with the names the UI and the prompt use", () => {
  const tools = createWebSearchTools(fakeProvider());
  assertEquals(tools.map((tool) => tool.name), [
    TOOL_WEB_SEARCH,
    TOOL_WEB_FETCH,
  ]);
});

Deno.test("web_search lists the hits with urls and excerpts", async () => {
  const asked: SearchRequest[] = [];
  const tools = createWebSearchTools(fakeProvider({
    search: (request) => {
      asked.push(request);
      return Promise.resolve({
        results: [
          {
            title: "First",
            url: "https://example.com/1",
            snippet: "line one\nline two",
            publishedAt: "2024-01-02",
          },
          {
            title: "Second",
            url: "https://example.com/2",
            snippet: "",
            publishedAt: null,
          },
        ],
      });
    },
  }));

  const result = await tools[0]!.execute("id", { query: "deno" });
  assertEquals(asked[0]?.query, "deno");
  // The default limit is applied when the model does not give one.
  assertEquals(asked[0]?.limit, 5);

  const text = textOf(result);
  assert(text.includes('2 result(s) from Exa for "deno"'));
  assert(text.includes("1. First"));
  assert(text.includes("   https://example.com/1"));
  assert(text.includes("   2024-01-02"));
  // A multi-line excerpt is indented to the listing's column.
  assert(text.includes("   line one\n   line two"));
  assert(text.includes("2. Second"));
  // The result always ends with the untrusted-input reminder.
  assert(text.includes("untrusted input"));
});

Deno.test("web_search reports an empty result set plainly", async () => {
  const tools = createWebSearchTools(fakeProvider());
  const result = await tools[0]!.execute("id", { query: "nothing at all" });
  assertEquals(textOf(result), 'No results for "nothing at all" from Exa.');
});

Deno.test("web_search passes the caller's abort along", async () => {
  let seen: AbortSignal | undefined;
  const tools = createWebSearchTools(fakeProvider({
    search: (request) => {
      seen = request.signal;
      return Promise.resolve({ results: [] });
    },
  }));

  const controller = new AbortController();
  await tools[0]!.execute("id", { query: "q" }, controller.signal);
  assertEquals(seen, controller.signal);
});

Deno.test("web_fetch returns the title, the url and the text", async () => {
  const tools = createWebSearchTools(fakeProvider({
    fetchPage: () =>
      Promise.resolve({
        url: "https://example.com/final",
        title: "The page",
        text: "Body",
      }),
  }));

  const result = await tools[1]!.execute("id", { url: "https://example.com/" });
  assertEquals(textOf(result), "The page\nhttps://example.com/final\n\nBody");
});

Deno.test("web_fetch says so when the page had no readable text", async () => {
  const tools = createWebSearchTools(fakeProvider({
    fetchPage: () =>
      Promise.resolve({ url: "https://example.com/", title: null, text: "" }),
  }));
  const result = await tools[1]!.execute("id", { url: "https://example.com/" });
  assert(textOf(result).includes("(the page had no readable text)"));
});

Deno.test("a provider failure reaches the model as advice, not a stack trace", async () => {
  const tools = createWebSearchTools(fakeProvider({
    search: () =>
      Promise.reject(
        new WebSearchError("auth", "Exa returned HTTP 401", { status: 401 }),
      ),
  }));

  const error = await assertRejects(
    () => tools[0]!.execute("id", { query: "q" }),
    Error,
  );
  assert(error.message.includes("API key was rejected"));
  assert(error.message.includes("Settings"));
});

Deno.test("an unexpected failure is still reported as a web-search failure", async () => {
  const tools = createWebSearchTools(fakeProvider({
    search: () => Promise.reject(new TypeError("offline")),
  }));
  const error = await assertRejects(
    () => tools[0]!.execute("id", { query: "q" }),
    Error,
  );
  assert(error.message.startsWith("Web search failed:"));
});
